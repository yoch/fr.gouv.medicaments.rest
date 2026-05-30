#!/usr/bin/env node
/**
 * Taille du corpus BDPM (instances classe + proxy JSON matérialisé).
 * Usage: node scripts/analyze-bdpm-corpus-size.js
 */
'use strict';

const { BDPM_SCHEMAS } = require('../src/utils/corpusSchemas');

function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 1000) / 1000;
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function instanceCorpusBytes(corpus, fieldNames) {
  let n = 0;
  for (const inst of corpus) {
    for (const field of fieldNames) {
      const cell = inst[field];
      if (cell == null || cell === '') continue;
      if (Array.isArray(cell)) {
        n += jsonBytes(cell);
      } else if (typeof cell === 'number') {
        n += 8;
      } else {
        n += Buffer.byteLength(String(cell), 'utf8');
      }
    }
  }
  return n;
}

function materializedPageJsonBytes(corpus, pageSize = 100) {
  const end = Math.min(pageSize, corpus.length);
  let n = 0;
  for (let i = 0; i < end; i++) {
    n += jsonBytes(corpus[i].toJSON());
  }
  return { sampleRows: end, bytes: n };
}

async function main() {
  const { loadData, getBdpmCorpusStats } = require('../src/services/dataLoader');

  if (typeof global.gc === 'function') global.gc();
  const memBefore = process.memoryUsage();

  await loadData();

  if (typeof global.gc === 'function') global.gc();
  const memAfter = process.memoryUsage();

  const { byType, corpus: stores } = getBdpmCorpusStats();
  let instanceTotal = 0;
  let jsonSampleTotal = 0;

  for (const [type, info] of Object.entries(byType)) {
    const rows = stores[type];
    const fields = BDPM_SCHEMAS[type];
    const instanceBytes = instanceCorpusBytes(rows, fields);
    const sample = materializedPageJsonBytes(rows);
    instanceTotal += instanceBytes;
    jsonSampleTotal += sample.bytes;
    byType[type] = {
      rows: info.rows,
      instance_fields_mb: mb(instanceBytes),
      json_sample_first_page_mb: mb(sample.bytes),
      json_sample_rows: sample.sampleRows
    };
  }

  console.log('=== corpus BDPM (instances vs échantillon 1 page JSON) ===');
  console.log(
    JSON.stringify(
      {
        instance_fields_total_mb: mb(instanceTotal),
        json_first_page_sample_total_mb: mb(jsonSampleTotal),
        heap_delta_mb: mb(memAfter.heapUsed - memBefore.heapUsed),
        rss_mb: mb(memAfter.rss),
        by_type: byType
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
