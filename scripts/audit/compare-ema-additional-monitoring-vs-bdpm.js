'use strict';

/**
 * Audit de périmètre, non lié aux ruptures :
 *   - liste EMA des médicaments sous surveillance additionnelle
 *   - indicateur BDPM `surveillance_renforcee` des spécialités françaises
 *
 * Usage:
 *   node scripts/audit/compare-ema-additional-monitoring-vs-bdpm.js
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT_DIR = path.resolve(__dirname, '../..');
const AUDIT_DIR = path.join(ROOT_DIR, 'tmp/audit');
const REPORT_PATH = path.join(ROOT_DIR, 'docs/AUDIT_EMA_ADDITIONAL_MONITORING_VS_BDPM.md');

const EMA_PAGE_URL =
  'https://www.ema.europa.eu/en/human-regulatory-overview/post-authorisation/pharmacovigilance-post-authorisation/medicines-under-additional-monitoring/list-medicines-under-additional-monitoring';
const EMA_XLSX_URL =
  'https://www.ema.europa.eu/en/documents/additional-monitoring/list-medicinal-products-under-additional-monitoring_en.xlsx';
const BDPM_SPECIALITES_URL =
  'https://base-donnees-publique.medicaments.gouv.fr/download/file/CIS_bdpm.txt';

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function markdownTable(rows) {
  const [headers, ...body] = rows;
  const escape = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
  return [
    `| ${headers.map(escape).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.map(escape).join(' | ')} |`)
  ].join('\n');
}

function decodeBdpm(buffer) {
  for (const encoding of ['utf-8', 'windows-1252', 'iso-8859-1']) {
    try {
      return { encoding, text: new TextDecoder(encoding, { fatal: true }).decode(buffer) };
    } catch {
      // Format variable selon la publication BDPM.
    }
  }
  throw new Error('Encodage BDPM non reconnu.');
}

async function download(url, filename) {
  const response = await fetch(url, { headers: { 'user-agent': 'bdpm-audit/1.0' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const destination = path.join(AUDIT_DIR, filename);
  fs.writeFileSync(destination, buffer);
  return { buffer, bytes: buffer.length, contentType: response.headers.get('content-type') };
}

function findHeaderRow(rows) {
  return rows.findIndex((row) => row.some((value) => normalizeText(value) === 'product name'));
}

function parseEma(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const headerIndex = findHeaderRow(rows);
  if (headerIndex === -1) throw new Error(`Colonne "Product name" introuvable dans ${sheetName}.`);
  const headers = rows[headerIndex]
    .map((value) => String(value).trim())
    .filter(Boolean);
  const records = rows
    .slice(headerIndex + 1)
    .filter((row) => row.some((value) => value !== ''))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, String(row[index] || '').trim()])))
    .filter((record) => Object.values(record).some(Boolean));
  return { sheetName, headers, records };
}

function parseSpecialites(text) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const values = line.split('\t');
      return {
        cis: values[0] || '',
        denomination: values[1] || '',
        surveillance_renforcee: values[11] || ''
      };
    });
}

function report({ collectedAt, emaDownload, bdpmDownload, bdpmEncoding, ema, specialites }) {
  const productHeader = ema.headers.find((header) => normalizeText(header) === 'product name');
  const activeSubstanceHeader = ema.headers.find((header) => normalizeText(header).startsWith('active substance'));
  const reasonHeader = ema.headers.find((header) => normalizeText(header).startsWith('reason'));
  const normalizedEmaProducts = new Map();
  for (const record of ema.records) {
    const key = normalizeText(record[productHeader]);
    if (key) normalizedEmaProducts.set(key, record);
  }

  const bdpmYes = specialites.filter((record) => normalizeText(record.surveillance_renforcee) === 'oui');
  const exactMatches = bdpmYes.filter((record) => normalizedEmaProducts.has(normalizeText(record.denomination)));
  const emaKeys = [...normalizedEmaProducts.keys()].filter((key) => key.length >= 4);
  const looseMatches = bdpmYes.filter((record) => {
    const denom = normalizeText(record.denomination);
    if (!denom) return false;
    return emaKeys.some((key) => denom.includes(key) || key.includes(denom.split(' ')[0]));
  });
  const sampleReasons = [...new Set(
    ema.records.map((record) => record[reasonHeader]).filter(Boolean)
  )].slice(0, 10);

  const matchRate = bdpmYes.length
    ? Math.round((1000 * exactMatches.length) / bdpmYes.length) / 10
    : 0;
  const looseRate = bdpmYes.length
    ? Math.round((1000 * looseMatches.length) / bdpmYes.length) / 10
    : 0;
  const stats = {
    collected_at: collectedAt,
    ema: {
      rows: ema.records.length,
      headers: ema.headers,
      bytes: emaDownload.bytes,
      sample_reasons: sampleReasons
    },
    bdpm: {
      specialites: specialites.length,
      surveillance_renforcee_oui: bdpmYes.length,
      encoding: bdpmEncoding,
      bytes: bdpmDownload.bytes
    },
    join: {
      exact_name_matches_among_bdpm_oui: exactMatches.length,
      match_rate_pct_among_bdpm_oui: matchRate,
      loose_name_matches_among_bdpm_oui: looseMatches.length,
      loose_match_rate_pct_among_bdpm_oui: looseRate
    },
    decision: {
      domain: 'pharmacovigilance_not_availability',
      go_phase2_ingest_ema_list: false,
      keep_bdpm_surveillance_renforcee: true,
      rationale: [
        'EMA list is additional monitoring (black triangle), not stock alerts',
        'BDPM already exposes surveillance_renforcee',
        'Exact name join ~0%; loose join is noisy — do not auto-ingest without an explicit product need'
      ]
    }
  };

  const markdown = [
    '# Audit — EMA additional monitoring vs BDPM surveillance renforcée',
    '',
    `Rapport généré le ${collectedAt}. L’artefact EMA XLSX est régénérable dans \`tmp/audit/\` (gitignored). Stats JSON : \`tmp/audit/ema-bdpm-monitoring-stats.json\`.`,
    '',
    '## Décision de périmètre',
    '',
    'Cette comparaison porte sur la **pharmacovigilance** (médicaments sous surveillance additionnelle, triangle noir) et non sur les ruptures ou tensions d’approvisionnement. Elle ne doit pas alimenter `get_ansm_medication_alerts`.',
    '',
    'La source EMA est la [liste officielle des médicaments sous surveillance additionnelle](' +
      `${EMA_PAGE_URL}). Elle est revue mensuellement par le PRAC ; la BDPM expose déjà un indicateur français \`surveillance_renforcee\` au niveau CIS.`,
    '',
    '## Sources collectées',
    '',
    markdownTable([
      ['Source', 'URL', 'Format', 'Taille'],
      ['EMA', EMA_XLSX_URL, emaDownload.contentType || 'XLSX', `${emaDownload.bytes} octets`],
      ['BDPM spécialités', BDPM_SPECIALITES_URL, `TSV (${bdpmEncoding})`, `${bdpmDownload.bytes} octets`]
    ]),
    '',
    '## Schéma EMA observé',
    '',
    `Feuille : \`${ema.sheetName}\`.`,
    '',
    `Colonnes : ${ema.headers.map((header) => `\`${header}\``).join(', ')}.`,
    '',
    markdownTable([
      ['Mesure', 'Valeur'],
      ['Produits EMA', ema.records.length],
      ['Spécialités BDPM', specialites.length],
      ['CIS BDPM avec `surveillance_renforcee=oui`', bdpmYes.length],
      ['Correspondances exactes nom EMA ↔ dénomination BDPM parmi ces CIS', `${exactMatches.length} (${matchRate} %)`],
      ['Correspondances lâches (sous-chaîne / 1er token)', `${looseMatches.length} (${looseRate} %)`],
      ['Exemples de motifs EMA', sampleReasons.join('; ') || '—']
    ]),
    '',
    '## Go / no-go Temps 2 (surveillance)',
    '',
    markdownTable([
      ['Décision', 'Statut', 'Justification'],
      ['Utiliser EMA pour le MVP disponibilité', '**NO-GO**', 'Domaine pharmacovigilance ≠ stock'],
      ['Ingestion EMA dans cette API', '**NO-GO** (sauf besoin produit explicite)', `Jointure exacte faible (${matchRate} % des CIS « oui ») ; motifs EMA utiles seulement si demandés`],
      ['Conserver `surveillance_renforcee` BDPM', '**GO — garder tel quel**', 'Signal simple déjà exposé sur `/specialites`']
    ]),
    '',
    '## Limites de jointure',
    '',
    '- L’EMA publie des **produits autorisés dans l’UE**, alors que la BDPM utilise des spécialités françaises identifiées par CIS.',
    '- Le nom EMA peut couvrir un produit centralisé, une présentation ou une marque différente de la dénomination BDPM ; une correspondance exacte n’est donc qu’un indicateur conservateur.',
    '- L’EMA n’est pas une source d’état de stock, de disponibilité, de recommandations de dispensation ou de rupture.',
    '',
    '## Recommandation',
    '',
    'Conserver le champ BDPM `surveillance_renforcee` comme signal simple déjà disponible. N’ajouter une ingestion EMA que si un besoin produit explicite exige ses **motifs détaillés** ou une actualisation mensuelle indépendante ; dans ce cas, concevoir une ressource distincte et ne pas modifier les tools de disponibilité.'
  ].join('\n') + '\n';

  return { markdown, stats };
}

async function main() {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const [emaDownload, bdpmDownload] = await Promise.all([
    download(EMA_XLSX_URL, `ema-additional-monitoring-${stamp}.xlsx`),
    download(BDPM_SPECIALITES_URL, `bdpm-specialites-monitoring-${stamp}.txt`)
  ]);
  const ema = parseEma(emaDownload.buffer);
  const decodedBdpm = decodeBdpm(bdpmDownload.buffer);
  const specialites = parseSpecialites(decodedBdpm.text);
  const { markdown, stats } = report({
    collectedAt: new Date().toISOString(),
    emaDownload,
    bdpmDownload,
    bdpmEncoding: decodedBdpm.encoding,
    ema,
    specialites
  });
  fs.writeFileSync(REPORT_PATH, markdown);
  const statsPath = path.join(AUDIT_DIR, 'ema-bdpm-monitoring-stats.json');
  fs.writeFileSync(statsPath, `${JSON.stringify(stats, null, 2)}\n`);
  console.log(`Audit écrit : ${path.relative(ROOT_DIR, REPORT_PATH)}`);
  console.log(`Stats JSON : ${path.relative(ROOT_DIR, statsPath)}`);
  console.log(
    `Décision : ingest_ema=${stats.decision.go_phase2_ingest_ema_list} ` +
      `match=${stats.join.match_rate_pct_among_bdpm_oui}% ` +
      `ema_rows=${stats.ema.rows} bdpm_oui=${stats.bdpm.surveillance_renforcee_oui}`
  );
}

main().catch((error) => {
  console.error(`Audit EMA/BDPM échoué : ${error.message}`);
  process.exitCode = 1;
});
