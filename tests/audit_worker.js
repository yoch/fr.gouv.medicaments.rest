/**
 * Worker isolé : charge BDPM, mesure mémoire et exécute les requêtes de recherche.
 * Usage: node tests/audit_worker.js <minisearch|sqlite_fts>
 */
const { performance } = require('perf_hooks');
const fs = require('fs');
const path = require('path');
const { buildBdpmDatabase, getDefaultDbPath } = require('../src/services/bdpmDatabase');
const { loadData, search } = require('../src/services/dataLoader');

const backend = process.argv[2];
const loadProfile = process.argv[3] || 'full';
if (!backend || !['minisearch', 'sqlite_fts'].includes(backend)) {
  console.error('Backend requis: minisearch | sqlite_fts');
  process.exit(1);
}
if (!['full', 'sqlite_lean'].includes(loadProfile)) {
  console.error('Profil requis: full | sqlite_lean');
  process.exit(1);
}

process.env.SEARCH_BACKEND = backend;
process.env.DATA_LOAD_PROFILE = loadProfile;

const SEARCH_CASES = [
  { type: 'specialites', q: 'doliprane', category: 'nom_complet' },
  { type: 'specialites', q: 'doli', category: 'prefix' },
  { type: 'specialites', q: 'dolipranr', category: 'fuzzy' },
  { type: 'specialites', q: '60234100', category: 'cis_exact' },
  { type: 'specialites', q: 'paracetamol', category: 'sans_accent' },
  { type: 'specialites', q: 'paracétamol', category: 'avec_accent' },
  { type: 'specialites', q: 'pfizer', category: 'titulaire' },
  { type: 'specialites', q: 'comprimé', category: 'forme_pharma' },
  { type: 'presentations', q: 'doliprane', category: 'libelle' },
  { type: 'presentations', q: 'migraine', category: 'indications' },
  { type: 'compositions', q: 'paracetamol', category: 'substance' },
  { type: 'compositions', q: 'tramadol', category: 'substance_2' },
  { type: 'mitm', q: 'N02BE01', category: 'code_atc' },
  { type: 'substances', q: 'paracetamol', category: 'substances_index' },
  { type: 'generiques', q: 'amoxicilline', category: 'groupe' }
];

const WARMUP = 3;
const BENCH_ITERATIONS = 30;

function memorySnapshot() {
  if (global.gc) global.gc();
  const u = process.memoryUsage();
  const mb = (n) => Math.round((n / 1024 / 1024) * 100) / 100;
  return {
    rss_mb: mb(u.rss),
    heap_used_mb: mb(u.heapUsed),
    heap_total_mb: mb(u.heapTotal),
    external_mb: mb(u.external),
    array_buffers_mb: mb(u.arrayBuffers ?? 0)
  };
}

function summarizeResult(item, type) {
  const label =
    item.denomination ||
    item.libelle ||
    item.denomination_substance ||
    item.libelle_groupe ||
    item.libelle_smr ||
    item.condition ||
    item.libelle_statut ||
    'N/A';
  return {
    cis: item.cis || null,
    cip13: item.cip13 || null,
    code: item.code || null,
    label: String(label).slice(0, 80),
    match_quality: item.match_quality || null
  };
}

function runSearchCase(testCase) {
  const iterations = BENCH_ITERATIONS + WARMUP;
  const durations = [];
  let lastResults = [];

  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    lastResults = search(testCase.type, testCase.q);
    durations.push(performance.now() - t0);
  }

  const measured = durations.slice(WARMUP);
  measured.sort((a, b) => a - b);
  const p50 = measured[Math.floor(measured.length * 0.5)] ?? 0;
  const p95 = measured[Math.floor(measured.length * 0.95)] ?? 0;
  const avg = measured.reduce((s, v) => s + v, 0) / (measured.length || 1);

  const top5 = lastResults.slice(0, 5).map((item) => summarizeResult(item, testCase.type));

  return {
    type: testCase.type,
    q: testCase.q,
    category: testCase.category,
    count: lastResults.length,
    latency_ms: {
      avg: Math.round(avg * 100) / 100,
      p50: Math.round(p50 * 100) / 100,
      p95: Math.round(p95 * 100) / 100
    },
    top5
  };
}

async function main() {
  const dbPath = getDefaultDbPath();
  if (!fs.existsSync(dbPath)) {
    buildBdpmDatabase();
  }

  const memBefore = memorySnapshot();
  const loadStart = performance.now();
  await loadData();
  const loadMs = performance.now() - loadStart;
  const memAfterLoad = memorySnapshot();

  const searches = SEARCH_CASES.map(runSearchCase);
  const memAfterSearch = memorySnapshot();

  const payload = {
    backend,
    load_profile: loadProfile,
    load_ms: Math.round(loadMs),
    memory: {
      before_load: memBefore,
      after_load: memAfterLoad,
      after_searches: memAfterSearch,
      delta_load_rss_mb: Math.round((memAfterLoad.rss_mb - memBefore.rss_mb) * 100) / 100
    },
    searches
  };

  if (process.send) {
    process.send(payload);
  } else {
    console.log(JSON.stringify(payload, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
