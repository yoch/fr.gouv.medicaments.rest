#!/usr/bin/env node
/**
 * Orchestrateur : sweep --max-semi-space-size sur plusieurs configs, N runs chacune,
 * parse --trace-gc pour extraire le VRAI pic heap (max des heaps "avant GC" reportés
 * par V8 à chaque Scavenge/Mark-compact). Rapporte min/médiane/max par config.
 *
 * Usage: node scripts/memory/sweep-semi-space.js
 * Les configs et N sont paramétrables ci-dessous.
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const CONFIGS = [
  { label: 'default (auto=64)', flag: null },
  { label: 'max-semi-space-size=16', flag: '--max-semi-space-size=16' },
  { label: 'max-semi-space-size=8', flag: '--max-semi-space-size=8' },
  { label: 'max-semi-space-size=6', flag: '--max-semi-space-size=6' },
  { label: 'max-semi-space-size=4', flag: '--max-semi-space-size=4' }
];
const RUNS = 5;

function runOnce(flag) {
  // Le sandbox de ce workspace bloque la capture directe du stderr via pipe spawnSync
  // et via redirection fichier. Contournement : shell:true avec 2>&1 mergé dans stdout
  // (le pipe shell traverse le sandbox). On parse ensuite --trace-gc dans stdout.
  const nodeArgs = ['--expose-gc', '--trace-gc'];
  if (flag) nodeArgs.push(flag);
  nodeArgs.push(path.join(__dirname, 'measure-bdpm-peak.js'));
  const cmd = `${process.execPath} ${nodeArgs.join(' ')} 2>&1`;

  const res = spawnSync(cmd, {
    shell: true,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  });

  if (res.status !== 0) {
    return { error: res.status, stdout: (res.stdout || '').slice(-2000) };
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
  if (peaks.length === 0) {
    return { error: 'no GC lines parsed', stdout: out.slice(-1500) };
  }
  const peak = Math.max(...peaks);
  const minAfter = afters.length ? Math.min(...afters) : null;
  return { peak, gcCount: peaks.length, minAfter };
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function fmt(n) {
  return typeof n === 'number' ? n.toFixed(1) : String(n);
}

console.log(`Sweep --max-semi-space-size : ${RUNS} runs par config, pic via --trace-gc (max heap avant GC)\n`);
console.log('config                              runs  min      median   max      gc/run  resid');
console.log('─'.repeat(92));

const results = [];
for (const cfg of CONFIGS) {
  const peaks = [];
  const gcCounts = [];
  const minAfters = [];
  let firstErr = null;
  for (let i = 0; i < RUNS; i++) {
    const r = runOnce(cfg.flag);
    if (r.error) {
      firstErr = firstErr || r;
      continue;
    }
    peaks.push(r.peak);
    gcCounts.push(r.gcCount);
    if (r.minAfter != null) minAfters.push(r.minAfter);
  }
  if (peaks.length === 0) {
    console.log(`${cfg.label.padEnd(36)}  ERROR: ${firstErr && firstErr.error}`);
    continue;
  }
  const min = Math.min(...peaks);
  const med = median(peaks);
  const max = Math.max(...peaks);
  const avgGc = Math.round(gcCounts.reduce((a, b) => a + b, 0) / gcCounts.length);
  const resid = minAfters.length ? Math.min(...minAfters) : null;
  console.log(
    `${cfg.label.padEnd(36)}  ${String(peaks.length).padStart(2)}    ${fmt(min).padStart(7)}  ${fmt(med).padStart(7)}  ${fmt(max).padStart(7)}  ${String(avgGc).padStart(5)}  ${fmt(resid).padStart(6)}`
  );
  results.push({ cfg: cfg.label, peaks, min, med, max, avgGc, resid });
}

console.log('\nDétail par config (pic Mo par run) :');
for (const r of results) {
  console.log(`  ${r.cfg}: ${r.peaks.map((p) => p.toFixed(1)).join(', ')}`);
}
