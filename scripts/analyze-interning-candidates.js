#!/usr/bin/env node
'use strict';

/**
 * Analyse la cardinalité des champs corpus pour décider quoi interner.
 *
 * Usage:
 *   node scripts/analyze-interning-candidates.js
 *   LOAD_HAS_AVIS=false CORPUS_LIGHT_PROFILE=true node scripts/analyze-interning-candidates.js
 *   node --expose-gc scripts/analyze-interning-candidates.js --json > tmp/interning.json
 *
 * Heuristique « intern » : ratio distinctes < 5 %, ≥ 20 copies moyennes, longueur médiane < 120.
 * Heuristique « skip » : ratio > 50 % ou longueur médiane > 300.
 */

const { loadData, getBdpmCorpusStats } = require('../src/services/dataLoader');
const { BDPM_RECORD_CLASSES } = require('../src/models/bdpm');
const { internPoolSize } = require('../src/utils/stringPool');
const { BDPM_LOW_CARDINALITY_FIELDS } = require('../src/utils/bdpmInterning');

const MIN_COPIES_FOR_INTERN = 20;
const MAX_DISTINCT_RATIO = 0.05;
const SKIP_DISTINCT_RATIO = 0.5;
const MAX_MEDIAN_LEN_INTERN = 120;
const MIN_MEDIAN_LEN_SKIP = 300;

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function analyzeField(values) {
  const nonEmpty = [];
  for (const v of values) {
    if (v == null || v === '') continue;
    if (typeof v === 'string') nonEmpty.push(v);
  }
  const total = nonEmpty.length;
  if (total === 0) {
    return { total: 0, distinct: 0, distinctRatio: 0, recommendation: 'empty' };
  }

  const freq = new Map();
  let bytesIfDistinct = 0;
  for (const s of nonEmpty) {
    freq.set(s, (freq.get(s) || 0) + 1);
    bytesIfDistinct += s.length * 2;
  }
  const distinct = freq.size;
  const distinctRatio = distinct / total;
  const avgCopies = total / distinct;

  const lengths = nonEmpty.map((s) => s.length);
  const savedBytesEst = [...freq.entries()].reduce(
    (sum, [s, n]) => sum + (n - 1) * s.length * 2,
    0
  );

  let top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  top = top.map(([value, count]) => ({
    count,
    sample: value.length > 48 ? `${value.slice(0, 45)}…` : value
  }));

  let recommendation = 'borderline';
  if (distinctRatio > SKIP_DISTINCT_RATIO || median(lengths) > MIN_MEDIAN_LEN_SKIP) {
    recommendation = 'skip';
  } else if (
    distinctRatio <= MAX_DISTINCT_RATIO &&
    avgCopies >= MIN_COPIES_FOR_INTERN &&
    median(lengths) <= MAX_MEDIAN_LEN_INTERN
  ) {
    recommendation = 'intern';
  }

  return {
    total,
    distinct,
    distinctRatio: Math.round(distinctRatio * 1000) / 1000,
    avgCopies: Math.round(avgCopies * 10) / 10,
    medianLen: median(lengths),
    savedKbEst: Math.round(savedBytesEst / 1024),
    top,
    recommendation
  };
}

function collectFieldValues(corpus, field) {
  const out = [];
  for (let i = 0; i < corpus.length; i++) {
    out.push(corpus[i][field]);
  }
  return out;
}

function currentLowCardinality(type) {
  return new Set(BDPM_LOW_CARDINALITY_FIELDS[type] || []);
}

function fmtRow(cols, widths) {
  return cols.map((c, i) => String(c).padEnd(widths[i])).join('  ');
}

async function main() {
  const jsonOut = process.argv.includes('--json');

  await loadData();
  const { corpus } = getBdpmCorpusStats();

  const report = {
    env: {
      LOAD_HAS_AVIS: process.env.LOAD_HAS_AVIS !== 'false',
      LOAD_MITM: process.env.LOAD_MITM !== 'false',
      CORPUS_LIGHT_PROFILE: process.env.CORPUS_LIGHT_PROFILE === 'true'
    },
    types: {},
    recommended: {},
    poolSizeAfterLoad: internPoolSize()
  };

  if (global.gc) global.gc();
  const mem = process.memoryUsage();
  report.memoryMb = {
    heapUsed: Math.round(mem.heapUsed / 1048576),
    rss: Math.round(mem.rss / 1048576)
  };

  for (const [type, Cls] of Object.entries(BDPM_RECORD_CLASSES)) {
    const rows = corpus[type];
    if (!rows || rows.length === 0) continue;

    const fields = Cls.FIELD_NAMES;
    const current = currentLowCardinality(type);
    const fieldStats = {};
    const toIntern = [];
    const toSkip = [];

    for (const field of fields) {
      const stats = analyzeField(collectFieldValues(rows, field));
      stats.currentlyInterned = current.has(field);
      fieldStats[field] = stats;
      if (stats.recommendation === 'intern') toIntern.push(field);
      if (stats.recommendation === 'skip' && stats.currentlyInterned) toSkip.push(field);
    }

    report.types[type] = { rows: rows.length, fields: fieldStats };
    report.recommended[type] = { intern: toIntern, removeFromCurrent: toSkip };
  }

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('=== Analyse interning BDPM ===\n');
  console.log(
    `Profil: HAS=${report.env.LOAD_HAS_AVIS} MITM=${report.env.LOAD_MITM} light=${report.env.CORPUS_LIGHT_PROFILE}`
  );
  console.log(`Mémoire post-load: heap ${report.memoryMb.heapUsed} Mo, RSS ${report.memoryMb.rss} Mo`);
  console.log(`Pool intern actuel: ${report.poolSizeAfterLoad} valeurs distinctes\n`);

  for (const [type, { rows, fields }] of Object.entries(report.types)) {
    console.log(`--- ${type} (${rows} lignes) ---`);
    const headers = ['field', 'total', 'distinct', 'ratio', 'copies', 'medLen', 'saveKB', 'rec', 'now'];
    const widths = [28, 7, 8, 6, 7, 7, 7, 10, 4];
    console.log(fmtRow(headers, widths));
    for (const [field, s] of Object.entries(fields)) {
      if (s.total === 0) continue;
      console.log(
        fmtRow(
          [
            field,
            s.total,
            s.distinct,
            s.distinctRatio,
            s.avgCopies,
            s.medianLen,
            s.savedKbEst,
            s.recommendation,
            s.currentlyInterned ? 'yes' : ''
          ],
          widths
        )
      );
    }
    const rec = report.recommended[type];
    if (rec.intern.length) console.log(`  → candidats intern: ${rec.intern.join(', ')}`);
    if (rec.removeFromCurrent.length) {
      console.log(`  → retirer de l'interning actuel: ${rec.removeFromCurrent.join(', ')}`);
    }
    console.log('');
  }

  console.log('=== Synthèse recommandée (union par type) ===');
  for (const [type, rec] of Object.entries(report.recommended)) {
    const merged = [...new Set([...(BDPM_LOW_CARDINALITY_FIELDS[type] || []), ...rec.intern])].filter(
      (f) => !rec.removeFromCurrent.includes(f)
    );
    console.log(`${type}: [${merged.map((x) => `'${x}'`).join(', ')}]`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
