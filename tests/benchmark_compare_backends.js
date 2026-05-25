const fs = require('fs');

const MINISEARCH_FILE = process.env.MINISEARCH_FILE || 'benchmark_results_minisearch.json';
const SQLITE_FILE = process.env.SQLITE_FILE || 'benchmark_results_sqlite_fts.json';

function readJson(filepath) {
  if (!fs.existsSync(filepath)) {
    throw new Error(`Fichier introuvable: ${filepath}`);
  }
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

function compareTopResults(mini, sqlite) {
  const diffs = [];
  for (const [term, routes] of Object.entries(mini)) {
    const sqliteRoutes = sqlite[term] || {};
    for (const [route, payload] of Object.entries(routes)) {
      const sqlitePayload = sqliteRoutes[route];
      if (!sqlitePayload) {
        diffs.push({ term, route, reason: 'route manquante côté sqlite_fts' });
        continue;
      }
      const miniTop = (payload.top_results || []).map((item) => item.cis || item.label);
      const sqliteTop = (sqlitePayload.top_results || []).map((item) => item.cis || item.label);
      if (miniTop.join('|') !== sqliteTop.join('|')) {
        diffs.push({
          term,
          route,
          mini: miniTop,
          sqlite: sqliteTop
        });
      }
    }
  }
  return diffs;
}

function run() {
  const mini = readJson(MINISEARCH_FILE);
  const sqlite = readJson(SQLITE_FILE);
  const diffs = compareTopResults(mini, sqlite);

  console.log(`Comparaison: ${MINISEARCH_FILE} vs ${SQLITE_FILE}`);
  console.log(`Diffs top résultats: ${diffs.length}`);
  if (diffs.length > 0) {
    console.log(JSON.stringify(diffs.slice(0, 30), null, 2));
    process.exitCode = 1;
  }
}

run();
