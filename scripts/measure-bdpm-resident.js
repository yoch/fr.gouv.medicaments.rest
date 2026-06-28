#!/usr/bin/env node
/**
 * Chargeur BDPM minimal pour mesure résident (heap + RSS) après gc.
 * node --expose-gc scripts/measure-bdpm-resident.js
 */
'use strict';

const { loadData } = require('../src/services/dataLoader');
const { internPoolSize } = require('../src/utils/stringPool');

(async () => {
  await loadData();
  if (global.gc) global.gc();
  const m = process.memoryUsage();
  process.stdout.write(`__HEAP__${Math.round(m.heapUsed / 1048576)}\n`);
  process.stdout.write(`__RSS__${Math.round(m.rss / 1048576)}\n`);
  process.stdout.write(`__POOL__${internPoolSize()}\n`);
  process.stdout.write(`__LOAD_DONE__\n`);
})().catch((err) => {
  console.error('LOAD_ERROR', err && err.message);
  process.exit(1);
});
