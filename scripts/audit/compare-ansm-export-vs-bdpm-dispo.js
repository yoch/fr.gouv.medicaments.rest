'use strict';

/**
 * Audit reproductible des deux sources publiques de disponibilités :
 *   - export Excel ANSM (table visible par les pharmaciens)
 *   - fichier TSV BDPM CIS_CIP_Dispo_Spec
 *
 * Les artefacts bruts sont écrits dans tmp/audit/ (gitignored). Le rapport
 * versionné est régénéré dans docs/AUDIT_ANSM_EXPORT_VS_BDPM_DISPO.md.
 *
 * Usage:
 *   node scripts/audit/compare-ansm-export-vs-bdpm-dispo.js
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { normalizeAnsmUrl } = require('../../src/utils/ansmUrl');

const ROOT_DIR = path.resolve(__dirname, '../..');
const AUDIT_DIR = path.join(ROOT_DIR, 'tmp/audit');
const REPORT_PATH = path.join(ROOT_DIR, 'docs/AUDIT_ANSM_EXPORT_VS_BDPM_DISPO.md');

const ANSM_EXPORT_URL =
  'https://ansm.sante.fr/disponibilites-des-produits-de-sante/medicaments/export';
const BDPM_DISPO_URL =
  'https://base-donnees-publique.medicaments.gouv.fr/download/file/CIS_CIP_Dispo_Spec.txt';
const BDPM_SPECIALITES_URL =
  'https://base-donnees-publique.medicaments.gouv.fr/download/file/CIS_bdpm.txt';

const STATUS_BY_CODE = Object.freeze({
  '1': 'Rupture de stock',
  '2': "Tension d'approvisionnement",
  '3': 'Arrêt de commercialisation',
  '4': 'Remise à disposition'
});

function nowIso() {
  return new Date().toISOString();
}

function assertResponse(response, source) {
  if (!response.ok) {
    throw new Error(`${source}: HTTP ${response.status} ${response.statusText}`);
  }
}

async function download(url, filename) {
  const response = await fetch(url, { headers: { 'user-agent': 'bdpm-audit/1.0' } });
  assertResponse(response, url);
  const buffer = Buffer.from(await response.arrayBuffer());
  const destination = path.join(AUDIT_DIR, filename);
  fs.writeFileSync(destination, buffer);
  return {
    destination,
    bytes: buffer.length,
    contentType: response.headers.get('content-type'),
    contentDisposition: response.headers.get('content-disposition'),
    buffer
  };
}

function decodeBdpm(buffer) {
  const candidates = ['utf-8', 'windows-1252', 'iso-8859-1'];
  for (const encoding of candidates) {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
      return { encoding, text };
    } catch {
      // Essayer l'encodage suivant : le fichier BDPM varie dans le temps.
    }
  }
  throw new Error('Impossible de décoder le fichier BDPM avec UTF-8, Windows-1252 ou ISO-8859-1.');
}

function parseTsv(text, fields) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.map((line, index) => {
    const values = line.split('\t');
    const record = { source_line: index + 1, source_columns: values.length };
    for (let i = 0; i < fields.length; i++) {
      record[fields[i]] = values[i] || '';
    }
    return record;
  });
}

function parseFlexibleDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) {
    const [day, month, year] = raw.split('/').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const date = new Date(`${raw.slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function formatDate(date) {
  return date ? date.toISOString().slice(0, 10) : null;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\[[^\]]*]/g, '')
    .replace(/[–—-]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function dateMaximum(records, field, parser) {
  return records
    .map((record) => parser(record[field]))
    .filter(Boolean)
    .sort((a, b) => b - a)[0] || null;
}

function countBy(records, key) {
  return Object.fromEntries(
    [...records.reduce((counts, record) => {
      const value = record[key] || '(vide)';
      counts.set(value, (counts.get(value) || 0) + 1);
      return counts;
    }, new Map()).entries()].sort(([a], [b]) => a.localeCompare(b, 'fr'))
  );
}

function markdownTable(rows) {
  if (rows.length === 0) return '_Aucune donnée._';
  const [headers, ...body] = rows;
  const escape = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
  return [
    `| ${headers.map(escape).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.map(escape).join(' | ')} |`)
  ].join('\n');
}

/**
 * Schéma réel de l’export Excel ANSM (distinct du tableau HTML de la page) :
 * Titre | Date de création | Date de mise à jour | Date de début de situation |
 * Date de remise à disposition | Statut | Produit(s) de santé |
 * Domaine(s) médical(aux) | URL de la page
 */
