#!/usr/bin/env node
/**
 * Prend un heap snapshot du chargement vet (postload + gc).
 * Usage: node --expose-gc scripts/memory/heap-snapshot-vet.js
 */
'use strict';

const v8 = require('v8');
const path = require('path');
const { loadVetData } = require('../../src/services/vetDataLoader');

(async () => {
  console.log('[vet] loadVetData()...');
  await loadVetData();
  console.log('[vet] loadVetData OK');
  const memBefore = process.memoryUsage();
  console.log(`  heapUsed avant gc: ${(memBefore.heapUsed / 1048576).toFixed(1)} Mo`);
  v8.writeHeapSnapshot(path.join(__dirname, '..', '..', 'vet-postload-nogc.heapsnapshot'));
  console.log('  snapshot nogc écrit');
  if (global.gc) {
    global.gc();
    const memAfter = process.memoryUsage();
    console.log(`  heapUsed après gc: ${(memAfter.heapUsed / 1048576).toFixed(1)} Mo`);
    v8.writeHeapSnapshot(path.join(__dirname, '..', '..', 'vet-postload-gc.heapsnapshot'));
    console.log('  snapshot gc écrit');
  }
  process.exit(0);
})().catch((err) => {
  console.error('FATAL', err && err.message);
  process.exit(1);
});
