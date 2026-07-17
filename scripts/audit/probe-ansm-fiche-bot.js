'use strict';

/**
 * Audit one-shot : un robot HTTP peut-il récupérer et extraire le narratif
 * utile des fiches détail ANSM pointées par `lien_ansm` BDPM ?
 *
 * Artefacts : tmp/audit/ansm-fiches/ (gitignored)
 * Rapport : docs/AUDIT_ANSM_FICHE_BOT.md
 *
 * Usage:
 *   node scripts/audit/probe-ansm-fiche-bot.js
 *   npm run audit:ansm-fiches
 */

const fs = require('fs');
const path = require('path');
const { normalizeAnsmUrl } = require('../../src/utils/ansmUrl');

const ROOT_DIR = path.resolve(__dirname, '../..');
const AUDIT_DIR = path.join(ROOT_DIR, 'tmp/audit/ansm-fiches');
const REPORT_PATH = path.join(ROOT_DIR, 'docs/AUDIT_ANSM_FICHE_BOT.md');
const BDPM_DISPO_PATH = path.join(ROOT_DIR, 'data/CIS_CIP_Dispo_Spec.txt');
const BDPM_DISPO_URL =
  'https://base-donnees-publique.medicaments.gouv.fr/download/file/CIS_CIP_Dispo_Spec.txt';

const USER_AGENT = 'fr.gouv.medicaments.rest-audit/1.5 (+fiche-bot-probe)';
const SAMPLE_TARGET = 40;
const SAMPLE_PER_STATUS = Object.freeze({
  1: 10,
  2: 14,
  3: 8,
  4: 8
});

const KEYWORDS = Object.freeze([
  'rupture',
  'tension',
  'contingentement',
  'contingent',
  'alternative',
  'pharmacien',
  'hôpital',
  'hopital',
  'ville',
  'remise',
  'disponib'
]);

function nowIso() {
  return new Date().toISOString();
}

function decodeBdpm(buffer) {
  for (const encoding of ['utf-8', 'windows-1252', 'iso-8859-1']) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(buffer);
    } catch {
      // Essayer l'encodage suivant.
    }
  }
  throw new Error('Impossible de décoder CIS_CIP_Dispo_Spec.txt');
}

async function loadBdpmDispo() {
  let buffer;
  if (fs.existsSync(BDPM_DISPO_PATH)) {
    buffer = fs.readFileSync(BDPM_DISPO_PATH);
  } else {
    const response = await fetch(BDPM_DISPO_URL, {
      headers: { 'user-agent': USER_AGENT }
    });
    if (!response.ok) {
      throw new Error(`BDPM dispo HTTP ${response.status}`);
    }
    buffer = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync(path.dirname(BDPM_DISPO_PATH), { recursive: true });
    fs.writeFileSync(BDPM_DISPO_PATH, buffer);
  }
  const text = decodeBdpm(buffer);
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [
      cis,
      cip13,
      code_statut,
      libelle_statut,
      date_debut,
      date_mise_a_jour,
      date_remise_dispo,
      lien_ansm
    ] = line.split('\t');
    const url = normalizeAnsmUrl(lien_ansm);
    if (!url || !url.includes('ansm.sante.fr')) continue;
    rows.push({
      cis,
      cip13: cip13 || '',
      code_statut: String(code_statut || '').trim(),
      libelle_statut: libelle_statut || '',
      date_debut: date_debut || '',
      date_mise_a_jour: date_mise_a_jour || '',
      date_remise_dispo: date_remise_dispo || '',
      lien_ansm: url
    });
  }
  return rows;
}

/**
 * Une URL unique par fiche ANSM ; conserve le premier CIS vu + codes statut observés.
 */
function uniqueByUrl(rows) {
  const map = new Map();
  for (const row of rows) {
    const existing = map.get(row.lien_ansm);
    if (!existing) {
      map.set(row.lien_ansm, {
        ...row,
        codes_statut: new Set([row.code_statut]),
        cis_count: 1
      });
    } else {
      existing.codes_statut.add(row.code_statut);
      existing.cis_count += 1;
    }
  }
  return [...map.values()].map((entry) => ({
    ...entry,
    codes_statut: [...entry.codes_statut].sort()
  }));
}

