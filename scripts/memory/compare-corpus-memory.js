#!/usr/bin/env node
/**
 * Mesure RSS / heap après chargement BDPM (+ vétérinaire si --vet).
 * Comparer avec la branche/tag v1.2.0 (tuples) :
 *   git stash && git checkout v1.2.0 && node --expose-gc scripts/memory/compare-corpus-memory.js --label=tuple
 *   git checkout - && git stash pop && node --expose-gc scripts/memory/compare-corpus-memory.js --label=classes
 *
 * Usage: node --expose-gc scripts/memory/compare-corpus-memory.js [--vet] [--label=classes]
 */
'use strict';

function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 1000) / 1000;
}

function parseArgs(argv) {
  const out = { vet: false, label: 'current' };
  for (const arg of argv) {
    if (arg === '--vet') out.vet = true;
    else if (arg.startsWith('--label=')) out.label = arg.slice('--label='.length);
  }
  return out;
}

async function main() {
  const { vet, label } = parseArgs(process.argv.slice(2));
  const { loadData, getBdpmCorpusStats } = require('../../src/services/dataLoader');

  if (typeof global.gc !== 'function') {
    console.warn('Recommandé: node --expose-gc pour des mesures stables');
  } else {
    global.gc();
  }
  const before = process.memoryUsage();

  await loadData();
  let vetStats = null;
  if (vet) {
    const { loadVetData, getVetCorpusStats } = require('../../src/services/vetDataLoader');
    await loadVetData();
    vetStats = getVetCorpusStats();
  }

  if (typeof global.gc === 'function') global.gc();
  const after = process.memoryUsage();
  const bdpm = getBdpmCorpusStats();

  let bdpmRows = 0;
  for (const info of Object.values(bdpm.byType)) {
    bdpmRows += info.rows;
  }

  const report = {
    label,
    storage: 'classes (corpusStore + record classes)',
    rss_mb: mb(after.rss),
    heapUsed_mb: mb(after.heapUsed),
    heap_delta_mb: mb(after.heapUsed - before.heapUsed),
    bdpm_rows_total: bdpmRows,
    vet: vet
      ? {
          medicaments: vetStats.byType.medicaments.rows,
          compositions: vetStats.byType.compositions.rows,
          presentations: vetStats.byType.presentations.rows
        }
      : null,
    criterion:
      'Succès si RSS classes ≤ RSS tuples (tag v1.2.0) ou régression ≤ 3 Mo documentée dans CHANGELOG'
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
