#!/usr/bin/env node
'use strict';

/**
 * Générateur de charge HTTP keep-alive pour comparer plusieurs exécutions
 * d'un même serveur (Node, binaire Bun JIT, binaire Bun AOT, etc.).
 *
 * Une phase de chauffe précède la mesure. Les requêtes sont réparties en
 * round-robin sur les chemins fournis, avec une concurrence fixe.
 *
 * Usage :
 *   node scripts/benchmark/http-load.js --base-url=http://127.0.0.1:3000
 *   node scripts/benchmark/http-load.js --paths=/health,/api/medicaments/search?q=doliprane
 *   HTTP_LOAD_BASE_URL=http://127.0.0.1:3210 npm run benchmark:http -- --duration=10
 *
 * Options :
 *   --base-url=<url>       URL du serveur (défaut : http://127.0.0.1:3000)
 *   --paths=<liste>        Chemins séparés par des virgules (défaut : /health)
 *   --concurrency=<n>      Requêtes simultanées (défaut : 8)
 *   --duration=<s>         Durée mesurée en secondes (défaut : 10)
 *   --warmup=<s>           Durée de chauffe en secondes (défaut : 3)
 *   --timeout=<ms>         Délai maximal par requête (défaut : 30000)
 *   --json                 Sortie JSON compacte sur une seule ligne
 *
 * Le résultat contient le débit, les percentiles de latence, les octets reçus
 * et la répartition des codes HTTP pour la phase mesurée.
 */

const http = require('node:http');

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:3000',
  paths: '/health',
  concurrency: 8,
  durationS: 10,
  warmupS: 3,
  timeoutMs: 30000
};

function parseArgs(argv) {
  const opts = {
    baseUrl: (process.env.HTTP_LOAD_BASE_URL || DEFAULTS.baseUrl).replace(/\/$/, ''),
    paths: (process.env.HTTP_LOAD_PATHS || DEFAULTS.paths)
      .split(',')
      .map((path) => path.trim())
      .filter(Boolean),
    concurrency: parseInt(process.env.HTTP_LOAD_CONCURRENCY || String(DEFAULTS.concurrency), 10),
    durationS: parseInt(process.env.HTTP_LOAD_DURATION || String(DEFAULTS.durationS), 10),
    warmupS: parseInt(process.env.HTTP_LOAD_WARMUP || String(DEFAULTS.warmupS), 10),
    timeoutMs: parseInt(process.env.HTTP_LOAD_TIMEOUT_MS || String(DEFAULTS.timeoutMs), 10),
    json: false
  };

  for (const arg of argv) {
    if (arg === '--json') opts.json = true;
    else if (arg.startsWith('--base-url=')) opts.baseUrl = arg.slice('--base-url='.length).replace(/\/$/, '');
    else if (arg.startsWith('--paths=')) opts.paths = arg.slice('--paths='.length).split(',').map((p) => p.trim()).filter(Boolean);
    else if (arg.startsWith('--concurrency=')) opts.concurrency = parseInt(arg.slice('--concurrency='.length), 10);
    else if (arg.startsWith('--duration=')) opts.durationS = parseInt(arg.slice('--duration='.length), 10);
    else if (arg.startsWith('--warmup=')) opts.warmupS = parseInt(arg.slice('--warmup='.length), 10);
    else if (arg.startsWith('--timeout=')) opts.timeoutMs = parseInt(arg.slice('--timeout='.length), 10);
  }

  if (!Number.isFinite(opts.concurrency) || opts.concurrency < 1) throw new Error('concurrency invalide');
  if (!Number.isFinite(opts.durationS) || opts.durationS < 1) throw new Error('duration invalide');
  if (!Number.isFinite(opts.warmupS) || opts.warmupS < 0) throw new Error('warmup invalide');
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 1) throw new Error('timeout invalide');
  if (opts.paths.length === 0) throw new Error('aucun chemin à charger');

  return opts;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function createClient(opts) {
  const url = new URL(opts.baseUrl);
  const agent = new http.Agent({ keepAlive: true, maxSockets: opts.concurrency });

  function request(path) {
    return new Promise((resolve) => {
      const started = process.hrtime.bigint();
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path,
          method: 'GET',
          agent,
          headers: { connection: 'keep-alive' }
        },
        (res) => {
          let bytes = 0;
          res.on('data', (chunk) => {
            bytes += chunk.length;
          });
          res.on('end', () => {
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 400,
              status: res.statusCode,
              bytes,
              elapsedMs: Number(process.hrtime.bigint() - started) / 1e6
            });
          });
          // Connexion coupée en plein corps (redémarrage, délai) : 'end' ne vient jamais.
          res.on('close', () => {
            if (res.complete) return;
            resolve({
              ok: false,
              status: res.statusCode,
              bytes,
              elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
              error: 'response aborted'
            });
          });
        }
      );
      req.setTimeout(opts.timeoutMs, () => req.destroy(new Error('timeout')));
      req.on('error', (error) => {
        resolve({
          ok: false,
          status: 0,
          bytes: 0,
          elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
          error: error.message
        });
      });
      req.end();
    });
  }

  return { request, close: () => agent.destroy() };
}

async function runPhase(client, opts, label, durationMs) {
  const end = Date.now() + durationMs;
  const samples = [];
  const statuses = new Map();
  let errors = 0;
  let bytes = 0;
  let index = 0;

  async function worker() {
    while (Date.now() < end) {
      const path = opts.paths[index++ % opts.paths.length];
      const result = await client.request(path);
      samples.push(result.elapsedMs);
      bytes += result.bytes;
      if (!result.ok) errors++;
      const key = result.status || result.error || 'error';
      statuses.set(key, (statuses.get(key) || 0) + 1);
    }
  }

  const started = Date.now();
  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));
  const elapsedMs = Date.now() - started;
  samples.sort((a, b) => a - b);
  const sum = samples.reduce((total, value) => total + value, 0);

  return {
    phase: label,
    ms: elapsedMs,
    requests: samples.length,
    rps: (samples.length / elapsedMs) * 1000,
    errors,
    bytes,
    meanMs: samples.length > 0 ? sum / samples.length : 0,
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    p99Ms: percentile(samples, 99),
    maxMs: samples.length > 0 ? samples[samples.length - 1] : 0,
    statuses: Object.fromEntries(statuses)
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const client = createClient(opts);

  try {
    const warmup = await runPhase(client, opts, 'warmup', opts.warmupS * 1000);
    const measured = await runPhase(client, opts, 'measured', opts.durationS * 1000);
    const result = {
      baseUrl: opts.baseUrl,
      concurrency: opts.concurrency,
      paths: opts.paths,
      warmup,
      measured
    };
    if (opts.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
