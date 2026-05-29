#!/usr/bin/env node
/**
 * Taille du corpus BDPM (corpusStores tuple + proxy JSON matérialisé).
 * Usage: node scripts/analyze-bdpm-corpus-size.js
 */
'use strict';

function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 1000) / 1000;
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function tupleStoreBytes(store) {
  let n = Buffer.byteLength(JSON.stringify(store.keys), 'utf8');
  for (const row of store.rows) {
    for (const cell of row) {
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

function materializedPageJsonBytes(store, pageSize = 100) {
  const end = Math.min(pageSize, store.rows.length);
  let n = 0;
  for (let i = 0; i < end; i++) {
    const row = store.rows[i];
    const obj = {};
    for (let j = 0; j < store.keys.length; j++) {
      const v = row[j];
      if (v == null || v === '') continue;
      obj[store.keys[j]] = v;
    }
    n += jsonBytes(obj);
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

  const { byType, stores } = getBdpmCorpusStats();
  let tupleTotal = 0;
  let jsonSampleTotal = 0;

  for (const [type, info] of Object.entries(byType)) {
    const store = stores[type];
    const tupleBytes = tupleStoreBytes(store);
    const sample = materializedPageJsonBytes(store);
    tupleTotal += tupleBytes;
    jsonSampleTotal += sample.bytes;
    byType[type] = {
      rows: info.rows,
      tuple_mb: mb(tupleBytes),
      json_sample_first_page_mb: mb(sample.bytes),
      json_sample_rows: sample.sampleRows
    };
  }

  console.log('=== corpusStores BDPM (tuple vs échantillon 1 page JSON) ===');
  console.log(
    JSON.stringify(
      {
        tuple_total_mb: mb(tupleTotal),
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
