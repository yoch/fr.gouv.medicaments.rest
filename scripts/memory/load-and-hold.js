#!/usr/bin/env node
/**
 * Charge BDPM + vétérinaire puis reste vivant pour mesurer pic / plateau RSS.
 * Protocol stderr : une ligne `__MEM__{json}` par événement.
 *
 * Env :
 *   VET_GAP_MS      pause entre BDPM et vet (défaut 5000, comme PM2 prod)
 *   SETTLE_MS       idle naturel après load (défaut 420000 = 7 min)
 *   POST_GC_HOLD_MS idle après GC forcé (défaut 30000)
 *   SEARCH_SMOKE    0 pour skip les recherches
 */
'use strict';

function bytesToMb(bytes) {
  return Math.round((bytes / 1048576) * 10) / 10;
}

function jsMem() {
  const u = process.memoryUsage();
  return {
    rss_mb: bytesToMb(u.rss),
    heap_used_mb: bytesToMb(u.heapUsed),
    heap_total_mb: bytesToMb(u.heapTotal),
    external_mb: bytesToMb(u.external),
    array_buffers_mb: bytesToMb(u.arrayBuffers || 0)
  };
}

function runtimeInfo() {
  const isBun = typeof globalThis.Bun !== 'undefined';
  if (isBun) {
    return {
      kind: 'bun',
      version: Bun.version,
      revision: Bun.revision || null
    };
  }
  return { kind: 'node', version: process.version };
}

const t0 = Date.now();

function emit(event, extra = {}) {
  const payload = { event, t_ms: Date.now() - t0, ...jsMem(), ...extra };
  process.stderr.write(`__MEM__${JSON.stringify(payload)}\n`);
}

function forceGc() {
  if (typeof globalThis.Bun !== 'undefined' && typeof Bun.gc === 'function') {
    Bun.gc(true);
    return 'bun.gc(true)';
  }
  if (typeof global.gc === 'function') {
    global.gc();
    return 'global.gc()';
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const VET_GAP_MS = parseInt(process.env.VET_GAP_MS || '5000', 10);
const SETTLE_MS = parseInt(process.env.SETTLE_MS || '420000', 10);
const POST_GC_HOLD_MS = parseInt(process.env.POST_GC_HOLD_MS || '30000', 10);
const SEARCH_SMOKE = process.env.SEARCH_SMOKE !== '0';

/** Aligné sur src/server.js MEMORY_PLATEAU_DELAYS_MS, plus 1 min / 3 min / 7 min. */
function settleCheckpoints(totalMs) {
  if (totalMs <= 0) return [];
  const wanted = [30_000, 60_000, 120_000, 180_000, 300_000, 420_000];
  const points = wanted.filter((t) => t < totalMs);
  points.push(totalMs);
  return points;
}

(async () => {
  emit('runtime', { runtime: runtimeInfo() });

  const { loadData, search } = require('../../src/services/dataLoader');
  emit('bdpm_start');
  const bdpmT0 = Date.now();
  await loadData();
  emit('bdpm_done', { duration_ms: Date.now() - bdpmT0 });

  if (VET_GAP_MS > 0) {
    emit('vet_gap_start', { gap_ms: VET_GAP_MS });
    await sleep(VET_GAP_MS);
    emit('vet_gap_done');
  }

  const { loadVetData, searchVet } = require('../../src/services/vetDataLoader');
  emit('vet_start');
  const vetT0 = Date.now();
  await loadVetData();
  emit('vet_done', { duration_ms: Date.now() - vetT0 });

  if (SEARCH_SMOKE) {
    emit('search_start');
    const queries = [
      'doliprane',
      'amoxicilline',
      'paracetamol',
      'ozempic',
      'aspirine',
      'ibuprofene'
    ];
    let hits = 0;
    for (const q of queries) {
      hits += search('specialites', q).length;
      hits += search('compositions', q).length;
      hits += searchVet('medicaments', q).length;
    }
    emit('search_done', { queries: queries.length, hits });
  }

  const checkpoints = settleCheckpoints(SETTLE_MS);
  let prev = 0;
  for (const waited of checkpoints) {
    await sleep(waited - prev);
    prev = waited;
    emit('settle', { waited_ms: waited });
  }

  const gcHow = forceGc();
  emit('post_gc', { gc: gcHow });
  if (POST_GC_HOLD_MS > 0) {
    await sleep(POST_GC_HOLD_MS);
  }
  emit('done', { gc: gcHow, total_ms: Date.now() - t0, post_gc_hold_ms: POST_GC_HOLD_MS });
})().catch((err) => {
  emit('error', { message: err && err.message, stack: err && err.stack });
  process.exit(1);
});
