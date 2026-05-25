/**
 * Audit comparatif MiniSearch vs SQLite FTS5 (résultats, latence, mémoire).
 * Produit: reports/audit_backend_comparison.json + reports/audit_backend_comparison.md
 */
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { getDefaultDbPath } = require('../src/services/bdpmDatabase');

const REPORT_DIR = path.join(__dirname, '../reports');
const WORKER = path.join(__dirname, 'audit_worker.js');

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} Mo`;
}

function runWorker(backend, loadProfile = 'full') {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [backend, loadProfile], {
      execArgv: process.execArgv.includes('--expose-gc') ? ['--expose-gc'] : [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('message', resolve);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0 && !stderr.includes('message')) {
        reject(new Error(`Worker ${backend} exit ${code}: ${stderr}`));
      }
    });
  });
}

function resultKey(item) {
  return item.cis || item.cip13 || item.code || item.label;
}

function compareSearches(mini, sqlite) {
  const rows = [];
  let identicalTop1 = 0;
  let identicalTop5 = 0;
  let identicalCount = 0;
  let identicalMatchQualityTop1 = 0;

  for (const m of mini.searches) {
    const s = sqlite.searches.find(
      (x) => x.type === m.type && x.q === m.q && x.category === m.category
    );
    if (!s) continue;

    const miniTop5 = m.top5.map(resultKey);
    const sqliteTop5 = s.top5.map(resultKey);
    const top1Match = miniTop5[0] === sqliteTop5[0];
    const top5Match = miniTop5.join('|') === sqliteTop5.join('|');
    const countMatch = m.count === s.count;
    const mqMatch = m.top5[0]?.match_quality === s.top5[0]?.match_quality;

    if (top1Match) identicalTop1++;
    if (top5Match) identicalTop5++;
    if (countMatch) identicalCount++;
    if (mqMatch) identicalMatchQualityTop1++;

    const latencyRatio = s.latency_ms.p50 > 0 ? m.latency_ms.p50 / s.latency_ms.p50 : null;

    rows.push({
      category: m.category,
      type: m.type,
      q: m.q,
      mini_count: m.count,
      sqlite_count: s.count,
      count_delta: s.count - m.count,
      top1_match: top1Match,
      top5_match: top5Match,
      match_quality_top1_match: mqMatch,
      mini_top1: m.top5[0] || null,
      sqlite_top1: s.top5[0] || null,
      mini_latency_p50_ms: m.latency_ms.p50,
      sqlite_latency_p50_ms: s.latency_ms.p50,
      latency_ratio_mini_over_sqlite: latencyRatio ? Math.round(latencyRatio * 1000) / 1000 : null
    });
  }

  const total = rows.length;
  return {
    total,
    identicalTop1,
    identicalTop5,
    identicalCount,
    identicalMatchQualityTop1,
    pct_top1: total ? Math.round((identicalTop1 / total) * 1000) / 10 : 0,
    pct_top5: total ? Math.round((identicalTop5 / total) * 1000) / 10 : 0,
    pct_count: total ? Math.round((identicalCount / total) * 1000) / 10 : 0,
    pct_mq_top1: total ? Math.round((identicalMatchQualityTop1 / total) * 1000) / 10 : 0,
    rows: rows.filter((r) => !r.top5_match || r.count_delta !== 0 || !r.match_quality_top1_match)
  };
}

function buildMarkdown(report) {
  const { mini, sqlite, sqlite_lean: sqliteLean, comparison, artifacts, generated_at } = report;
  const lines = [];

  lines.push('# Audit comparatif — MiniSearch vs SQLite FTS5 (BDPM)');
  lines.push('');
  lines.push(`**Date :** ${generated_at}`);
  lines.push('');
  lines.push('## Résumé exécutif');
  lines.push('');
  lines.push(`| Indicateur | Valeur |`);
  lines.push(`|------------|--------|`);
  lines.push(`| Cas de recherche comparés | ${comparison.total} |`);
  lines.push(`| Top 1 identique (CIS/libellé) | **${comparison.pct_top1}%** (${comparison.identicalTop1}/${comparison.total}) |`);
  lines.push(`| Top 5 identique | **${comparison.pct_top5}%** (${comparison.identicalTop5}/${comparison.total}) |`);
  lines.push(`| Volume total identique | **${comparison.pct_count}%** (${comparison.identicalCount}/${comparison.total}) |`);
  lines.push(`| \`match_quality\` top 1 identique | **${comparison.pct_mq_top1}%** (${comparison.identicalMatchQualityTop1}/${comparison.total}) |`);
  lines.push(`| Chargement MiniSearch | ${mini.load_ms} ms |`);
  lines.push(`| Chargement SQLite FTS (même pipeline) | ${sqlite.load_ms} ms |`);
  lines.push(`| RSS après chargement (MiniSearch) | ${mini.memory.after_load.rss_mb} Mo |`);
  lines.push(`| RSS après chargement (SQLite FTS full) | ${sqlite.memory.after_load.rss_mb} Mo |`);
  lines.push(`| RSS après chargement (SQLite FTS lean) | ${sqliteLean.memory.after_load.rss_mb} Mo |`);
  lines.push(`| Écart RSS full Mini vs SQLite | ${report.memory_delta_rss_mb} Mo |`);
  lines.push(`| Économie RSS lean vs full SQLite | **${report.memory_lean_vs_full_rss_mb} Mo** |`);
  lines.push(`| Taille \`data/bdpm.sqlite\` | ${artifacts.sqlite_size} |`);
  lines.push('');
  lines.push('> **Profils :** `full` charge tout en RAM + tous les index MiniSearch. `sqlite_lean` (avec `DATA_LOAD_PROFILE=sqlite_lean`) exclut présentations/compositions de la RAM et les index MiniSearch des 3 grands datasets FTS.');
  lines.push('');
  lines.push('## Consommation mémoire');
  lines.push('');
  lines.push('Mesures par processus Node isolé (`--expose-gc` si disponible).');
  lines.push('');
  lines.push('| Phase | MiniSearch RSS | SQLite FTS RSS | MiniSearch heap | SQLite FTS heap |');
  lines.push('|-------|----------------|----------------|-------------------|-----------------|');
  lines.push(`| Avant chargement | ${mini.memory.before_load.rss_mb} Mo | ${sqlite.memory.before_load.rss_mb} Mo | ${mini.memory.before_load.heap_used_mb} Mo | ${sqlite.memory.before_load.heap_used_mb} Mo |`);
  lines.push(`| Après \`loadData()\` (full) | ${mini.memory.after_load.rss_mb} Mo | ${sqlite.memory.after_load.rss_mb} Mo | ${mini.memory.after_load.heap_used_mb} Mo | ${sqlite.memory.after_load.heap_used_mb} Mo |`);
  lines.push(`| Après \`loadData()\` (sqlite_lean) | — | ${sqliteLean.memory.after_load.rss_mb} Mo | — | ${sqliteLean.memory.after_load.heap_used_mb} Mo |`);
  lines.push(`| Après campagne recherche (full) | ${mini.memory.after_searches.rss_mb} Mo | ${sqlite.memory.after_searches.rss_mb} Mo | ${mini.memory.after_searches.heap_used_mb} Mo | ${sqlite.memory.after_searches.heap_used_mb} Mo |`);
  lines.push(`| Après campagne recherche (lean) | — | ${sqliteLean.memory.after_searches.rss_mb} Mo | — | ${sqliteLean.memory.after_searches.heap_used_mb} Mo |`);
  lines.push(`| Delta RSS au chargement | ${mini.memory.delta_load_rss_mb} Mo | ${sqlite.memory.delta_load_rss_mb} Mo | — | — |`);
  lines.push('');
  lines.push('### Interprétation mémoire');
  lines.push('');
  lines.push(report.memory_interpretation);
  lines.push('');
  lines.push('## Performance recherche (latence p50, 30 itérations après warmup)');
  lines.push('');
  lines.push('| Catégorie | Type | Requête | p50 MiniSearch (ms) | p50 SQLite FTS (ms) | Ratio Mini/SQLite |');
  lines.push('|-----------|------|---------|---------------------|---------------------|-------------------|');
  for (const row of comparison.all_latency_rows) {
    lines.push(`| ${row.category} | ${row.type} | \`${row.q}\` | ${row.mini_latency_p50_ms} | ${row.sqlite_latency_p50_ms} | ${row.latency_ratio_mini_over_sqlite ?? '—'} |`);
  }
  const latencyRows = comparison.all_latency_rows || [];
  const avgMini = latencyRows.reduce((s, r) => s + r.mini_latency_p50_ms, 0) / (latencyRows.length || 1);
  const avgSqlite = latencyRows.reduce((s, r) => s + r.sqlite_latency_p50_ms, 0) / (latencyRows.length || 1);
  lines.push('');
  lines.push(`**Moyenne p50 globale :** MiniSearch ${Math.round(avgMini * 100) / 100} ms — SQLite FTS ${Math.round(avgSqlite * 100) / 100} ms`);
  lines.push('');
  lines.push('## Écarts de résultats (top 5 / volume / match_quality)');
  lines.push('');
  if (comparison.rows.length === 0) {
    lines.push('Aucun écart détecté sur les cas testés.');
  } else {
    lines.push('| Catégorie | Requête | Δ count | Top1 OK | Top5 OK | MQ top1 OK | Mini #1 | SQLite #1 |');
    lines.push('|-----------|---------|---------|---------|---------|------------|---------|-----------|');
    for (const r of comparison.rows) {
      const mini1 = r.mini_top1 ? `${r.mini_top1.label} (${r.mini_top1.match_quality})` : '—';
      const sqlite1 = r.sqlite_top1 ? `${r.sqlite_top1.label} (${r.sqlite_top1.match_quality})` : '—';
      lines.push(`| ${r.category} | \`${r.q}\` | ${r.count_delta} | ${r.top1_match ? 'oui' : '**non**'} | ${r.top5_match ? 'oui' : '**non**'} | ${r.match_quality_top1_match ? 'oui' : '**non**'} | ${mini1} | ${sqlite1} |`);
    }
  }
  lines.push('');
  lines.push('## Recommandations');
  lines.push('');
  for (const rec of report.recommendations) {
    lines.push(`- ${rec}`);
  }
  lines.push('');
  lines.push('## Artefacts');
  lines.push('');
  lines.push('- `reports/audit_backend_comparison.json` — données brutes');
  lines.push('- `reports/audit_backend_comparison.md` — ce rapport');
  lines.push('');

  return lines.join('\n');
}

