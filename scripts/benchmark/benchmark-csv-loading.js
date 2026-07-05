#!/usr/bin/env node
'use strict';

/**
 * Compare le chargement BDPM actuel (`csv-parse` avec columns) à une variante
 * expérimentale `columns:false` + construction depuis tableaux.
 *
 * Ce script n'est pas un chemin runtime. Il sert de garde-fou avant toute
 * décision de réécrire le loader CSV.
 *
 * Usage:
 *   LOAD_HAS_AVIS=false LOAD_MITM=false CORPUS_LIGHT_PROFILE=true node --expose-gc scripts/benchmark/benchmark-csv-loading.js
 *   CSV_BENCH_RUNS=3 node --expose-gc scripts/benchmark/benchmark-csv-loading.js
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RUNS = parseInt(process.env.CSV_BENCH_RUNS || '5', 10);
const VARIANTS = ['current', 'array'];

function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarize(rows, key) {
  const values = rows.map((r) => r[key]);
  return {
    min: Math.min(...values),
    median: median(values),
    max: Math.max(...values)
  };
}

function runWorker(variant) {
  const res = spawnSync(process.execPath, ['--expose-gc', __filename, '--worker', variant], {
    cwd: path.resolve(__dirname, '../..'),
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });

  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || '').slice(-2000));
  }
  const line = (res.stdout || '').split('\n').find((l) => l.startsWith('__CSV_BENCH__'));
  if (!line) throw new Error(`marker missing for ${variant}: ${(res.stdout || '').slice(-500)}`);
  return JSON.parse(line.slice('__CSV_BENCH__'.length));
}

function printSummary(all) {
  console.log(`CSV benchmark (${RUNS} runs par variante)`);
  console.log(
    `env: LOAD_HAS_AVIS=${process.env.LOAD_HAS_AVIS !== 'false'} LOAD_MITM=${process.env.LOAD_MITM !== 'false'} CORPUS_LIGHT_PROFILE=${process.env.CORPUS_LIGHT_PROFILE === 'true'}`
  );
  console.log('');
  console.log('variant   runs  ms med  peakHeap med  peakRSS med  postHeap med  postRSS med');
  console.log('----------------------------------------------------------------------');
  for (const variant of VARIANTS) {
    const rows = all[variant];
    const ms = summarize(rows, 'ms');
    const peakHeap = summarize(rows, 'peakHeapMb');
    const peakRss = summarize(rows, 'peakRssMb');
    const postHeap = summarize(rows, 'postHeapMb');
    const postRss = summarize(rows, 'postRssMb');
    console.log(
      `${variant.padEnd(9)} ${String(rows.length).padStart(4)}  ${String(ms.median).padStart(6)}  ${String(peakHeap.median).padStart(12)}  ${String(peakRss.median).padStart(11)}  ${String(postHeap.median).padStart(12)}  ${String(postRss.median).padStart(11)}`
    );
  }
}

async function worker(variant) {
  const { parse } = require('csv-parse');
  const { BDPM_SCHEMAS } = require('../../src/utils/corpusSchemas');
  const { FROM_CSV, BDPM_RECORD_CLASSES, Substance } = require('../../src/models/bdpm');
  const { omitStoredFieldsFor } = require('../../src/utils/corpusLightProfile');
  const { lowCardinalityFieldsFor } = require('../../src/utils/bdpmInterning');
  const { intern } = require('../../src/utils/stringPool');
  const { BDPM_INDEX_SPECS } = require('../../src/search/indexSpecs');
  const { miniSearchIndexConfig } = require('../../src/utils/miniSearchIndexConfig');
  const { buildFrozenIndexFromAsyncIterable, buildFrozenIndexFromRows } = require('../../src/utils/frozenMiniSearch');
  const { buildIndexDocument, buildKeyIndex } = require('../../src/utils/corpusStore');
  const config = require('../../src/config');

  const activeTypes = ['specialites', 'presentations', 'compositions'];
  if (config.loadHasAvis) activeTypes.push('avis_smr', 'avis_asmr');
  activeTypes.push('generiques', 'conditions', 'ruptures');
  if (config.loadMitm) activeTypes.push('mitm');

  const arrayCache = new Map();
  function fromCsvArray(type, values) {
    let cached = arrayCache.get(type);
    if (!cached) {
      const fields = BDPM_SCHEMAS[type];
      cached = {
        Cls: BDPM_RECORD_CLASSES[type],
        fields,
        omit: new Set(omitStoredFieldsFor(type)),
        lowCard: new Set(lowCardinalityFieldsFor(type))
      };
      arrayCache.set(type, cached);
    }

    const args = new Array(cached.fields.length);
    for (let i = 0; i < cached.fields.length; i++) {
      const field = cached.fields[i];
      let value = values[i];
      if (cached.omit.has(field)) value = '';
      args[i] = cached.lowCard.has(field) ? intern(value) : value;
    }
    return new cached.Cls(...args);
  }

  const corpus = {};
  const indexes = {};
  let peakHeap = 0;
  let peakRss = 0;
  const tick = setInterval(() => {
    const m = process.memoryUsage();
    if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
    if (m.rss > peakRss) peakRss = m.rss;
  }, 5);

  const started = Date.now();
  for (const type of activeTypes) {
    const spec = BDPM_INDEX_SPECS[type];
    const rows = [];
    corpus[type] = rows;
    const parserOptions = {
      delimiter: '\t',
      columns: variant === 'array' ? false : BDPM_SCHEMAS[type],
      skip_empty_lines: true,
      trim: true,
      quote: false,
      escape: false,
      relax_quotes: true,
      relax_column_count: true
    };

    async function* documents() {
      const parser = fs
        .createReadStream(path.join(config.dataDir, spec.file), { encoding: 'utf8' })
        .pipe(parse(parserOptions));
      let rowIndex = 0;
      for await (const record of parser) {
        const row = variant === 'array' ? fromCsvArray(type, record) : FROM_CSV[type](record);
        rows.push(row);
        yield buildIndexDocument(row, rowIndex, spec.fields);
        rowIndex++;
      }
    }

    indexes[type] = await buildFrozenIndexFromAsyncIterable(
      documents(),
      miniSearchIndexConfig(spec.fields, spec.boost)
    );
  }

  const substances = new Map();
  for (const comp of corpus.compositions) {
    if (!comp.code_substance || !comp.denomination_substance) continue;
    if (!substances.has(comp.code_substance)) {
      substances.set(comp.code_substance, new Substance(comp.code_substance, comp.denomination_substance, 0));
    }
    substances.get(comp.code_substance).medicaments_count++;
  }
  corpus.substances = [...substances.values()];
  const subSpec = BDPM_INDEX_SPECS.substances;
  indexes.substances = buildFrozenIndexFromRows(
    corpus.substances,
    (row, rowIndex) => buildIndexDocument(row, rowIndex, subSpec.fields),
    miniSearchIndexConfig(subSpec.fields, subSpec.boost)
  );

  buildKeyIndex(corpus.specialites, 'cis', { unique: true });
  buildKeyIndex(corpus.presentations, 'cis');
  buildKeyIndex(corpus.compositions, 'cis');
  buildKeyIndex(corpus.conditions, 'cis');
  buildKeyIndex(corpus.generiques, 'cis');

  clearInterval(tick);
  if (global.gc) global.gc();
  const m = process.memoryUsage();
  process.stdout.write(
    `__CSV_BENCH__${JSON.stringify({
      variant,
      ms: Date.now() - started,
      peakHeapMb: mb(peakHeap),
      peakRssMb: mb(peakRss),
      postHeapMb: mb(m.heapUsed),
      postRssMb: mb(m.rss)
    })}\n`
  );
}

async function main() {
  const workerIndex = process.argv.indexOf('--worker');
  if (workerIndex !== -1) {
    await worker(process.argv[workerIndex + 1]);
    return;
  }

  const all = Object.fromEntries(VARIANTS.map((v) => [v, []]));
  for (const variant of VARIANTS) {
    for (let i = 0; i < RUNS; i++) {
      const result = runWorker(variant);
      all[variant].push(result);
      console.log(`${variant} run ${i + 1}: ${JSON.stringify(result)}`);
    }
  }
  console.log('');
  printSummary(all);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
