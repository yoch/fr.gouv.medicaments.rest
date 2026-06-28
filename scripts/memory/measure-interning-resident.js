#!/usr/bin/env node
'use strict';

/**
 * Mesure résident BDPM (heap/RSS/pool) — plusieurs runs pour médiane.
 * node --expose-gc scripts/memory/measure-interning-resident.js
 * LOAD_HAS_AVIS=false node --expose-gc scripts/memory/measure-interning-resident.js
 */

const { spawnSync } = require('child_process');
const path = require('path');

const RUNS = parseInt(process.env.MEASURE_RUNS || '5', 10);
const script = path.join(__dirname, 'measure-bdpm-resident.js');

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function runOnce() {
  const res = spawnSync(process.execPath, ['--expose-gc', script], {
    encoding: 'utf8',
    env: process.env,
    cwd: path.resolve(__dirname, '../..'),
    maxBuffer: 64 * 1024 * 1024
  });
  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || '').slice(-500));
  }
  const out = res.stdout || '';
  const heap = out.match(/__HEAP__(\d+)/);
  const rss = out.match(/__RSS__(\d+)/);
  const pool = out.match(/__POOL__(\d+)/);
  if (!heap || !rss) throw new Error(`markers missing: ${out.slice(-300)}`);
  return {
    heap: parseInt(heap[1], 10),
    rss: parseInt(rss[1], 10),
    pool: pool ? parseInt(pool[1], 10) : 0
  };
}

const heaps = [];
const rsss = [];
const pools = [];

console.log(`=== Mesure résident BDPM (${RUNS} runs) ===`);
console.log(
  `env: LOAD_HAS_AVIS=${process.env.LOAD_HAS_AVIS !== 'false'} LOAD_MITM=${process.env.LOAD_MITM !== 'false'} CORPUS_LIGHT=${process.env.CORPUS_LIGHT_PROFILE === 'true'}\n`
);

for (let i = 0; i < RUNS; i++) {
  const r = runOnce();
  heaps.push(r.heap);
  rsss.push(r.rss);
  pools.push(r.pool);
  console.log(`  run ${i + 1}: heap=${r.heap} Mo rss=${r.rss} Mo pool=${r.pool}`);
}

console.log('\nMédiane:');
console.log(`  heap post-gc: ${median(heaps)} Mo`);
console.log(`  rss:          ${median(rsss)} Mo`);
console.log(`  pool intern:  ${median(pools)} valeurs`);
