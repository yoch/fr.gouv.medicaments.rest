#!/usr/bin/env node
'use strict';

/**
 * Stress test léger pour l'API en production (ou tout autre déploiement).
 *
 * Usage:
 *   npm run stress:prod
 *   npm run stress:prod -- --dry-run
 *   node scripts/benchmark/stress-test-prod.js --duration=60 --concurrency=10
 *   STRESS_BASE_URL=http://localhost:3000 node scripts/benchmark/stress-test-prod.js
 *
 * Scénarios (--scenario) :
 *   mixed   — trafic réaliste (défaut)
 *   health  — /health uniquement
 *   search  — recherches textuelles
 *   read    — listes et détails
 *   all     — tous les endpoints du scénario mixed, en round-robin
 */

const DEFAULT_BASE_URL = 'https://bdpm.galiensante.fr';
const DEFAULT_DURATION_S = 30;
const DEFAULT_CONCURRENCY = 5;

const SEARCH_QUERIES = [
  'doliprane',
  'paracetamol',
  'amoxicilline',
  'ibuprofene',
  'metformine',
  'omeprazole',
  'atorvastatine'
];

const FALLBACK_CIS_CODES = ['60234100', '69002237', '60002283', '62815604'];

function parseArgs(argv) {
  const opts = {
    baseUrl: (process.env.STRESS_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ''),
    durationS: parseInt(process.env.STRESS_DURATION_S || String(DEFAULT_DURATION_S), 10),
    concurrency: parseInt(process.env.STRESS_CONCURRENCY || String(DEFAULT_CONCURRENCY), 10),
    scenario: process.env.STRESS_SCENARIO || 'mixed',
    dryRun: false,
    json: false
  };

  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg.startsWith('--base-url=')) opts.baseUrl = arg.slice('--base-url='.length).replace(/\/$/, '');
    else if (arg.startsWith('--duration=')) opts.durationS = parseInt(arg.slice('--duration='.length), 10);
    else if (arg.startsWith('--concurrency=')) opts.concurrency = parseInt(arg.slice('--concurrency='.length), 10);
    else if (arg.startsWith('--scenario=')) opts.scenario = arg.slice('--scenario='.length);
  }

  return opts;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

async function resolveCisCodes(baseUrl) {
  const url = `${baseUrl}/api/medicaments/specialites?q=doliprane&limit=8`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) return FALLBACK_CIS_CODES;
    const body = await res.json();
    const cis = (body.data || []).map((row) => row.cis).filter(Boolean);
    return cis.length > 0 ? cis : FALLBACK_CIS_CODES;
  } catch {
    return FALLBACK_CIS_CODES;
  }
}

function buildEndpoints(cisCodes) {
  const q = pick(SEARCH_QUERIES);
  const cis = pick(cisCodes);
  const page = pickInt(1, 20);

  return [
    { name: 'health', path: '/health', weight: 10 },
    { name: 'search', path: `/api/medicaments/search?q=${encodeURIComponent(q)}&limit=10`, weight: 30 },
    { name: 'specialites-search', path: `/api/medicaments/specialites?q=${encodeURIComponent(q)}&limit=10`, weight: 25 },
    { name: 'specialite-detail', path: `/api/medicaments/specialites/${cis}`, weight: 20 },
    { name: 'substances-search', path: `/api/medicaments/substances?q=${encodeURIComponent(q.slice(0, 5))}&limit=10`, weight: 10 },
    { name: 'specialites-list', path: `/api/medicaments/specialites?limit=10&page=${page}`, weight: 5 }
  ];
}

function selectScenario(scenario, cisCodes) {
  const all = buildEndpoints(cisCodes);

  switch (scenario) {
    case 'mixed':
      return all;
    case 'health':
      return all.filter((e) => e.name === 'health');
    case 'search':
      return all.filter((e) => ['search', 'specialites-search', 'substances-search'].includes(e.name));
    case 'read':
      return all.filter((e) => ['specialite-detail', 'specialites-list', 'health'].includes(e.name));
    case 'all':
      return all.map((e) => ({ ...e, weight: 1 }));
    default:
      throw new Error(`Scénario inconnu: ${scenario} (mixed|health|search|read|all)`);
  }
}