function sampleUrls(uniqueRows) {
  const byStatus = { 1: [], 2: [], 3: [], 4: [] };
  for (const row of uniqueRows) {
    const primary = row.codes_statut[0] || row.code_statut;
    if (byStatus[primary]) byStatus[primary].push(row);
  }
  const picked = [];
  const seen = new Set();
  for (const [code, quota] of Object.entries(SAMPLE_PER_STATUS)) {
    const pool = byStatus[code] || [];
    // Répartir : début / milieu / fin du pool pour diversifier.
    const step = Math.max(1, Math.floor(pool.length / Math.max(quota, 1)));
    for (let i = 0; i < pool.length && picked.length < SAMPLE_TARGET; i += step) {
      const row = pool[i];
      if (seen.has(row.lien_ansm)) continue;
      seen.add(row.lien_ansm);
      picked.push(row);
      if ([...picked.filter((p) => (p.codes_statut[0] || p.code_statut) === code)].length >= quota) {
        break;
      }
    }
  }
  // Compléter jusqu'à SAMPLE_TARGET si besoin.
  for (const row of uniqueRows) {
    if (picked.length >= SAMPLE_TARGET) break;
    if (seen.has(row.lien_ansm)) continue;
    seen.add(row.lien_ansm);
    picked.push(row);
  }
  return picked;
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/&lsquo;/gi, "'")
    .replace(/&agrave;/gi, 'à')
    .replace(/&acirc;/gi, 'â')
    .replace(/&eacute;/gi, 'é')
    .replace(/&egrave;/gi, 'è')
    .replace(/&ecirc;/gi, 'ê')
    .replace(/&ocirc;/gi, 'ô')
    .replace(/&ucirc;/gi, 'û')
    .replace(/&ccedil;/gi, 'ç')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  );
}

function extractBetween(html, startRe, endRe) {
  const start = html.search(startRe);
  if (start < 0) return '';
  const rest = html.slice(start);
  const endMatch = rest.search(endRe);
  const chunk = endMatch > 0 ? rest.slice(0, endMatch) : rest.slice(0, 4000);
  return stripTags(chunk);
}