function findHeaderRow(sheetRows) {
  return sheetRows.findIndex((row) => {
    const values = row.map((value) => normalizeText(value));
    return values.includes('statut') && (
      values.includes('titre') ||
      values.some((value) => value.startsWith('domaine'))
    );
  });
}

function headerIndexLookup(headerIndexes, candidates) {
  for (const candidate of candidates) {
    if (headerIndexes.has(candidate)) return headerIndexes.get(candidate);
  }
  return undefined;
}

function parseAnsmExport(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  const headerIndex = findHeaderRow(rows);
  if (headerIndex === -1) {
    throw new Error(`En-têtes ANSM introuvables dans la feuille "${sheetName}".`);
  }

  const headers = rows[headerIndex].map((value) => String(value).trim()).filter(Boolean);
  const headerIndexes = new Map(headers.map((value, index) => [normalizeText(value), index]));

  const idxTitre = headerIndexLookup(headerIndexes, ['titre', 'specialite']);
  const idxStatut = headerIndexLookup(headerIndexes, ['statut']);
  const idxMaj = headerIndexLookup(headerIndexes, ['date de mise a jour', 'mise a jour']);
  const idxDebut = headerIndexLookup(headerIndexes, ['date de debut de situation', 'date de debut']);
  const idxCreation = headerIndexLookup(headerIndexes, ['date de creation']);
  const idxRemise = headerIndexLookup(headerIndexes, [
    'date de remise a disposition',
    'remise a disposition'
  ]);
  const idxDomaines = headerIndexLookup(headerIndexes, [
    'domaine s medical aux',
    'domaines medicaux',
    'domaine medical'
  ]);
  const idxProduit = headerIndexLookup(headerIndexes, ['produit s de sante', 'produits de sante']);
  const idxUrl = headerIndexLookup(headerIndexes, ['url de la page', 'url']);

  if (idxTitre === undefined || idxStatut === undefined || idxDomaines === undefined) {
    throw new Error(
      `Colonnes ANSM essentielles manquantes (titre/statut/domaine). Headers: ${headers.join(' | ')}`
    );
  }

  const records = [];
  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex++) {
    const values = rows[rowIndex] || [];
    if (values.every((value) => value === '' || value == null)) continue;
    const cellUrl = idxUrl !== undefined
      ? sheet[XLSX.utils.encode_cell({ r: rowIndex, c: idxUrl })]
      : null;
    const detailUrl = String(values[idxUrl] || cellUrl?.l?.Target || '').trim();
    records.push({
      source_row: rowIndex + 1,
      titre: String(values[idxTitre] || '').trim(),
      specialite: String(values[idxTitre] || '').trim(),
      statut: String(values[idxStatut] || '').trim(),
      date_creation: idxCreation !== undefined ? String(values[idxCreation] || '').trim() : '',
      mise_a_jour: idxMaj !== undefined ? String(values[idxMaj] || '').trim() : '',
      date_debut_situation: idxDebut !== undefined ? String(values[idxDebut] || '').trim() : '',
      remise_a_disposition: idxRemise !== undefined ? String(values[idxRemise] || '').trim() : '',
      produit_sante: idxProduit !== undefined ? String(values[idxProduit] || '').trim() : '',
      domaines_medicaux: String(values[idxDomaines] || '').trim(),
      detail_url: detailUrl
    });
  }
  return { sheetName, headers, records };
}

function parseSpecialites(text) {
  return parseTsv(text, [
    'cis', 'denomination', 'forme_pharma', 'voies_admin', 'statut_amm',
    'type_amm', 'commercialisation', 'date_amm', 'statut_bdm',
    'num_autorisation_euro', 'titulaire', 'surveillance_renforcee'
  ]);
}