function weightedPick(endpoints) {
  const total = endpoints.reduce((sum, e) => sum + e.weight, 0);
  let r = Math.random() * total;
  for (const endpoint of endpoints) {
    r -= endpoint.weight;
    if (r <= 0) return endpoint;
  }
  return endpoints[endpoints.length - 1];
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function formatMs(ms) {
  return `${Math.round(ms)} ms`;
}

async function fetchOnce(baseUrl, endpoint) {
  const url = `${baseUrl}${endpoint.path}`;
  const start = performance.now();
  let status = 0;
  let ok = false;
  let error = null;

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000)
    });
    status = res.status;
    ok = res.ok;
    await res.arrayBuffer();
  } catch (err) {
    error = err.name === 'TimeoutError' ? 'timeout' : err.message;
  }

  return {
    name: endpoint.name,
    path: endpoint.path,
    status,
    ok,
    error,
    latencyMs: performance.now() - start
  };
}

function createStats() {
  return {
    total: 0,
    ok: 0,
    errors: 0,
    latencies: [],
    byStatus: new Map(),
    byEndpoint: new Map(),
    errorTypes: new Map()
  };
}

function recordResult(stats, result) {
  stats.total += 1;
  stats.latencies.push(result.latencyMs);

  if (result.ok) stats.ok += 1;
  else stats.errors += 1;

  const statusKey = result.error ? `ERR:${result.error}` : String(result.status);
  stats.byStatus.set(statusKey, (stats.byStatus.get(statusKey) || 0) + 1);

  if (!stats.byEndpoint.has(result.name)) {
    stats.byEndpoint.set(result.name, { total: 0, ok: 0, latencies: [] });
  }
  const ep = stats.byEndpoint.get(result.name);
  ep.total += 1;
  if (result.ok) ep.ok += 1;
  ep.latencies.push(result.latencyMs);

  if (result.error) {
    stats.errorTypes.set(result.error, (stats.errorTypes.get(result.error) || 0) + 1);
  }
}

function summarize(stats, durationS) {
  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;

  const byEndpoint = {};
  for (const [name, ep] of stats.byEndpoint) {
    const epSorted = [...ep.latencies].sort((a, b) => a - b);
    const epMean = epSorted.length ? epSorted.reduce((a, b) => a + b, 0) / epSorted.length : 0;
    byEndpoint[name] = {
      total: ep.total,
      ok: ep.ok,
      error_rate_pct: ep.total ? Math.round(((ep.total - ep.ok) / ep.total) * 1000) / 10 : 0,
      latency: {
        mean_ms: Math.round(epMean),
        p50_ms: Math.round(percentile(epSorted, 50)),
        p95_ms: Math.round(percentile(epSorted, 95)),
        p99_ms: Math.round(percentile(epSorted, 99))
      }
    };
  }

  return {
    requests: stats.total,
    ok: stats.ok,
    errors: stats.errors,
    success_rate_pct: stats.total ? Math.round((stats.ok / stats.total) * 1000) / 10 : 0,
    rps: durationS > 0 ? Math.round((stats.total / durationS) * 10) / 10 : 0,
    latency: {
      min_ms: Math.round(sorted[0] || 0),
      mean_ms: Math.round(mean),
      p50_ms: Math.round(percentile(sorted, 50)),
      p95_ms: Math.round(percentile(sorted, 95)),
      p99_ms: Math.round(percentile(sorted, 99)),
      max_ms: Math.round(sorted[sorted.length - 1] || 0)
    },
    status_codes: Object.fromEntries(stats.byStatus),
    error_types: Object.fromEntries(stats.errorTypes),
    by_endpoint: byEndpoint
  };
}

