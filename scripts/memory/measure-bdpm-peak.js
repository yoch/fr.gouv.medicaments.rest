#!/usr/bin/env node
/**
 * Chargeur BDPM minimal pour mesure de pic mémoire via --trace-gc.
 * À lancer avec: node --expose-gc --max-semi-space-size=N --trace-gc scripts/measure-bdpm-peak.js
 *
 * N'appelle PAS global.gc() (sauf optionnel à la fin) pour que les logs --trace-gc
 * ne contiennent que les GC naturels de V8 pendant le load — le pic est le max
 * des heaps "avant GC" reportés par V8, capture exacte pas un échantillon.
 */
'use strict';

const { loadData } = require('../../src/services/dataLoader');
const {
  createMemorySampler,
  installLoadMemoryMarks,
  uninstallLoadMemoryMarks
} = require('../../src/utils/memorySampler');

const forceGcAtEnd = process.argv.includes('--gc-at-end');

(async () => {
  const sampler = createMemorySampler({ intervalMs: 50 });
  installLoadMemoryMarks(sampler);
  sampler.start();
  await loadData();
  sampler.stop();
  uninstallLoadMemoryMarks();

  if (forceGcAtEnd && global.gc) {
    global.gc();
  }

  // Marqueur de fin (stdout, séparé du log --trace-gc sur stderr).
  process.stdout.write('__LOAD_DONE__\n');
  // NE PAS appeler process.exit() : ça tuerait le process avant le flush du buffer
  // stderr de V8 (--trace-gc). On laisse l'event loop se vider naturellement.
})().catch((err) => {
  console.error('LOAD_ERROR', err);
  process.exit(1);
});
