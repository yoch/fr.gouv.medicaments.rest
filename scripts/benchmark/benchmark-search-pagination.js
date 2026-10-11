'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { loadData } = require('../../src/services/dataLoader');
const state = require('../../src/services/bdpm/state');
const { BDPM_INDEX_SPECS } = require('../../src/search/indexSpecs');
const { rankSearchResults, searchRankedPage } = require('../../src/utils/corpusSearch');
const { parseListPaging } = require('../../src/utils/corpusPaging');

const RUNS = 5;
const WARMUP = 50;
const ITERATIONS = 50;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function measure(job) {
  for (let i = 0; i < WARMUP; i++) job();
  global.gc?.();
  const times = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    job();
    times.push(performance.now() - start);
  }
  return median(times);
}

async function main() {
  await loadData();
  const results = [];
  for (const [type, query, page, limit] of [
    ['specialites', 'comprime', 1, 20],
    ['specialites', 'comprime', 2, 20],
    ['specialites', 'comprime', 1, 100],
    ['specialites', 'comprime', 1, 1000],
    ['specialites', 'doliprane', 1, 20],
    ['specialites', 'dolipranr', 1, 20],
    ['specialites', 'amoxicilline', 1, 20],
    ['presentations', 'plaquette', 1, 20],
    ['compositions', 'paracetamol', 1, 20],
  ]) {
    const corpus = state.corpus[type];
    const index = state.searchIndexes[type];
    const spec = BDPM_INDEX_SPECS[type];
    const { offset, safeLimit } = parseListPaging(page, limit);
    const jobs = {
      full: () => {
        const all = rankSearchResults(corpus, index.search(query), query, spec);
        return { total: all.length, ranked: all.slice(offset, offset + safeLimit) };
      },
      bounded: () => searchRankedPage(corpus, index, query, spec, page, limit),
    };
    const expected = jobs.full();
    assert.deepEqual(jobs.bounded(), expected);
    assert.deepEqual(searchRankedPage(corpus, index, query.toUpperCase(), spec, page, limit), expected);
    let upperCase = false;
    // Alternating equivalent query casing forces cache misses on the actual
    // FrozenMiniSearch instance, without timing a proxy or rebuilding the index.
    jobs.cold = () => {
      upperCase = !upperCase;
      return searchRankedPage(corpus, index,
        upperCase ? query.toUpperCase() : query.toLowerCase(), spec, page, limit);
    };
    const samples = { full: [], bounded: [], cold: [] };
    for (let run = 0; run < RUNS; run++) {
      const modes = ['full', 'bounded', 'cold'];
      for (let i = 0; i < modes.length; i++) {
        const mode = modes[(i + run) % modes.length];
        samples[mode].push(measure(jobs[mode]));
      }
    }
    const fullMs = median(samples.full);
    const boundedMs = median(samples.bounded);
    const coldMs = median(samples.cold);
    const result = { type, query, page, limit, corpusRows: corpus.length, total: expected.total,
      fullMs, boundedMs, coldMs,
      changePercent: 100 * (boundedMs / fullMs - 1) };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  const libraryPackage = path.resolve(path.dirname(require.resolve('@yoch/frozenminisearch')), '../../package.json');
  console.log(JSON.stringify({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model,
    frozenMiniSearch: JSON.parse(fs.readFileSync(libraryPackage, 'utf8')).version,
    runs: RUNS, warmup: WARMUP, iterations: ITERATIONS, results
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
