#!/usr/bin/env node
/**
 * Chargeur vet minimal pour mesure de pic mémoire via --trace-gc.
 * node --expose-gc --trace-gc scripts/measure-vet-peak.js
 *
 * Pas de global.gc() : le pic = max des heaps "avant GC" reportés par V8.
 */
'use strict';

const { loadVetData } = require('../../src/services/vetDataLoader');

let rssPeak = 0;
let heapPeak = 0;
const tick = setInterval(() => {
  const m = process.memoryUsage();
  if (m.rss > rssPeak) rssPeak = m.rss;
  if (m.heapUsed > heapPeak) heapPeak = m.heapUsed;
}, 10);

(async () => {
  await loadVetData();
  clearInterval(tick);
  const m = process.memoryUsage();
  if (m.rss > rssPeak) rssPeak = m.rss;
  if (m.heapUsed > heapPeak) heapPeak = m.heapUsed;
  process.stdout.write(`__RSS_PEAK__${Math.round(rssPeak / 1048576)}\n`);
  process.stdout.write(`__HEAP_PEAK__${Math.round(heapPeak / 1048576)}\n`);
  process.stdout.write('__LOAD_DONE__\n');
})().catch((err) => {
  console.error('LOAD_ERROR', err && err.message);
  process.exit(1);
});
