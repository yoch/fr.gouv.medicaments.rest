#!/usr/bin/env node
/**
 * Compare le pic mémoire du load vet AVANT/APRÈS le commit streaming XML dict.
 * Crée des worktrees éphémères aux deux commits, y copie measure-vet-peak.js,
 * lance --trace-gc (N runs), parse le vrai pic (max heap avant GC), rapporte.
 *
 * Usage: node scripts/benchmark/compare-vet-streaming.js
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '../..');
const VET_DATA_DIR = path.join(REPO, 'data', 'veterinaires');
const TMP_BASE = '/tmp/vet-stream-cmp';
const RUNS = 10;

const PAIRS = [
  { label: 'pre-streaming (d08e1fc)', commit: 'd08e1fc' },
  { label: 'streaming dict (51610f8)', commit: '51610f8' }
];

function sh(cmd, opts = {}) {
  return spawnSync(cmd, { shell: true, encoding: 'utf8', cwd: REPO, ...opts });
}

function runOncePeaks(worktreeDir) {
  const scriptPath = path.join(worktreeDir, 'scripts', 'measure-vet-peak.js');
  const env = { ...process.env, VET_DATA_DIR };
  const cmd = `${process.execPath} --expose-gc --trace-gc ${scriptPath} 2>&1`;
  const res = spawnSync(cmd, {
    shell: true,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env
  });
  if (res.status !== 0) {
    return { error: res.status, tail: (res.stdout || '').slice(-1500) };
  }
  const out = res.stdout || '';
  const lines = out.split('\n').filter((l) => /Scavenge|Mark-Compact|Mark-sweep|Mark Compact/.test(l));
  const peaks = [];
  const afters = [];
  for (const line of lines) {
    const before = line.match(/(?:Scavenge|Mark-Compact|Mark-sweep|Mark Compact)\s+([\d.]+)\s*\(/);
    const after = line.match(/->\s+([\d.]+)\s+\(/);
    if (before) peaks.push(parseFloat(before[1]));
    if (after) afters.push(parseFloat(after[1]));
  }
  if (!peaks.length) return { error: 'no GC lines', tail: out.slice(-1500) };
  const rssMatch = out.match(/__RSS_PEAK__(\d+)/);
  const heapMatch = out.match(/__HEAP_PEAK__(\d+)/);
  return {
    peak: Math.max(...peaks),
    gcCount: peaks.length,
    minAfter: Math.min(...afters),
    rssPeak: rssMatch ? parseInt(rssMatch[1], 10) : null,
    samplerHeapPeak: heapMatch ? parseInt(heapMatch[1], 10) : null
  };
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function fmt(n) {
  return typeof n === 'number' ? n.toFixed(1) : String(n);
}

// Nettoyage préalable
sh(`git worktree prune`);
fs.rmSync(TMP_BASE, { recursive: true, force: true });
fs.mkdirSync(TMP_BASE, { recursive: true });

const measureScript = path.join(REPO, 'scripts', 'measure-vet-peak.js');
const results = [];

for (const p of PAIRS) {
  const wtDir = path.join(TMP_BASE, p.commit);
  console.log(`\n=== ${p.label} ===`);
  const add = sh(`git worktree add --detach ${wtDir} ${p.commit}`);
  if (add.status !== 0) {
    console.error(`worktree add failed for ${p.commit}: ${add.stderr}`);
    continue;
  }
  // Copier le script de mesure (n'existe pas forcément à ces commits)
  fs.mkdirSync(path.join(wtDir, 'scripts'), { recursive: true });
  fs.copyFileSync(measureScript, path.join(wtDir, 'scripts', 'measure-vet-peak.js'));
  // Installer les deps du worktree (lien vers node_modules du main pour aller vite)
  if (!fs.existsSync(path.join(wtDir, 'node_modules'))) {
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(wtDir, 'node_modules'));
  }
  // Données vet : linker vers le main (gitignored, pas dans le worktree)
  const dataDir = path.join(wtDir, 'data', 'veterinaires');
  if (!fs.existsSync(path.join(wtDir, 'data'))) fs.mkdirSync(path.join(wtDir, 'data'));
  if (!fs.existsSync(dataDir)) fs.symlinkSync(VET_DATA_DIR, dataDir);

  const peaks = [];
  const gcCounts = [];
  const minAfters = [];
  const rssPeaks = [];
  const samplerHeapPeaks = [];
  let firstErr = null;
  for (let i = 0; i < RUNS; i++) {
    const r = runOncePeaks(wtDir);
    if (r.error) { firstErr = firstErr || r; continue; }
    peaks.push(r.peak);
    gcCounts.push(r.gcCount);
    minAfters.push(r.minAfter);
    if (r.rssPeak != null) rssPeaks.push(r.rssPeak);
    if (r.samplerHeapPeak != null) samplerHeapPeaks.push(r.samplerHeapPeak);
  }
  if (!peaks.length) {
    console.log(`  ERROR: ${firstErr && firstErr.error}\n  ${firstErr && firstErr.tail}`);
    results.push({ label: p.label, error: firstErr });
    continue;
  }
  const min = Math.min(...peaks);
  const med = median(peaks);
  const max = Math.max(...peaks);
  const avgGc = Math.round(gcCounts.reduce((a, b) => a + b, 0) / gcCounts.length);
  const resid = Math.min(...minAfters);
  const rssMed = rssPeaks.length ? median(rssPeaks) : null;
  const rssMin = rssPeaks.length ? Math.min(...rssPeaks) : null;
  const rssMax = rssPeaks.length ? Math.max(...rssPeaks) : null;
  const shMed = samplerHeapPeaks.length ? median(samplerHeapPeaks) : null;
  console.log(`  trace-gc heap: min=${fmt(min)} med=${fmt(med)} max=${fmt(max)} (gc/run=${avgGc}, resid=${fmt(resid)})`);
  console.log(`  sampler heap: med=${fmt(shMed)}`);
  console.log(`  rss:          min=${fmt(rssMin)} med=${fmt(rssMed)} max=${fmt(rssMax)}`);
  console.log(`  pics heap:    ${peaks.map((x) => x.toFixed(1)).join(', ')}`);
  results.push({ label: p.label, min, med, max, avgGc, resid, rssMed, rssMin, rssMax, shMed, peaks });
}

// Nettoyage
for (const p of PAIRS) {
  sh(`git worktree remove --force ${path.join(TMP_BASE, p.commit)} 2>/dev/null`);
}
sh(`git worktree prune`);
fs.rmSync(TMP_BASE, { recursive: true, force: true });

console.log('\n=== Synthèse (pic Mo, 5 runs) ===');
console.log('config                              heap-gc-med  heap-gc-max  sampler-med  rss-med  rss-max');
console.log('─'.repeat(95));
for (const r of results) {
  if (r.error) { console.log(`${r.label.padEnd(36)} ERROR`); continue; }
  console.log(`${r.label.padEnd(36)} ${fmt(r.med).padStart(11)}  ${fmt(r.max).padStart(11)}  ${fmt(r.shMed).padStart(11)}  ${fmt(r.rssMed).padStart(7)}  ${fmt(r.rssMax).padStart(7)}`);
}
if (results.length === 2 && results[0].med && results[1].med) {
  const dh = results[1].med - results[0].med;
  const dr = results[1].rssMed - results[0].rssMed;
  console.log(`\nDelta médian heap (streaming - pre): ${dh > 0 ? '+' : ''}${dh.toFixed(1)} Mo`);
  console.log(`Delta médian RSS  (streaming - pre): ${dr > 0 ? '+' : ''}${dr.toFixed(1)} Mo`);
}