function printReport(opts, summary) {
  console.log('\n=== Stress test API BDPM ===\n');
  console.log(`Cible       : ${opts.baseUrl}`);
  console.log(`Scénario    : ${opts.scenario}`);
  console.log(`Durée       : ${opts.durationS}s`);
  console.log(`Concurrence : ${opts.concurrency}`);
  console.log(`Requêtes    : ${summary.requests} (${summary.rps} req/s)`);
  console.log(`Succès      : ${summary.ok}/${summary.requests} (${summary.success_rate_pct}%)`);

  if (summary.errors > 0) {
    console.log(`Erreurs     : ${summary.errors}`);
    console.log('Codes/statuts:', summary.status_codes);
  }

  const l = summary.latency;
  console.log('\nLatence globale :');
  console.log(`  min ${formatMs(l.min_ms)} | p50 ${formatMs(l.p50_ms)} | p95 ${formatMs(l.p95_ms)} | p99 ${formatMs(l.p99_ms)} | max ${formatMs(l.max_ms)} | moy ${formatMs(l.mean_ms)}`);

  console.log('\nPar endpoint :');
  for (const [name, ep] of Object.entries(summary.by_endpoint)) {
    console.log(
      `  ${name.padEnd(20)} n=${String(ep.total).padStart(4)} ok=${String(ep.ok).padStart(4)} err=${String(ep.total - ep.ok).padStart(3)}  p50=${formatMs(ep.latency.p50_ms)} p95=${formatMs(ep.latency.p95_ms)}`
    );
  }

  if (summary.status_codes['429']) {
    console.log('\n⚠ Rate limiting détecté (HTTP 429). Réduisez --concurrency ou --duration.');
  }
}

async function runDryRun(opts, endpoints) {
  console.log(`Dry-run sur ${opts.baseUrl} (${endpoints.length} endpoints)...\n`);
  const results = [];

  for (const endpoint of endpoints) {
    const result = await fetchOnce(opts.baseUrl, endpoint);
    results.push(result);
    const statusLabel = result.error ? `ERR ${result.error}` : String(result.status);
    console.log(`  [${statusLabel}] ${formatMs(result.latencyMs).padStart(8)}  ${endpoint.path}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log(`\n${failed.length}/${results.length} requêtes en échec.`);
    process.exitCode = 1;
  } else {
    console.log('\nTous les endpoints répondent correctement.');
  }
}

async function runLoadTest(opts, endpointPool, cisCodes) {
  const deadline = Date.now() + opts.durationS * 1000;
  const stats = createStats();
  let roundRobinIdx = 0;

  function nextEndpoint() {
    if (opts.scenario === 'all') {
      const ep = endpointPool[roundRobinIdx % endpointPool.length];
      roundRobinIdx += 1;
      return ep;
    }
    return weightedPick(endpointPool);
  }

  async function worker() {
    while (Date.now() < deadline) {
      let endpoint = nextEndpoint();
      if (endpoint.name === 'specialite-detail') {
        endpoint = {
          ...endpoint,
          path: `/api/medicaments/specialites/${pick(cisCodes)}`
        };
      }
      const result = await fetchOnce(opts.baseUrl, endpoint);
      recordResult(stats, result);
    }
  }

  console.log(`Démarrage : ${opts.concurrency} workers pendant ${opts.durationS}s sur ${opts.baseUrl}`);
  const started = performance.now();
  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));
  const elapsedS = (performance.now() - started) / 1000;

  const summary = summarize(stats, elapsedS);

  if (opts.json) {
    console.log(JSON.stringify({ config: opts, summary }, null, 2));
  } else {
    printReport(opts, summary);
  }

  if (summary.errors > 0 || summary.success_rate_pct < 99) {
    process.exitCode = 1;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.durationS < 1 || Number.isNaN(opts.durationS)) {
    throw new Error('--duration doit être >= 1');
  }
  if (opts.concurrency < 1 || Number.isNaN(opts.concurrency)) {
    throw new Error('--concurrency doit être >= 1');
  }

  if (opts.concurrency > 20 || opts.durationS > 120) {
    console.warn(
      '⚠ Paramètres agressifs : privilégiez concurrency ≤ 20 et duration ≤ 120s sur la prod partagée.'
    );
  }

  const cisCodes = await resolveCisCodes(opts.baseUrl);
  const endpointPool = selectScenario(opts.scenario, cisCodes);

  if (opts.dryRun) {
    await runDryRun(opts, endpointPool);
    return;
  }

  await runLoadTest(opts, endpointPool, cisCodes);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
