#!/usr/bin/env node
/**
 * Prend un heap snapshot du chargement BDPM.
 *
 * Deux modes :
 *  - mode "peak" (défaut) : lancer avec --max-old-space-size=120 --heapsnapshot-near-heap-limit=2
 *    Le load OOM près du pic (~120 Mo), V8 dump un .heapsnapshot au high-water mark.
 *    Le process crash mais le snapshot est écrit. Capture le VRAI transient mid-load.
 *  - mode "post-load" : lancer sans flags spéciaux. loadData() termine, on prend
 *    un snapshot avant gc puis un après gc. Capture l'état de fin de load.
 *
 * Usage:
 *   node --max-old-space-size=120 --heapsnapshot-near-heap-limit=2 scripts/heap-snapshot-bdpm.js peak
 *   node --expose-gc scripts/memory/heap-snapshot-bdpm.js postload
 */
'use strict';

const v8 = require('v8');
const path = require('path');
const { loadData } = require('../../src/services/dataLoader');

const mode = process.argv[2] || 'peak';
const OUT = path.join(__dirname, '..', '..', 'bdpm.heapsnapshot');

function snap(tag) {
  const file = path.join(__dirname, '..', '..', `bdpm-${tag}.heapsnapshot`);
  const t0 = Date.now();
  v8.writeHeapSnapshot(file);
  console.log(`[snapshot] ${tag} écrit: ${path.basename(file)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return file;
}

(async () => {
  if (mode === 'postload') {
    console.log('[mode postload] loadData()...');
    await loadData();
    console.log('[mode postload] loadData OK — snapshot avant gc');
    const memBefore = process.memoryUsage();
    console.log(`  heapUsed avant gc: ${(memBefore.heapUsed / 1048576).toFixed(1)} Mo`);
    snap('postload-nogc');
    if (global.gc) {
      global.gc();
      const memAfter = process.memoryUsage();
      console.log(`  heapUsed après gc: ${(memAfter.heapUsed / 1048576).toFixed(1)} Mo`);
      snap('postload-gc');
    } else {
      console.log('  (pas de --expose-gc, skip snapshot post-gc)');
    }
  } else {
    // mode peak : on charge, V8 OOM près du pic et dump un snapshot via le flag
    console.log('[mode peak] loadData() — V8 doit OOM près du pic et dump un .heapsnapshot');
    await loadData();
    // Si on arrive ici sans OOM, le seuil --max-old-space-size était trop haut.
    // On prend quand même un snapshot de fin.
    console.log('[mode peak] loadData terminé SANS OOM (seuil trop haut) — snapshot de fin');
    snap('peak-end');
  }
  console.log('done');
  process.exit(0);
})().catch((err) => {
  console.error('FATAL', err && err.message);
  // En mode peak, le OOM crash avant ce catch ; mais si on arrive ici, exit non-zéro.
  process.exit(1);
});