async function main() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const dbPath = getDefaultDbPath();
  const sqliteStat = fs.existsSync(dbPath) ? fs.statSync(dbPath) : null;

  console.log('Audit: full + minisearch...');
  const mini = await runWorker('minisearch', 'full');
  console.log('Audit: full + sqlite_fts...');
  const sqlite = await runWorker('sqlite_fts', 'full');
  console.log('Audit: sqlite_lean + sqlite_fts...');
  const sqliteLean = await runWorker('sqlite_fts', 'sqlite_lean');

  const comparison = compareSearches(mini, sqlite);
  comparison.all_latency_rows = mini.searches.map((m) => {
    const s = sqlite.searches.find((x) => x.type === m.type && x.q === m.q);
    return {
      category: m.category,
      type: m.type,
      q: m.q,
      mini_latency_p50_ms: m.latency_ms.p50,
      sqlite_latency_p50_ms: s?.latency_ms.p50 ?? 0,
      latency_ratio_mini_over_sqlite:
        s && s.latency_ms.p50 > 0 ? Math.round((m.latency_ms.p50 / s.latency_ms.p50) * 1000) / 1000 : null
    };
  });

  const memoryDeltaRss =
    Math.round((sqlite.memory.after_load.rss_mb - mini.memory.after_load.rss_mb) * 100) / 100;

  const avgLatencyMini =
    comparison.all_latency_rows.reduce((s, r) => s + r.mini_latency_p50_ms, 0) /
    comparison.all_latency_rows.length;
  const avgLatencySqlite =
    comparison.all_latency_rows.reduce((s, r) => s + r.sqlite_latency_p50_ms, 0) /
    comparison.all_latency_rows.length;

  const recommendations = [];
  if (comparison.pct_top5 < 95) {
    recommendations.push(
      'Affiner le ranking FTS5 (poids BM25, fuzzy tokenisé, champs secondaires) avant toute bascule publique.'
    );
  } else {
    recommendations.push(
      'Le recall/ranking est globalement aligné ; une bascule progressive reste envisageable sur les 3 datasets FTS.'
    );
  }
  if (avgLatencySqlite > avgLatencyMini * 1.5) {
    recommendations.push(
      'Optimiser SQLite FTS : connexion persistante (éviter open/close par requête), cache prepared statements, LIMIT plus strict sur candidats fuzzy.'
    );
  }
  if (Math.abs(memoryDeltaRss) < 5) {
    recommendations.push(
      'Pour réduire la RAM, il faudra une phase 3 sans reconstruction MiniSearch (FTS + lookups SQL uniquement), pas seulement `SEARCH_BACKEND=sqlite_fts`.'
    );
  }
  recommendations.push(
    'Conserver `SEARCH_BACKEND=compare` en préproduction pour détecter les dérives de ranking après chaque refresh BDPM.'
  );

  const leanVsFullRss =
    Math.round((sqliteLean.memory.after_load.rss_mb - sqlite.memory.after_load.rss_mb) * 100) / 100;

  const memory_interpretation = [
    `En profil **full**, l'écart RSS après chargement MiniSearch vs SQLite FTS est de **${memoryDeltaRss} Mo** (quasi identique) : les deux chargent les tableaux complets et les index MiniSearch.`,
    `En profil **sqlite_lean** (\`DATA_LOAD_PROFILE=sqlite_lean\` + \`SEARCH_BACKEND=sqlite_fts\`), l'économie au chargement est d'environ **${Math.abs(leanVsFullRss)} Mo RSS** et **${Math.round((sqlite.memory.after_load.heap_used_mb - sqliteLean.memory.after_load.heap_used_mb) * 100) / 100} Mo heap** : présentations/compositions ne sont plus en RAM, ni les 3 index MiniSearch lourds.`,
    `La base SQLite sur disque (${sqliteStat ? formatBytes(sqliteStat.size) : 'N/A'}) reste ouverte via connexion persistante ; les jointures CIS→présentations/compositions passent par SQL à la demande.`,
    'Le fuzzy SQLite est désormais borné aux candidats FTS/prefix (plus de scan intégral), ce qui réduit les pics RAM en recherche par rapport à la version précédente.'
  ].join('\n\n');

  const generated_at = new Date().toISOString();

  const report = {
    generated_at,
    mini,
    sqlite,
    sqlite_lean: sqliteLean,
    comparison,
    memory_delta_rss_mb: memoryDeltaRss,
    memory_lean_vs_full_rss_mb: leanVsFullRss,
    memory_interpretation,
    artifacts: {
      sqlite_path: dbPath,
      sqlite_size: sqliteStat ? formatBytes(sqliteStat.size) : null
    },
    recommendations
  };

  const jsonPath = path.join(REPORT_DIR, 'audit_backend_comparison.json');
  const mdPath = path.join(REPORT_DIR, 'audit_backend_comparison.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, buildMarkdown(report));

  console.log(`\nRapport JSON: ${jsonPath}`);
  console.log(`Rapport Markdown: ${mdPath}`);
  console.log(`Top5 identiques: ${comparison.pct_top5}% | Top1: ${comparison.pct_top1}% | Écarts: ${comparison.rows.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