function makeReport({
  collectedAt,
  ansmDownload,
  bdpmDispoDownload,
  bdpmSpecialitesDownload,
  bdpmEncoding,
  ansm,
  dispo,
  specialites
}) {
  const specialiteByCis = new Map(specialites.map((record) => [record.cis, record]));
  const enrichedDispo = dispo.map((record) => ({
    ...record,
    denomination: specialiteByCis.get(record.cis)?.denomination || ''
  }));
  const ansmByUrl = new Map();
  for (const record of ansm.records) {
    const url = normalizeAnsmUrl(record.detail_url);
    if (url) ansmByUrl.set(url, record);
  }
  const bdpmByUrl = new Map();
  for (const record of enrichedDispo) {
    const url = normalizeAnsmUrl(record.lien_ansm);
    if (!bdpmByUrl.has(url)) bdpmByUrl.set(url, []);
    bdpmByUrl.get(url).push(record);
  }

  const matchedUrls = [...ansmByUrl.keys()].filter((url) => bdpmByUrl.has(url));
  const unmatchedAnsm = ansm.records.filter((record) => {
    const url = normalizeAnsmUrl(record.detail_url);
    return !url || !bdpmByUrl.has(url);
  });
  const unmatchedBdpm = [...bdpmByUrl.entries()]
    .filter(([url]) => !ansmByUrl.has(url))
    .flatMap(([, records]) => records);

  const ansmNames = new Set(ansm.records.map((record) => normalizeText(record.specialite)));
  const exactNameMatches = enrichedDispo.filter(
    (record) => record.denomination && ansmNames.has(normalizeText(record.denomination))
  );
  const duplicateBdpmRows = new Map();
  for (const record of enrichedDispo) {
    const key = [
      record.cis, record.cip13, record.code_statut, record.libelle_statut,
      record.date_debut, record.date_mise_a_jour, record.date_remise_dispo, record.lien_ansm
    ].join('\u0001');
    duplicateBdpmRows.set(key, (duplicateBdpmRows.get(key) || 0) + 1);
  }
  const duplicateGroups = [...duplicateBdpmRows.values()].filter((count) => count > 1);
  const malformedDispo = enrichedDispo.filter((record) => record.source_columns !== 8);
  const orphanCis = enrichedDispo.filter((record) => !record.denomination);
  const ansmMissingLink = ansm.records.filter((record) => !record.detail_url);
  const urlMultiplicity = [...bdpmByUrl.values()].map((records) => records.length).sort((a, b) => a - b);

  const statusConsistency = matchedUrls.reduce((summary, url) => {
    const ansmStatus = ansmByUrl.get(url).statut;
    const bdpmStatuses = new Set(bdpmByUrl.get(url).map((record) => record.libelle_statut));
    if (bdpmStatuses.has(ansmStatus)) summary.same += 1;
    else summary.different += 1;
    return summary;
  }, { same: 0, different: 0 });

  const ansmLatest = dateMaximum(ansm.records, 'mise_a_jour', parseFlexibleDate);
  const bdpmLatest = dateMaximum(enrichedDispo, 'date_mise_a_jour', parseFlexibleDate);
  const bdpmUnknownCodes = enrichedDispo.filter((record) => !STATUS_BY_CODE[record.code_statut]);

  const ansmWithDomain = ansm.records.filter((r) => r.domaines_medicaux).length;
  const ansmWithRemise = ansm.records.filter((r) => r.remise_a_disposition).length;
  const bdpmWithRemise = enrichedDispo.filter((r) => r.date_remise_dispo).length;
  const bdpmWithCip13 = enrichedDispo.filter((r) => r.cip13).length;
  const joinRate = ansmByUrl.size
    ? Math.round((1000 * matchedUrls.length) / ansmByUrl.size) / 10
    : 0;
  const ansmPrimaryViable =
    ansm.records.length > 0 &&
    ansmWithDomain > 0 &&
    ansmMissingLink.length < ansm.records.length;
  const stats = {
    collected_at: collectedAt,
    ansm: {
      rows: ansm.records.length,
      unique_urls: ansmByUrl.size,
      missing_detail_url: ansmMissingLink.length,
      with_domaines_medicaux: ansmWithDomain,
      with_remise: ansmWithRemise,
      latest_mise_a_jour: formatDate(ansmLatest),
      status_counts: countBy(ansm.records, 'statut'),
      encoding_note: ansmDownload.contentType,
      bytes: ansmDownload.bytes
    },
    bdpm: {
      rows: enrichedDispo.length,
      unique_urls: bdpmByUrl.size,
      encoding: bdpmEncoding,
      with_cip13: bdpmWithCip13,
      with_remise: bdpmWithRemise,
      orphan_cis: orphanCis.length,
      duplicate_exact_rows: duplicateGroups.reduce((sum, count) => sum + count, 0),
      latest_date_mise_a_jour: formatDate(bdpmLatest),
      status_counts: countBy(enrichedDispo, 'libelle_statut'),
      bytes: bdpmDispoDownload.bytes
    },
    join: {
      urls_matched: matchedUrls.length,
      join_rate_pct_ansm_urls: joinRate,
      unmatched_ansm_rows: unmatchedAnsm.length,
      unmatched_bdpm_rows: unmatchedBdpm.length,
      status_same: statusConsistency.same,
      status_different: statusConsistency.different,
      exact_name_fallback_matches: exactNameMatches.length,
      url_multiplicity_min_med_max: urlMultiplicity.length
        ? [urlMultiplicity[0], urlMultiplicity[Math.floor(urlMultiplicity.length / 2)], urlMultiplicity.at(-1)]
        : null
    },
    decision: {
      mvp_primary_source: ansmPrimaryViable ? 'ansm_export' : 'inconclusive',
      bdpm_role: 'complementary_enrichment',
      go_phase2_mvp_tools_outside_api: ansmPrimaryViable,
      go_phase2_api_dispo_filters: true,
      go_phase2_api_infos_importantes: false,
      rationale: [
        'MVP requires medical_domain → ANSM export only',
        'BDPM provides CIS/CIP13/lien_ansm for enrichment',
        'Do not implement get_ansm_* inside this API repository'
      ]
    }
  };

  const lines = [
    '# Audit — export ANSM vs BDPM disponibilité',
    '',
    `Rapport généré le ${collectedAt}. Les artefacts binaires et TSV sont régénérables sous \`tmp/audit/\` (gitignored). Stats JSON : \`tmp/audit/ansm-bdpm-dispo-stats.json\`.`,
    '',
    '## Sources collectées',
    '',
    markdownTable([
      ['Source', 'URL', 'Format observé', 'Taille', 'Remarque'],
      ['Export ANSM', ANSM_EXPORT_URL, ansmDownload.contentType || 'non renseigné', `${ansmDownload.bytes} octets`, `Feuille: ${ansm.sheetName}`],
      ['BDPM disponibilités', BDPM_DISPO_URL, `TSV (${bdpmEncoding})`, `${bdpmDispoDownload.bytes} octets`, '8 colonnes attendues'],
      ['BDPM spécialités (jointure CIS)', BDPM_SPECIALITES_URL, 'TSV', `${bdpmSpecialitesDownload.bytes} octets`, 'Utilisé uniquement pour rapprocher les dénominations']
    ]),
    '',
    ansmDownload.contentDisposition
      ? `Content-Disposition ANSM : \`${ansmDownload.contentDisposition}\`.\n`
      : '',
    '## Résultat synthétique',
    '',
    markdownTable([
      ['Mesure', 'Export ANSM', 'BDPM', 'Interprétation'],
      ['Lignes', ansm.records.length, enrichedDispo.length, 'Grains potentiellement différents'],
      ['Dernière date de mise à jour', formatDate(ansmLatest), formatDate(bdpmLatest), 'Comparer avec la date de collecte, pas seulement entre elles'],
      ['URLs de détail uniques', ansmByUrl.size, bdpmByUrl.size, 'Clé de jointure prioritaire'],
      ['URLs jointes exactement', matchedUrls.length, `${matchedUrls.length}/${ansmByUrl.size} côté ANSM (${joinRate} %)`, 'Jointure par URL normalisée'],
      ['Lignes ANSM sans lien exporté', ansmMissingLink.length, '—', 'À vérifier : l’export peut ne pas préserver les hyperliens'],
      ['Lignes avec domaines médicaux', ansmWithDomain, '0 (champ absent)', 'Bloquant pour MVP si on n’utilise que BDPM'],
      ['Lignes avec remise renseignée', ansmWithRemise, bdpmWithRemise, 'Présence du champ, formats potentiellement différents'],
      ['CIP13 renseignés', '—', bdpmWithCip13, 'Exclusif BDPM'],
      ['Lignes BDPM sans dénomination locale', '—', orphanCis.length, 'CIS non trouvé dans le fichier spécialités frais'],
      ['Doublons exacts BDPM', '—', duplicateGroups.reduce((sum, count) => sum + count, 0), `${duplicateGroups.length} groupe(s)`],
      ['Statuts identiques parmi les URLs jointes', statusConsistency.same, statusConsistency.different, 'Même libellé exact vs au moins une divergence']
    ]),
    '',
    '### Répartition des statuts',
    '',
    markdownTable([
      ['Statut', 'ANSM', 'BDPM'],
      ...[...new Set([
        ...Object.keys(countBy(ansm.records, 'statut')),
        ...Object.keys(countBy(enrichedDispo, 'libelle_statut'))
      ])].sort((a, b) => a.localeCompare(b, 'fr')).map((status) => [
        status,
        countBy(ansm.records, 'statut')[status] || 0,
        countBy(enrichedDispo, 'libelle_statut')[status] || 0
      ])
    ]),
    '',
    '## Schémas et complétude',
    '',
    markdownTable([
      ['Champ utile au MVP', 'Export ANSM', 'BDPM disponibilités', 'Conclusion'],
      ['Statut', 'Oui', 'Oui (`code_statut` + `libelle_statut`)', 'Comparable'],
      ['Mise à jour', 'Oui (YYYY-MM-DD dans l’export)', 'Oui (JJ/MM/AAAA)', 'Formats hétérogènes entre sources'],
      ['Titre / spécialité affichée', 'Oui (`Titre`)', 'Indirect via CIS → fichier spécialités', 'Pas le même grain / libellé'],
      ['Date de création', 'Oui', 'Non', 'Exclusif ANSM export'],
      ['Date de début de situation', 'Oui', 'Oui (`date_debut`, sémantique BDPM impure pré-06/10/2023)', 'Comparable avec prudence'],
      ['Remise à disposition', 'Oui', 'Oui (`date_remise_dispo`)', 'ANSM export en YYYY-MM-DD ; BDPM en DD/MM/YYYY'],
      ['Domaines médicaux', 'Oui', 'Non', 'Champ exclusif ANSM'],
      ['URL de la page', 'Oui (colonne dédiée)', 'Oui (`lien_ansm`)', 'Clé de jointure prioritaire'],
      ['CIS', 'Non', 'Oui', 'Champ exclusif BDPM'],
      ['CIP13', 'Non', 'Oui, optionnel', 'Champ exclusif BDPM']
    ]),
    '',
    '## Qualité et jointure',
    '',
    markdownTable([
      ['Mesure', 'Valeur'],
      ['URLs ANSM sans équivalent BDPM', unmatchedAnsm.length],
      ['Lignes BDPM sans URL ANSM équivalente', unmatchedBdpm.length],
      ['Correspondances exactes de dénomination normalisée (fallback)', exactNameMatches.length],
      ['Cardinalité URL BDPM min / médiane / max', urlMultiplicity.length ? `${urlMultiplicity[0]} / ${urlMultiplicity[Math.floor(urlMultiplicity.length / 2)]} / ${urlMultiplicity.at(-1)}` : '—'],
      ['Lignes BDPM au nombre de colonnes inattendu', malformedDispo.length],
      ['Codes statut BDPM hors 1–4', bdpmUnknownCodes.length]
    ]),
    '',
    '## Go / no-go Temps 2 (disponibilité)',
    '',
    markdownTable([
      ['Décision', 'Statut', 'Justification'],
      ['Source primaire MVP `get_ansm_medication_alerts`', ansmPrimaryViable ? '**GO — export ANSM**' : '**NO-GO / inconclusif**', ansmPrimaryViable ? `Domaines médicaux présents (${ansmWithDomain}/${ansm.records.length}), export téléchargeable` : 'Export inutilisable ou sans domaines'],
      ['Implémenter les tools MVP dans ce dépôt API', '**NO-GO**', 'Hors périmètre : cache journalier + collecte ANSM = service consommateur'],
      ['Rôle BDPM `/disponibilite`', '**GO — enrichissement**', 'CIS/CIP13/lien ; filtres exacts utiles pour poller / jointure'],
      ['Réactivation infos importantes BDPM', '**NO-GO MVP**', 'Hors contrat disponibilité ; évolution séparée'],
      ['Fusion silencieuse ANSM ⊕ BDPM', '**NO-GO**', `1 URL BDPM → jusqu’à ${urlMultiplicity.at(-1) || '?'} CIS ; grains incompatibles`]
    ]),
    '',
    '## Décision recommandée pour le MVP disponibilité',
    '',
    ansmPrimaryViable
      ? '**L’export ANSM est la source primaire du MVP disponibilité.** Le fichier BDPM est complémentaire (CIS, CIP13, lien structuré). Ne pas fusionner silencieusement : une même URL peut concerner plusieurs CIS.'
      : '**L’export ANSM n’est pas encore validé comme source primaire** (voir métriques). Rejouer l’audit après correction éventuelle du parseur / de l’export.',
    '',
    '## Limites de cet audit',
    '',
    '- Un export est une photo à un instant donné ; il ne mesure pas le délai de publication sans série temporelle.',
    '- L’appariement de secours par dénomination est volontairement strict ; les appellations ANSM de familles peuvent couvrir plusieurs spécialités BDPM.',
    '- Les détails cliniques (contingentement, alternatives, recommandations) ne sont pas évalués ici : ils nécessitent un audit distinct des fiches ANSM.'
  ];
  return { markdown: `${lines.join('\n')}\n`, stats };
}

