#!/usr/bin/env node
/**
 * Profil mémoire du chargement BDPM : sampler par phase + empreinte résidente
 * des index frozen (primitives 1.6+). Usage: node --expose-gc scripts/analyze-bdpm-cache-size.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  createMemorySampler,
  installLoadMemoryMarks,
  uninstallLoadMemoryMarks
} = require('../src/utils/memorySampler');

function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 1000) / 1000;
}

function kb(bytes) {
  return Math.round((bytes / 1024) * 1000) / 1000;
}

function formatBytes(b) {
  if (b == null) return 'n/a';
  return `${kb(b)} Ko (${mb(b)} Mo)`;
}

function frozenBreakdown(idx) {
  if (!idx) return null;
  const termIndex = idx._index;
  const postings = idx._postings;
  const radixBytes = typeof termIndex?.packedByteLength === 'function'
    ? termIndex.packedByteLength()
    : null;
  let postingsBytes = null;
  if (postings) {
    postingsBytes = (postings.allDocIds?.byteLength || 0)
      + (postings.allFreqs?.byteLength || 0);
    if (postings.layout === 'dense') {
      postingsBytes += (postings.denseOffsets?.byteLength || 0)
        + (postings.denseLengths?.byteLength || 0);
    } else if (postings.layout === 'sparse') {
      postingsBytes += (postings.sparseTermStarts?.byteLength || 0)
        + (postings.sparseFieldIds?.byteLength || 0)
        + (postings.sparseOffsets?.byteLength || 0)
        + (postings.sparseLengths?.byteLength || 0);
    }
  }
  const fieldLengthBytes = idx._fieldLengthMatrix?.byteLength || null;
  const avgFieldLengthBytes = idx._avgFieldLength?.byteLength || null;
  let binarySnapshotBytes = null;
  try {
    if (typeof idx.saveBinarySync === 'function') {
      binarySnapshotBytes = idx.saveBinarySync().length;
    }
  } catch {
    binarySnapshotBytes = null;
  }
  const structuredBytes = (radixBytes || 0)
    + (postingsBytes || 0)
    + (fieldLengthBytes || 0)
    + (avgFieldLengthBytes || 0);
  return {
    documentCount: idx.documentCount,
    termCount: idx.termCount,
    radixBytes,
    postingsBytes,
    fieldLengthBytes,
    structuredBytes,
    binarySnapshotBytes
  };
}

async function main() {
  const DATA_DIR = path.join(__dirname, '..', 'data');
  const files = {
    CIS_bdpm: mb(fs.statSync(path.join(DATA_DIR, 'CIS_bdpm.txt')).size),
    CIS_CIP: mb(fs.statSync(path.join(DATA_DIR, 'CIS_CIP_bdpm.txt')).size),
    CIS_COMPO: mb(fs.statSync(path.join(DATA_DIR, 'CIS_COMPO_bdpm.txt')).size),
    CIS_HAS_SMR: mb(fs.statSync(path.join(DATA_DIR, 'CIS_HAS_SMR_bdpm.txt')).size),
    CIS_HAS_ASMR: mb(fs.statSync(path.join(DATA_DIR, 'CIS_HAS_ASMR_bdpm.txt')).size),
    CIS_GENER: mb(fs.statSync(path.join(DATA_DIR, 'CIS_GENER_bdpm.txt')).size),
    CIS_CPD: mb(fs.statSync(path.join(DATA_DIR, 'CIS_CPD_bdpm.txt')).size),
    CIS_CIP_Dispo: mb(fs.statSync(path.join(DATA_DIR, 'CIS_CIP_Dispo_Spec.txt')).size),
    CIS_MITM: mb(fs.statSync(path.join(DATA_DIR, 'CIS_MITM.txt')).size)
  };
  console.log('=== Fichiers BDPM sur disque (Mo) ===');
  console.log(JSON.stringify(files, null, 2));

  const { loadData, getBdpmCorpusStats, getBdpmSearchIndexes } = require('../src/services/dataLoader');
  const { rowCount } = require('../src/utils/corpusStore');

  if (typeof global.gc === 'function') global.gc();
  const memBefore = process.memoryUsage();

  const sampler = createMemorySampler({ intervalMs: 100 });
  installLoadMemoryMarks(sampler);
  sampler.start();

  await loadData();

  sampler.stop();
  uninstallLoadMemoryMarks();

  if (typeof global.gc === 'function') global.gc();
  const memAfter = process.memoryUsage();

  const marks = sampler.getMarks();
  const samples = sampler.getSamples();

  console.log('\n=== Pic mémoire par phase BDPM (sampler 100 ms, sans GC) ===');
  console.log(
    `  phase                              t_ms    peak_heap_mb   peak_rss_mb   delta_heap_mb`
  );
  let prevHeapMb = mb(memBefore.heapUsed);
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    const next = marks[i + 1];
    const tEnd = next ? next.t_ms : m.t_ms + 200;
    const peak = sampler.peakInWindow(m.t_ms, tEnd);
    const peakHeapMb = peak.heapUsed_mb || 0;
    const peakRssMb = peak.rss_mb || 0;
    const delta = peakHeapMb - prevHeapMb;
    const phaseLabel = (m.phase || '(sample)').padEnd(34);
    console.log(
      `  ${phaseLabel} ${String(m.t_ms).padStart(6)}   ${String(peakHeapMb).padStart(12)}   ${String(peakRssMb).padStart(11)}   ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`
    );
    prevHeapMb = peakHeapMb;
  }

  let peakHeap = 0;
  let peakRss = 0;
  let peakPhase = null;
  for (const s of samples) {
    if (s.heapUsed_mb > peakHeap) {
      peakHeap = s.heapUsed_mb;
      peakRss = s.rss_mb;
      peakPhase = s.phase || null;
    }
  }
  console.log(
    `\n  PIC GLOBAL : heap=${peakHeap} Mo rss=${peakRss} Mo${peakPhase ? ` (@${peakPhase})` : ''}`
  );

  const { byType } = getBdpmCorpusStats();
  const searchIndexes = getBdpmSearchIndexes();

  console.log('\n=== Corpus BDPM (lignes) ===');
  for (const [type, stats] of Object.entries(byType)) {
    console.log(`  ${type.padEnd(16)} ${stats.rows} lignes`);
  }

  console.log('\n=== Index frozen résidents (primitives 1.6+) ===');
  let totalSnapshot = 0;
  let totalStructured = 0;
  for (const type of Object.keys(searchIndexes)) {
    const b = frozenBreakdown(searchIndexes[type]);
    if (!b) {
      console.log(`  ${type}: non construit`);
      continue;
    }
    totalSnapshot += b.binarySnapshotBytes || 0;
    totalStructured += b.structuredBytes || 0;
    console.log(
      `  ${type.padEnd(16)} docs=${String(b.documentCount).padStart(6)} terms=${String(b.termCount).padStart(6)} structured=${formatBytes(b.structuredBytes)} snapshot=${formatBytes(b.binarySnapshotBytes)}`
    );
  }
  console.log(`  ${'TOTAL'.padEnd(16)} structured=${formatBytes(totalStructured)} snapshot=${formatBytes(totalSnapshot)}`);

  console.log('\n=== Synthèse pic build vs résident ===');
  console.log(`  pic heap pendant loadData      : ${peakHeap} Mo${peakPhase ? ` (@${peakPhase})` : ''}`);
  console.log(`  heap résident après GC         : ${mb(memAfter.heapUsed)} Mo`);
  console.log(`  surcoût transitoire (pic - résident) : ~${Math.max(0, peakHeap - mb(memAfter.heapUsed)).toFixed(2)} Mo`);
  console.log(`  index frozen total — snapshot binaire : ${mb(totalSnapshot)} Mo`);
  console.log(`  index frozen total — structured       : ${mb(totalStructured)} Mo`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
