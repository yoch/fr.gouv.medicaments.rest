#!/usr/bin/env node
'use strict';

// Local uniquement : aucun downloader, aucune connexion à la production.
// node --expose-gc --max-semi-space-size=8 scripts/memory/audit-retention.js
// AUDIT_FORCE_GC=0 : observer le GC naturel, sans forcer les collections.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const v8 = require('node:v8');
const { fork } = require('node:child_process');
const { setTimeout: delay, setImmediate: nextTurn } = require('node:timers/promises');
const root = path.resolve(__dirname, '../..');

function positive(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name}: entier positif requis`);
  return value;
}

async function worker() {
  const bdpm = require('../../src/services/dataLoader');
  const vet = require('../../src/services/vetDataLoader');
  const pool = require('../../src/utils/stringPool');
  const states = [require('../../src/services/bdpm/state'), require('../../src/services/vet/state')];
  const oldIndexes = [];
  let server;
  let peakRss = 0;
  const timer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
  timer.unref();

  async function measure(forceGc) {
    await nextTurn();
    if (forceGc) {
      if (!global.gc) throw new Error('--expose-gc requis');
      global.gc();
      await nextTurn();
      global.gc();
      await nextTurn();
    }
    const memory = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss);
    const resources = {};
    for (const name of process.getActiveResourcesInfo()) resources[name] = (resources[name] || 0) + 1;
    const result = {
      memory, sampled_peak_rss: peakRss, max_rss_kib: process.resourceUsage().maxRSS,
      string_pool_size: pool.internPoolSize(),
      rows: states.map(state => Object.fromEntries(Object.entries(state.corpus).map(([k, rows]) => [k, rows.length]))),
      retired_indexes: oldIndexes.length,
      retired_indexes_alive: oldIndexes.reduce((n, ref) => n + (ref.deref() ? 1 : 0), 0),
      fd_count: fs.existsSync('/proc/self/fd') ? fs.readdirSync('/proc/self/fd').length : null,
      resources,
      heap_spaces: v8.getHeapSpaceStatistics().map(({ space_name, space_used_size, physical_space_size }) =>
        ({ space_name, space_used_size, physical_space_size }))
    };
    peakRss = 0;
    return result;
  }

  process.on('message', async ({ id, action, forceGc, snapshot }) => {
    try {
      let result;
      if (action === 'load' || action === 'reload') {
        if (action === 'reload') {
          for (const state of states) {
            for (const index of Object.values(state.searchIndexes)) if (index) oldIndexes.push(new WeakRef(index));
          }
        }
        await bdpm.loadData();
        await vet.loadVetData();
        if (!server) {
          server = require('../../src/app').createApp().listen(0, '127.0.0.1');
          await new Promise(resolve => server.once('listening', resolve));
        }
        result = { port: server.address().port, ...await measure(forceGc) };
      } else if (action === 'sample') {
        result = await measure(forceGc);
      } else if (action === 'snapshot') {
        await measure(true);
        result = { file: v8.writeHeapSnapshot(snapshot) };
      } else if (action === 'stop') {
        clearInterval(timer);
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        process.send({ id, result: { stopped: true } }, () => process.disconnect());
        return;
      } else throw new Error(`Action inconnue: ${action}`);
      process.send({ id, result });
    } catch (error) {
      process.send({ id, error: error.stack });
    }
  });
  process.on('disconnect', () => { clearInterval(timer); if (server) server.close(); });
}

async function main() {
  const batches = positive('AUDIT_BATCHES', 6);
  const requests = positive('AUDIT_REQUESTS', 400);
  const concurrency = positive('AUDIT_CONCURRENCY', 8);
  const reloads = positive('AUDIT_RELOADS', 5);
  const idleMs = positive('AUDIT_IDLE_MS', 30000);
  const trafficMode = process.env.AUDIT_TRAFFIC_MODE || 'mixed';
  if (!['mixed', 'normal', 'broad'].includes(trafficMode)) throw new Error('AUDIT_TRAFFIC_MODE: mixed, normal ou broad requis');
  const forceGc = process.env.AUDIT_FORCE_GC !== '0';
  const out = path.resolve(process.env.AUDIT_OUT || path.join(root, 'tmp/memory-audit/retention.json'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const log = fs.openSync(`${out}.worker.log`, 'w');
  const child = fork(__filename, ['--worker'], {
    cwd: root, env: { ...process.env, NODE_ENV: 'production', ENABLE_RATE_LIMIT: 'false' },
    stdio: ['ignore', log, log, 'ipc']
  });
  fs.closeSync(log);
  let serial = 0;
  const pending = new Map();
  child.on('message', ({ id, result, error }) => {
    const slot = pending.get(id);
    if (!slot) return;
    clearTimeout(slot.timer); pending.delete(id);
    if (error) slot.reject(new Error(error)); else slot.resolve(result);
  });
  function rejectPending(error) {
    for (const slot of pending.values()) { clearTimeout(slot.timer); slot.reject(error); }
    pending.clear();
  }
  child.on('error', rejectPending);
  child.on('exit', code => rejectPending(new Error(`Worker sorti (${code})`)));
  function call(action, extra = {}) {
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        pending.delete(id); reject(new Error(`Délai dépassé: ${action}`)); child.kill();
      }, 120000);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, action, forceGc, ...extra });
    });
  }
  const report = {
    runtime: process.version, exec_args: process.execArgv,
    dependency: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@yoch/frozenminisearch/package.json'))).version,
    configuration: { forceGc, batches, requests, concurrency, reloads, idleMs, trafficMode, corpus_light_profile: process.env.CORPUS_LIGHT_PROFILE || 'false' },
    revision: require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    samples: [], traffic: []
  };
  const started = Date.now();
  function record(label, data) {
    report.samples.push({ label, elapsed_ms: Date.now() - started, ...data });
    console.log(`${label}: rss=${(data.memory.rss / 1048576).toFixed(2)} heap=${(data.memory.heapUsed / 1048576).toFixed(2)} external=${(data.memory.external / 1048576).toFixed(2)} pool=${data.string_pool_size} old_indexes_alive=${data.retired_indexes_alive}`);
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  }
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  try {
    const loaded = await call('load');
    record('loaded', loaded);
    const cis = '60234100';
    const paths = [
      '/health', '/config', '/api-docs.json', '/',
      `/api/medicaments/specialites/${cis}`,
      '/api/medicaments/specialites?limit=1000',
      '/api/medicaments/presentations?q=500&limit=20',
      '/api/medicaments/compositions?q=amoxicilline&limit=20',
      '/api/medicaments/specialites?q=para&limit=10&page=2',
      '/api/veterinaires/medicaments?q=amoxi&limit=10',
      '/api/veterinaires/presentations?q=boite&limit=20',
      '/api/medicaments/disponibilite/alerts?q=doliprane',
      '/api/medicaments/search?q=paracetamol&source=mixed&limit=20&detail=summary',
      '/api/medicaments/search?q=amoxicilline&source=mixed&limit=20&format=markdown',
      '/api/medicaments/specialites?q=a&limit=10',
      '/api/medicaments/search?q=a&source=mixed&limit=10'
    ];
    const endpoints = trafficMode === 'normal' ? paths.slice(0, -2)
      : trafficMode === 'broad' ? paths.slice(-2) : paths;
    async function get(endpoint) {
      return new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port: loaded.port, path: endpoint, agent }, res => {
          let bytes = 0;
          res.on('data', chunk => { bytes += chunk.length; });
          res.on('error', reject);
          res.on('end', () => res.statusCode === 200 ? resolve(bytes) : reject(new Error(`${res.statusCode}: ${endpoint}`)));
        });
        req.setTimeout(30000, () => req.destroy(new Error('HTTP timeout')));
        req.on('error', reject);
      });
    }
    for (let batch = 0; batch < batches; batch++) {
      let cursor = 0;
      let bytes = 0;
      const t0 = Date.now();
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (cursor < requests) {
          const n = cursor++;
          // Une requête différente toutes les 5 lectures pour éprouver les caches.
          const endpoint = n % 5 === 0 && trafficMode !== 'broad'
            ? `/api/medicaments/specialites?q=paracetamol%20audit${batch * requests + n}&limit=10`
            : endpoints[n % endpoints.length];
          bytes += await get(endpoint);
        }
      }));
      report.traffic.push({ batch: batch + 1, requests, response_bytes: bytes, duration_ms: Date.now() - t0 });
      record(`traffic_${batch + 1}_natural`, await call('sample', { forceGc: false }));
      if (forceGc) record(`traffic_${batch + 1}_gc`, await call('sample'));
    }
    agent.destroy();
    for (let elapsed = 0; elapsed < idleMs;) {
      const step = Math.min(10000, idleMs - elapsed);
      await delay(step); elapsed += step;
      record(`idle_${elapsed}_natural`, await call('sample', { forceGc: false }));
    }
    if (forceGc) record('idle_gc', await call('sample'));
    if (process.env.AUDIT_SNAPSHOT_DIR) {
      const dir = path.resolve(process.env.AUDIT_SNAPSHOT_DIR);
      fs.mkdirSync(dir, { recursive: true });
      await call('snapshot', { snapshot: path.join(dir, 'before-reloads.heapsnapshot') });
    }
    for (let cycle = 1; cycle <= reloads; cycle++) record(`reload_${cycle}`, await call('reload'));
    // Mesurer après retour du dernier handler de reload : son contexte async peut
    // garder temporairement la dernière variable de boucle inspectée par WeakRef.
    if (forceGc) record('after_reload_handlers_gc', await call('sample'));
    if (process.env.AUDIT_SNAPSHOT_DIR) await call('snapshot', { snapshot: path.join(path.resolve(process.env.AUDIT_SNAPSHOT_DIR), 'after-reloads.heapsnapshot') });
    await call('stop');
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    console.log(`Résultats: ${out}`);
  } finally {
    agent.destroy();
    if (child.connected) child.kill();
  }
}

(process.argv.includes('--worker') ? worker() : main()).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