function detectBotSignals(html, headers) {
  const lower = html.toLowerCase();
  return {
    cf_ray: headers.get('cf-ray') || null,
    server: headers.get('server') || null,
    via: headers.get('via') || null,
    has_captcha: /captcha|recaptcha|hcaptcha/.test(lower),
    has_challenge: /just a moment|attention required|cf-browser-verification|challenge-platform/.test(
      lower
    ),
    spa_root_empty: /<div[^>]+id=["']root["'][^>]*>\s*<\/div>/i.test(html),
    has_next_data: /__NEXT_DATA__/.test(html),
    has_page_header_title: /page-header-title/.test(html),
    has_products_block: /products-block/.test(html)
  };
}

function extractFiche(html) {
  const titleMatch = html.match(/<h1[^>]*class="[^"]*page-header-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : '';

  const statusMatch = html.match(
    /<div[^>]*class="[^"]*tags[^"]*"[^>]*>[\s\S]*?<span[^>]*class="[^"]*label[^"]*"[^>]*>([\s\S]*?)<\/span>/i
  );
  const status = statusMatch ? stripTags(statusMatch[1]) : '';

  const publishedMatch = html.match(/PUBLI[ÉE]\s+LE\s+(\d{2}\/\d{2}\/\d{4})/i);
  const published = publishedMatch ? publishedMatch[1] : '';

  const sinceMatch = html.match(
    /<span[^>]*class="[^"]*period[^"]*"[^>]*>[\s\S]*?au[\s\S]*?(\d{2}\/\d{2}\/\d{4})/i
  );
  const since = sinceMatch ? sinceMatch[1] : '';

  const panels = [];
  const panelRe =
    /<div[^>]*class="[^"]*panel-heading[^"]*"[^>]*>([\s\S]*?)<\/div>[\s\S]*?<div[^>]*class="[^"]*panel-body[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*panel(?:\s|")|<footer|$)/gi;
  let panelMatch;
  while ((panelMatch = panelRe.exec(html)) !== null) {
    const heading = stripTags(panelMatch[1]);
    const body = stripTags(panelMatch[2]).slice(0, 1500);
    if (heading || body) {
      panels.push({ heading, body_preview: body, body_chars: body.length });
    }
  }

  const observations = panels.find((p) => /observation/i.test(p.heading));
  const infoLabo = panels.find((p) => /information|laboratoire|lettre/i.test(p.heading));
  const remise = panels.find((p) => /remise|disposition/i.test(p.heading + p.body_preview));

  const plain = stripTags(html).toLowerCase();
  const keywordHits = {};
  for (const kw of KEYWORDS) {
    keywordHits[kw] = plain.includes(kw.toLowerCase());
  }

  const dci = extractBetween(
    html,
    /<h3[^>]*class="[^"]*title[^"]*"[^>]*>\s*DCI/i,
    /<h3[^>]*class="[^"]*title[^"]*"|<div[^>]*class="[^"]*panel/i
  ).slice(0, 300);
  const indications = extractBetween(
    html,
    /<h3[^>]*class="[^"]*title[^"]*"[^>]*>\s*Indications/i,
    /<h3[^>]*class="[^"]*title[^"]*"|<div[^>]*class="[^"]*panel/i
  ).slice(0, 500);
  const laboratoire = extractBetween(
    html,
    /<h3[^>]*class="[^"]*title[^"]*"[^>]*>\s*Laboratoire/i,
    /<h3[^>]*class="[^"]*title[^"]*"|<div[^>]*class="[^"]*panel/i
  ).slice(0, 300);

  const fields = {
    title: title ? 'found' : 'missing',
    status: status ? 'found' : 'missing',
    published: published ? 'found' : 'missing',
    since: since ? 'found' : 'missing',
    observations: observations ? 'found' : 'missing',
    dci: dci ? 'found' : 'missing',
    indications: indications ? 'found' : 'missing',
    laboratoire: laboratoire ? 'found' : 'missing',
    narrative_panels: panels.length > 0 ? 'found' : 'missing'
  };

  const foundCount = Object.values(fields).filter((v) => v === 'found').length;
  const usefulNarrative =
    Boolean(observations) ||
    keywordHits.contingentement ||
    keywordHits.contingent ||
    keywordHits.alternative ||
    keywordHits.pharmacien ||
    keywordHits.hôpital ||
    keywordHits.hopital ||
    keywordHits.ville;

  return {
    title,
    status,
    published,
    since,
    dci,
    indications,
    laboratoire,
    panels,
    fields,
    fields_found: foundCount,
    fields_total: Object.keys(fields).length,
    keyword_hits: keywordHits,
    useful_narrative: usefulNarrative,
    extractability:
      foundCount >= 5 && Boolean(title && status)
        ? usefulNarrative
          ? 'good'
          : 'partial'
        : foundCount >= 3
          ? 'partial'
          : 'poor'
  };
}

function slugFromUrl(url) {
  try {
    const pathname = new URL(url).pathname.replace(/\/+$/, '');
    const leaf = pathname.split('/').filter(Boolean).pop() || 'fiche';
    return leaf.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80);
  } catch {
    return 'fiche';
  }
}

async function probeOne(row, index) {
  const started = Date.now();
  const result = {
    index,
    url: row.lien_ansm,
    cis_sample: row.cis,
    codes_statut: row.codes_statut,
    libelle_statut_bdpm: row.libelle_statut,
    cis_count_sharing_url: row.cis_count
  };

  let response;
  try {
    response = await fetch(row.lien_ansm, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow'
    });
  } catch (error) {
    return {
      ...result,
      ok: false,
      error: error.message,
      elapsed_ms: Date.now() - started
    };
  }

  const html = await response.text();
  const headers = response.headers;
  const signals = detectBotSignals(html, headers);
  const extraction = response.ok ? extractFiche(html) : null;

  const htmlPath = path.join(AUDIT_DIR, 'html', `${String(index).padStart(2, '0')}-${slugFromUrl(row.lien_ansm)}.html`);
  fs.writeFileSync(htmlPath, html);

  return {
    ...result,
    ok: response.ok,
    status: response.status,
    final_url: response.url,
    redirected: response.url.replace(/\/+$/, '') !== row.lien_ansm.replace(/\/+$/, ''),
    content_type: headers.get('content-type'),
    bytes: Buffer.byteLength(html, 'utf8'),
    elapsed_ms: Date.now() - started,
    cache_control: headers.get('cache-control'),
    signals,
    extraction,
    html_file: path.relative(ROOT_DIR, htmlPath)
  };
}

