#!/usr/bin/env node
/**
 * Compare le résident (heap + RSS) BDPM avant/après interning.
 * Worktrees éphémères : 51610f8 (pré-interning) vs 57c9375 (post-interning BDPM).
 * node scripts/benchmark/compare-bdpm-interning.js
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '../..');
const TMP_BASE = '/tmp/bdpm-intern-cmp';
const RUNS = 6;

const PAIRS = [
  { label: 'pre-interning (51610f8)', commit: '51610f8' },
  { label: 'post-interning (57c9375)', commit: '57c9375' }
];

function sh(cmd, opts = {}) {
  return spawnSync(cmd, { shell: true, encoding: 'utf8', cwd: REPO, ...opts });
}

function runOnce(wtDir) {
  const scriptPath = path.join(wtDir, 'scripts', 'measure-bdpm-resident.js');
  const cmd = `${process.execPath} --expose-gc ${scriptPath} 2>&1`;
  const res = spawnSync(cmd, { shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0) return { error: res.status, tail: (res.stdout || '').slice(-1000) };
  const out = res.stdout || '';
  const heap = out.match(/__HEAP__(\d+)/);
  const rss = out.match(/__RSS__(\d+)/);
  if (!heap || !rss) return { error: 'no markers', tail: out.slice(-1000) };
  return { heap: parseInt(heap[1], 10), rss: parseInt(rss[1], 10) };
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function fmt(n) { return typeof n === 'number' ? n.toFixed(1) : String(n); }

sh(`git worktree prune`);
fs.rmSync(TMP_BASE, { recursive: true, force: true });
fs.mkdirSync(TMP_BASE, { recursive: true });

const measureScript = path.join(REPO, 'scripts', 'measure-bdpm-resident.js');
const results = [];

for (const p of PAIRS) {
  const wtDir = path.join(TMP_BASE, p.commit);
  console.log(`\n=== ${p.label} ===`);
  const add = sh(`git worktree add --detach ${wtDir} ${p.commit}`);
  if (add.status !== 0) { console.error(`worktree add failed: ${add.stderr}`); continue; }
  fs.mkdirSync(path.join(wtDir, 'scripts'), { recursive: true });
  fs.copyFileSync(measureScript, path.join(wtDir, 'scripts', 'measure-bdpm-resident.js'));
  if (!fs.existsSync(path.join(wtDir, 'node_modules'))) {
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(wtDir, 'node_modules'));
  }
  // Données BDPM (gitignored) : linker vers le main
  for (const sub of ['bdpm', '']) {
    const dataDir = path.join(wtDir, 'data', sub);
    if (!fs.existsSync(path.dirname(dataDir))) fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  }
  if (!fs.existsSync(path.join(wtDir, 'data'))) fs.mkdirSync(path.join(wtDir, 'data'));
  const mainData = path.join(REPO, 'data');
  const wtData = path.join(wtDir, 'data');
  // Linker chaque sous-dossier de data qui n'existe pas dans le worktree
  for (const entry of fs.readdirSync(mainData)) {
    const src = path.join(mainData, entry);
    const dst = path.join(wtData, entry);
    if (!fs.existsSync(dst)) fs.symlinkSync(src, dst);
  }

  const heaps = [];
  const rsss = [];
  let firstErr = null;
  for (let i = 0; i < RUNS; i++) {
    const r = runOnce(wtDir);
    if (r.error) { firstErr = firstErr || r; continue; }
    heaps.push(r.heap);
    rsss.push(r.rss);
  }
  if (!heaps.length) {
    console.log(`  ERROR: ${firstErr && firstErr.error}\n  ${firstErr && firstErr.tail}`);
    results.push({ label: p.label, error: firstErr });
    continue;
  }
  console.log(`  heap post-gc: min=${fmt(Math.min(...heaps))} med=${fmt(median(heaps))} max=${fmt(Math.max(...heaps))}`);
  console.log(`  rss post-load: min=${fmt(Math.min(...rsss))} med=${fmt(median(rsss))} max=${fmt(Math.max(...rsss))}`);
  console.log(`  heaps: ${heaps.join(', ')}`);
  console.log(`  rsss:  ${rsss.join(', ')}`);
  results.push({ label: p.label, heapMed: median(heaps), heapMin: Math.min(...heaps), rssMed: median(rsss), rssMin: Math.min(...rsss) });
}

for (const p of PAIRS) {
  sh(`git worktree remove --force ${path.join(TMP_BASE, p.commit)} 2>/dev/null`);
}
sh(`git worktree prune`);
fs.rmSync(TMP_BASE, { recursive: true, force: true });

console.log('\n=== Synthèse résident BDPM (Mo, 6 runs) ===');
console.log('config                              heap-med   heap-min   rss-med   rss-min');
console.log('─'.repeat(75));
for (const r of results) {
  if (r.error) { console.log(`${r.label.padEnd(36)} ERROR`); continue; }
  console.log(`${r.label.padEnd(36)} ${fmt(r.heapMed).padStart(7)}   ${fmt(r.heapMin).padStart(7)}   ${fmt(r.rssMed).padStart(7)}  ${fmt(r.rssMin).padStart(7)}`);
}
if (results.length === 2 && results[0].heapMed && results[1].heapMed) {
  const dh = results[1].heapMed - results[0].heapMed;
  const dr = results[1].rssMed - results[0].rssMed;
  console.log(`\nDelta médian heap: ${dh > 0 ? '+' : ''}${dh.toFixed(1)} Mo`);
  console.log(`Delta médian RSS:  ${dr > 0 ? '+' : ''}${dr.toFixed(1)} Mo`);
}
