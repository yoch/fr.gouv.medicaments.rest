'use strict';

/**
 * Mesure isolée par sous-processus (`node --expose-gc`) de la latence de build,
 * des tailles binaires et de l'empreinte mémoire (RSS, heapUsed, external, arrayBuffers,
 * maxRSS) sans contamination croisée entre variantes B0 / B2 / FXV1 (Float32, Int8, PQ32, PQ16).
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const { loadData } = require('../../../../src/services/dataLoader');
const { loadVetData } = require('../../../../src/services/vetDataLoader');
const bdpmState = require('../../../../src/services/bdpm/state');
const vetState = require('../../../../src/services/vet/state');
const { BDPM_INDEX_SPECS, VET_INDEX_SPECS } = require('../../../../src/search/indexSpecs');
const { miniSearchIndexConfig } = require('../../../../src/utils/miniSearchIndexConfig');
const { buildIndexDocument } = require('../../../../src/utils/corpusStore');
const { getConceptStore, resetConceptStoreCache } = require('../../../../src/search/conceptStore');
const { buildControlledDocuments, loadStaticWordPieceEncoder } = require('./b3_encoders');

const PKG_VERIFY_ROOT =
  process.env.FROZENMINISEARCH_PKG_ROOT ||
  '/home/yoch/.gemini/antigravity-cli/brain/94228641-cb35-4e73-bd50-3e5b84af2042/scratch/pkg-verify';
const pkgRequire = createRequire(path.join(PKG_VERIFY_ROOT, 'consumer.js'));
const MODEL_DIR = path.join(
  __dirname,
  '../../../../data/search-indexes/mission-semantic'
);

function computeCorpusSnapshotId(prefix, rows, labelField, weightPath, metaPath) {
  const h = crypto.createHash('sha256');
  h.update(`${prefix}:${rows.length}:`);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    h.update(`${r.cis || r.num || ''}|${r[labelField] || ''}\n`);
  }
  h.update(fs.readFileSync(metaPath));
  h.update(fs.readFileSync(weightPath));
  return `sha256:${h.digest('hex').slice(0, 24)}`;
}

function round(v, digits = 2) {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

function forceGc() {
  if (typeof global.gc === 'function') {
    global.gc();
    global.gc();
  }
}

function snapshotMem() {
  forceGc();
  const m = process.memoryUsage();
  const ru = process.resourceUsage();
  const toMb = (b) => round(b / (1024 * 1024), 2);
  // Note Node.js : memoryUsage().external inclut déjà arrayBuffers.
  return {
    rssMiB: toMb(m.rss),
    heapUsedMiB: toMb(m.heapUsed),
    heapTotalMiB: toMb(m.heapTotal),
    externalMiB: toMb(m.external),
    arrayBuffersMiB: toMb(m.arrayBuffers || 0),
    v8HeapPlusExternalNoDoubleCountMiB: toMb(m.heapUsed + m.external),
    peakRssMiB: toMb(ru.maxRSS * 1024)
  };
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function buildHostFromRows(FrozenMiniSearch, rows, spec) {
  const opts = miniSearchIndexConfig(spec.fields, spec.boost);
  const docs = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    docs[i] = buildIndexDocument(rows[i], i, spec.fields);
  }
  return FrozenMiniSearch.fromDocuments(docs, opts);
}

async function runVariant(variant) {
  const tStart = process.hrtime.bigint();
  const tLex0 = process.hrtime.bigint();
  await loadData();
  await loadVetData();
  const lexicalLoadMs = round(Number(process.hrtime.bigint() - tLex0) / 1e6, 2);
  const memAfterB0 = snapshotMem();

  if (variant === 'B0') {
    return { variant, lexicalLoadMs, memAfterB0, peakRssMiB: memAfterB0.peakRssMiB };
  }

  resetConceptStoreCache();
  const tB20 = process.hrtime.bigint();
  getConceptStore();
  const conceptBuildMs = round(Number(process.hrtime.bigint() - tB20) / 1e6, 2);
  const memAfterB2 = snapshotMem();

  if (variant === 'B2') {
    return {
      variant,
      lexicalLoadMs,
      conceptBuildMs,
      memAfterB0,
      memAfterB2,
      peakRssMiB: memAfterB2.peakRssMiB
    };
  }

  const { FrozenMiniSearch } = pkgRequire('@yoch/frozenminisearch');
  const { FrozenVectorIndex } = pkgRequire('@yoch/frozenminisearch/vectors');
  const { encodeDenseVectorPack } = pkgRequire('@yoch/frozenminisearch/vectors/train');
  const tHost0 = process.hrtime.bigint();
  const bdpmHost = buildHostFromRows(
    FrozenMiniSearch,
    bdpmState.corpus.specialites,
    BDPM_INDEX_SPECS.specialites
  );
  const vetHost = buildHostFromRows(
    FrozenMiniSearch,
    vetState.corpus.medicaments,
    VET_INDEX_SPECS.medicaments
  );
  const host113BuildMs = round(Number(process.hrtime.bigint() - tHost0) / 1e6, 2);
  const memAfterHost113 = snapshotMem();

  const useF32Encoder = variant === 'FXV1_Float32';
  const enc = loadStaticWordPieceEncoder(128, { useF32: useF32Encoder });
  const metaPath = path.join(MODEL_DIR, 'static_mrl_128d.meta.json');
  const weightPath = path.join(
    MODEL_DIR,
    useF32Encoder ? 'static_mrl_128d_f32.bin' : 'static_mrl_128d_int8.bin'
  );
  const vocabMetaBytes = fs.statSync(metaPath).size;
  const vocabWeightsBytes = fs.statSync(weightPath).size;
  const vocabGzBytes = zlib.gzipSync(fs.readFileSync(weightPath)).length;
  const metaGzBytes = zlib.gzipSync(fs.readFileSync(metaPath)).length;

  const tDocs0 = process.hrtime.bigint();
  let builtDocs = buildControlledDocuments(
    bdpmState.corpus,
    vetState.corpus,
    bdpmState.cisIndexes,
    vetState.numIndexes
  );
  const bdpmN = builtDocs.bdpmCount;
  const vetN = builtDocs.vetCount;
  const docsBuildMs = round(Number(process.hrtime.bigint() - tDocs0) / 1e6, 2);

  const tEnc0 = process.hrtime.bigint();
  let bdpmF32 = enc.encodeDocuments(builtDocs.docs.slice(0, bdpmN));
  let vetF32 = enc.encodeDocuments(builtDocs.docs.slice(bdpmN, bdpmN + vetN));
  const encodeDocsMs = round(Number(process.hrtime.bigint() - tEnc0) / 1e6, 2);
  builtDocs = null;

  const repVersion = useF32Encoder ? 'static-wp-mrl-128d-f32:v1' : 'static-wp-mrl-128d-int8:v1';
  const bdpmExpected = {
    representationVersion: repVersion,
    snapshotId: computeCorpusSnapshotId('bdpm', bdpmState.corpus.specialites, 'denomination', weightPath, metaPath)
  };
  const vetExpected = {
    representationVersion: repVersion,
    snapshotId: computeCorpusSnapshotId('anmv', vetState.corpus.medicaments, 'nom', weightPath, metaPath)
  };

  const baseOptsByVariant = {
    FXV1_Float32: { quantization: 'float32', dim: 128, metric: 'cosine', normalize: true },
    FXV1_Int8: { quantization: 'int8', dim: 128, metric: 'cosine', normalize: true },
    FXV1_PQ32: {
      quantization: 'pq',
      dim: 128,
      metric: 'cosine',
      normalize: true,
      pqSubspaces: 32,
      pqIterations: 15
    },
    FXV1_PQ16: {
      quantization: 'pq',
      dim: 128,
      metric: 'cosine',
      normalize: true,
      pqSubspaces: 16,
      pqIterations: 15
    }
  };
  const baseOpts = baseOptsByVariant[variant];
  if (!baseOpts) throw new Error(`Variante inconnue: ${variant}`);
  const bdpmOpts = { ...baseOpts, ...bdpmExpected };
  const vetOpts = { ...baseOpts, ...vetExpected };

  const tBuildVec0 = process.hrtime.bigint();
  let bdpmBin;
  let vetBin;
  let bdpmVec;
  let vetVec;
  let fxv1SaveBinaryMs = 0;
  if (baseOpts.quantization === 'pq') {
    bdpmBin = encodeDenseVectorPack(bdpmHost, bdpmF32, bdpmOpts);
    vetBin = encodeDenseVectorPack(vetHost, vetF32, vetOpts);
  } else {
    bdpmVec = FrozenVectorIndex.fromDenseFloat32(bdpmHost, bdpmF32, bdpmOpts);
    vetVec = FrozenVectorIndex.fromDenseFloat32(vetHost, vetF32, vetOpts);
  }
  const fxv1BuildMs = round(Number(process.hrtime.bigint() - tBuildVec0) / 1e6, 2);

  if (baseOpts.quantization !== 'pq') {
    const tSave0 = process.hrtime.bigint();
    bdpmBin = bdpmVec.saveBinary();
    vetBin = vetVec.saveBinary();
    fxv1SaveBinaryMs = round(Number(process.hrtime.bigint() - tSave0) / 1e6, 2);
  }
  const bdpmBinBytes = bdpmBin.length;
  const vetBinBytes = vetBin.length;
  const bdpmGz = zlib.gzipSync(bdpmBin).length;
  const vetGz = zlib.gzipSync(vetBin).length;

  const tLoad0 = process.hrtime.bigint();
  bdpmVec = FrozenVectorIndex.loadBinary(bdpmBin, bdpmHost, bdpmExpected);
  vetVec = FrozenVectorIndex.loadBinary(vetBin, vetHost, vetExpected);
  const fxv1LoadBinaryMs = round(Number(process.hrtime.bigint() - tLoad0) / 1e6, 2);

  // Latence de scan top-20 sur 120 requêtes
  const sampleQueries = [
    'ibuprofene comprime', 'paracetamol 1000', 'amoxicilline sirop', 'medicament metacam chien',
    'collyre yeux', 'solution injectable sous cutanee', 'doliprane sachet', 'ventoline inhalation',
    'antibiotique chat comprime', 'aspirine effervescent', 'cortancyl 20 mg', 'oméprazole gelule'
  ];
  const encodedSample = sampleQueries.map((q) => enc.encodeQuery(q).vec);
  // Warmup
  for (let i = 0; i < 20; i++) bdpmVec.topK(encodedSample[i % encodedSample.length], { k: 20 });
  const scanLatencies = [];
  for (let i = 0; i < 120; i++) {
    const qv = encodedSample[i % encodedSample.length];
    const t0 = process.hrtime.bigint();
    bdpmVec.topK(qv, { k: 20, minScore: 0.55 });
    vetVec.topK(qv, { k: 20, minScore: 0.55 });
    scanLatencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }

  const memBuildPeak = snapshotMem();
  // Libérer les buffers intermédiaires temporaires (les matrices Float32 d'entrée et buffers binaires sérialisés ne sont pas gardés en prod)
  bdpmF32 = null;
  vetF32 = null;
  bdpmBin = null;
  vetBin = null;
  const byteLengthBdpm = bdpmVec.stats().byteLength;
  const byteLengthVet = vetVec.stats().byteLength;
  const keepAlive = [bdpmHost, vetHost, bdpmVec, vetVec, enc];
  const memRetained = snapshotMem();
  void keepAlive.length;

  return {
    variant,
    counts: { bdpmN, vetN, totalDocs: bdpmN + vetN, dim: 128 },
    timingsMs: {
      lexicalLoadMs,
      conceptBuildMs,
      host113BuildMs,
      staticModelLoadMs: enc.loadMs,
      docsBuildMs,
      encodeDocsMs,
      fxv1BuildMs,
      fxv1SaveBinaryMs,
      fxv1LoadBinaryMs,
      totalPipelineMs: round(Number(process.hrtime.bigint() - tStart) / 1e6, 2),
      scanDual120P50Ms: round(percentile(scanLatencies, 0.5), 3),
      scanDual120P95Ms: round(percentile(scanLatencies, 0.95), 3)
    },
    artifactsBytes: {
      vocabMetaBytes,
      vocabWeightsBytes,
      vocabTotalBytes: vocabMetaBytes + vocabWeightsBytes,
      vocabTotalGzBytes: metaGzBytes + vocabGzBytes,
      fxv1BdpmBytes: bdpmBinBytes,
      fxv1VetBytes: vetBinBytes,
      fxv1TotalBytes: bdpmBinBytes + vetBinBytes,
      fxv1TotalGzBytes: bdpmGz + vetGz,
      fxv1RuntimeByteLength: byteLengthBdpm + byteLengthVet,
      totalRuntimeAssetsBytes: vocabMetaBytes + vocabWeightsBytes + bdpmBinBytes + vetBinBytes,
      totalRuntimeAssetsGzBytes: metaGzBytes + vocabGzBytes + bdpmGz + vetGz
    },
    memory: {
      afterB0: memAfterB0,
      afterB2: memAfterB2,
      afterHost113: memAfterHost113,
      duringBuildBeforeRelease: memBuildPeak,
      retainedPostGc: memRetained
    },
    fxv1Stats: {
      bdpm: bdpmVec.stats(),
      vet: vetVec.stats()
    }
  };
}

async function main() {
  const arg = process.argv.find((a) => a.startsWith('--variant='));
  if (!arg) {
    console.error('Usage: node --expose-gc measure_isolated_footprint.js --variant=B0|B2|FXV1_Float32|FXV1_Int8|FXV1_PQ32|FXV1_PQ16');
    process.exit(1);
  }
  const variant = arg.split('=')[1];
  const report = await runVariant(variant);
  console.log(`__ISOLATED_RESULT__=${JSON.stringify(report)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