function summarize(probes) {
  const ok = probes.filter((p) => p.ok);
  const extractability = { good: 0, partial: 0, poor: 0, none: 0 };
  let usefulNarrative = 0;
  const fieldStats = {};
  for (const p of probes) {
    if (!p.extraction) {
      extractability.none += 1;
      continue;
    }
    extractability[p.extraction.extractability] =
      (extractability[p.extraction.extractability] || 0) + 1;
    if (p.extraction.useful_narrative) usefulNarrative += 1;
    for (const [field, state] of Object.entries(p.extraction.fields)) {
      if (!fieldStats[field]) fieldStats[field] = { found: 0, missing: 0 };
      fieldStats[field][state] += 1;
    }
  }

  const botBlocked = probes.filter(
    (p) => p.signals && (p.signals.has_captcha || p.signals.has_challenge)
  ).length;
  const spaEmpty = probes.filter((p) => p.signals && p.signals.spa_root_empty).length;
  const ssrUseful = probes.filter(
    (p) => p.signals && p.signals.has_page_header_title && p.signals.has_products_block
  ).length;

  let verdict = 'NO-GO';
  let verdictReason = '';
  const httpOkPct = probes.length ? ok.length / probes.length : 0;
  const goodPctOfOk = ok.length ? extractability.good / ok.length : 0;
  const narrativePctOfOk = ok.length ? usefulNarrative / ok.length : 0;

  if (botBlocked > 0 || (probes.length > 0 && spaEmpty === probes.length)) {
    verdict = 'NO-GO';
    verdictReason =
      botBlocked > 0
        ? 'Challenge / captcha détecté sur au moins une fiche'
        : 'HTML sans contenu métier (SPA vide) sur tout l’échantillon';
  } else if (httpOkPct >= 0.9 && goodPctOfOk >= 0.85 && narrativePctOfOk >= 0.7) {
    verdict = 'GO';
    verdictReason =
      'HTML SSR accessible sans challenge ; titre/statut/panels extractibles de façon stable ; narratif métier présent' +
      (ok.length < probes.length
        ? ` (${probes.length - ok.length} URL BDPM sans fiche HTTP OK — lien potentiellement périmé)`
        : '');
  } else if (httpOkPct >= 0.8 && extractability.good + extractability.partial > 0) {
    verdict = 'PARTIEL';
    verdictReason =
      'Pages majoritairement accessibles mais extractibilité irrégulière ou narratif métier souvent mince';
  } else {
    verdict = 'NO-GO';
    verdictReason = 'Taux de succès HTTP ou d’extraction insuffisant';
  }

  return {
    sample_size: probes.length,
    http_ok: ok.length,
    http_ok_pct: probes.length ? Math.round((1000 * ok.length) / probes.length) / 10 : 0,
    bot_blocked: botBlocked,
    spa_empty: spaEmpty,
    ssr_useful_markers: ssrUseful,
    extractability,
    useful_narrative_count: usefulNarrative,
    field_stats: fieldStats,
    verdict,
    verdict_reason: verdictReason,
    avg_bytes: ok.length
      ? Math.round(ok.reduce((sum, p) => sum + (p.bytes || 0), 0) / ok.length)
      : 0,
    avg_elapsed_ms: probes.length
      ? Math.round(probes.reduce((sum, p) => sum + (p.elapsed_ms || 0), 0) / probes.length)
      : 0
  };
}