async function main() {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const [ansmDownload, bdpmDispoDownload, bdpmSpecialitesDownload] = await Promise.all([
    download(ANSM_EXPORT_URL, `ansm-disponibilites-${stamp}.xls`),
    download(BDPM_DISPO_URL, `bdpm-disponibilites-${stamp}.txt`),
    download(BDPM_SPECIALITES_URL, `bdpm-specialites-${stamp}.txt`)
  ]);

  const bdpmDispo = decodeBdpm(bdpmDispoDownload.buffer);
  const bdpmSpecialites = decodeBdpm(bdpmSpecialitesDownload.buffer);
  const ansm = parseAnsmExport(ansmDownload.buffer);
  const dispo = parseTsv(bdpmDispo.text, [
    'cis', 'cip13', 'code_statut', 'libelle_statut', 'date_debut',
    'date_mise_a_jour', 'date_remise_dispo', 'lien_ansm'
  ]);
  const specialites = parseSpecialites(bdpmSpecialites.text);
  const { markdown, stats } = makeReport({
    collectedAt: nowIso(),
    ansmDownload,
    bdpmDispoDownload,
    bdpmSpecialitesDownload,
    bdpmEncoding: bdpmDispo.encoding,
    ansm,
    dispo,
    specialites
  });
  fs.writeFileSync(REPORT_PATH, markdown);
  const statsPath = path.join(AUDIT_DIR, 'ansm-bdpm-dispo-stats.json');
  fs.writeFileSync(statsPath, `${JSON.stringify(stats, null, 2)}\n`);
  console.log(`Audit écrit : ${path.relative(ROOT_DIR, REPORT_PATH)}`);
  console.log(`Stats JSON : ${path.relative(ROOT_DIR, statsPath)}`);
  console.log(
    `Décision : primary=${stats.decision.mvp_primary_source} ` +
      `join=${stats.join.join_rate_pct_ansm_urls}% ` +
      `ansm_rows=${stats.ansm.rows} bdpm_rows=${stats.bdpm.rows}`
  );
}

main().catch((error) => {
  console.error(`Audit ANSM/BDPM échoué : ${error.message}`);
  process.exitCode = 1;
});