function mdEscape(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function makeReport({ collectedAt, uniqueUrlCount, sample, probes, summary }) {
  const lines = [];
  lines.push('# Audit — robot vs fiches détail ANSM');
  lines.push('');
  lines.push(
    `Rapport généré le ${collectedAt}. Artefacts sous \`tmp/audit/ansm-fiches/\` (gitignored). Stats JSON : \`tmp/audit/ansm-fiches/stats.json\`.`
  );
  lines.push('');
  lines.push('## Objectif');
  lines.push('');
  lines.push(
    'Vérifier si un robot HTTP peut **récupérer** et **extraire** le narratif utile (statut, observations, reco / contingentement / alternatives) des fiches ANSM pointées par `lien_ansm` BDPM — sans mesurer le rate-limit.'
  );
  lines.push('');
  lines.push('## Méthode');
  lines.push('');
  lines.push('| Élément | Valeur |');
  lines.push('| --- | --- |');
  lines.push(`| Source URLs | \`CIS_CIP_Dispo_Spec\` → \`lien_ansm\` normalisé |`);
  lines.push(`| URLs uniques dans le corpus | ${uniqueUrlCount} |`);
  lines.push(`| Échantillon sondé | ${sample.length} |`);
  lines.push(`| User-Agent | \`${USER_AGENT}\` |`);
  lines.push('| Runtime | \`fetch\` Node one-shot (pas de headless) |');
  lines.push('| Parseur | heuristiques HTML (regex) — pas de Playwright |');
  lines.push('');
  lines.push('### Répartition de l’échantillon (code_statut primaire)');
  lines.push('');
  lines.push('| Code | Libellé typique | URLs sondées |');
  lines.push('| --- | --- | ---: |');
  for (const code of ['1', '2', '3', '4']) {
    const count = sample.filter((s) => (s.codes_statut[0] || s.code_statut) === code).length;
    const label =
      { 1: 'Rupture', 2: 'Tension', 3: 'Arrêt', 4: 'Remise' }[code] || code;
    lines.push(`| ${code} | ${label} | ${count} |`);
  }
  lines.push('');
  lines.push('## Résultat synthétique');
  lines.push('');
  lines.push('| Mesure | Valeur |');
  lines.push('| --- | --- |');
  lines.push(`| HTTP OK | ${summary.http_ok}/${summary.sample_size} (${summary.http_ok_pct} %) |`);
  lines.push(`| Challenge / captcha | ${summary.bot_blocked} |`);
  lines.push(`| SPA root vide | ${summary.spa_empty} |`);
  lines.push(
    `| Marqueurs SSR (\`page-header-title\` + \`products-block\`) | ${summary.ssr_useful_markers}/${summary.sample_size} |`
  );
  lines.push(`| Extractibilité good / partial / poor / none | ${summary.extractability.good} / ${summary.extractability.partial} / ${summary.extractability.poor} / ${summary.extractability.none} |`);
  lines.push(
    `| Fiches avec narratif métier utile | ${summary.useful_narrative_count}/${summary.sample_size} |`
  );
  lines.push(`| Taille HTML moyenne | ${summary.avg_bytes} octets |`);
  lines.push(`| Latence moyenne | ${summary.avg_elapsed_ms} ms |`);
  lines.push(`| **Verdict scrape fiche** | **${summary.verdict}** — ${summary.verdict_reason} |`);
  lines.push('');
  lines.push('## Complétude des champs extraits (échantillon HTTP OK)');
  lines.push('');
  lines.push('| Champ | Trouvé | Absent |');
  lines.push('| --- | ---: | ---: |');
  for (const [field, stats] of Object.entries(summary.field_stats)) {
    lines.push(`| \`${field}\` | ${stats.found} | ${stats.missing} |`);
  }
  lines.push('');
  lines.push('## Signaux techniques observés');
  lines.push('');
  const servers = new Map();
  const vias = new Map();
  for (const p of probes) {
    if (!p.signals) continue;
    const server = p.signals.server || '(absent)';
    const via = p.signals.via || '(absent)';
    servers.set(server, (servers.get(server) || 0) + 1);
    vias.set(via, (vias.get(via) || 0) + 1);
  }
  lines.push('- Pas de dépendance à un navigateur headless si les marqueurs SSR sont présents.');
  lines.push(
    `- \`Server\` : ${[...servers.entries()].map(([k, v]) => `\`${k}\`×${v}`).join(', ') || 'n/a'}`
  );
  lines.push(
    `- \`Via\` : ${[...vias.entries()].map(([k, v]) => `\`${k}\`×${v}`).join(', ') || 'n/a'}`
  );
  lines.push(
    '- Structure récurrente : `h1.page-header-title`, `div.tags span.label`, panels `panel-heading` / `panel-body` / `products-block wysiwyg-content`.'
  );
  lines.push('');
  lines.push('## Détail par URL (échantillon)');
  lines.push('');
  lines.push(
    '| # | CIS ex. | Statut BDPM | HTTP | Extract. | Narratif | Titre extrait |'
  );
  lines.push('| ---: | --- | --- | ---: | --- | --- | --- |');
  for (const p of probes) {
    lines.push(
      `| ${p.index} | ${mdEscape(p.cis_sample)} | ${mdEscape(p.libelle_statut_bdpm)} | ${p.status ?? 'ERR'} | ${p.extraction?.extractability ?? '—'} | ${p.extraction?.useful_narrative ? 'oui' : 'non'} | ${mdEscape((p.extraction?.title || '').slice(0, 80))} |`
    );
  }
  lines.push('');
  lines.push('## Implications produit');
  lines.push('');
  lines.push(
    '- Le MVP BDPM actuel (`/disponibilite`) reste la source structurée (CIS, CIP, dates, `detail_url`).'
  );
  lines.push(
    '- Un scrape fiche ANSM est **techniquement envisageable** seulement si le verdict est GO ou PARTIEL ; le narratif (hôpital / ville / contingentement / lettres labo) n’est **pas** dans BDPM.'
  );
  lines.push(
    '- Une même URL ANSM peut couvrir plusieurs CIS BDPM : toute ingestion future doit rester jointe par URL, pas fusionnée silencieusement.'
  );
  lines.push(
    '- Cet audit ne mesure pas robots.txt politique d’usage ni charge ; one-shot uniquement.'
  );
  lines.push('');
  lines.push('## Limites');
  lines.push('');
  lines.push('- Heuristiques regex : un redesign ANSM peut casser les sélecteurs sans casser le HTTP 200.');
  lines.push('- Échantillon ~40 URLs, pas exhaustif.');
  lines.push('- Pas de rendu JS : si demain le site devient SPA pure, le verdict basculera.');
  lines.push('');
  return lines.join('\n');
}

async function main() {
  fs.mkdirSync(path.join(AUDIT_DIR, 'html'), { recursive: true });
  const collectedAt = nowIso();
  console.log('Chargement CIS_CIP_Dispo_Spec…');
  const rows = await loadBdpmDispo();
  const unique = uniqueByUrl(rows);
  const sample = sampleUrls(unique);
  console.log(
    `Corpus : ${rows.length} lignes, ${unique.length} URLs uniques → échantillon ${sample.length}`
  );

  const probes = [];
  for (let i = 0; i < sample.length; i++) {
    const row = sample[i];
    process.stdout.write(`  [${i + 1}/${sample.length}] ${row.lien_ansm.slice(0, 90)}… `);
    const probe = await probeOne(row, i + 1);
    probes.push(probe);
    console.log(
      probe.ok
        ? `HTTP ${probe.status} ${probe.extraction?.extractability} (${probe.bytes} B)`
        : `FAIL ${probe.error || probe.status}`
    );
  }

  const summary = summarize(probes);
  const stats = {
    collected_at: collectedAt,
    user_agent: USER_AGENT,
    corpus_rows: rows.length,
    unique_urls: unique.length,
    sample_size: sample.length,
    summary,
    probes: probes.map((p) => ({
      ...p,
      // Ne pas re-sérialiser le HTML dans le JSON stats.
      extraction: p.extraction
        ? {
            ...p.extraction,
            panels: (p.extraction.panels || []).map((panel) => ({
              heading: panel.heading,
              body_chars: panel.body_chars,
              body_preview: panel.body_preview.slice(0, 280)
            }))
          }
        : null
    }))
  };

  const statsPath = path.join(AUDIT_DIR, 'stats.json');
  fs.writeFileSync(statsPath, `${JSON.stringify(stats, null, 2)}\n`);
  const markdown = makeReport({
    collectedAt,
    uniqueUrlCount: unique.length,
    sample,
    probes,
    summary
  });
  fs.writeFileSync(REPORT_PATH, `${markdown}\n`);

  console.log(`Rapport : ${path.relative(ROOT_DIR, REPORT_PATH)}`);
  console.log(`Stats   : ${path.relative(ROOT_DIR, statsPath)}`);
  console.log(`Verdict : ${summary.verdict} — ${summary.verdict_reason}`);
}

main().catch((error) => {
  console.error(`Audit fiches ANSM échoué : ${error.message}`);
  process.exitCode = 1;
});
