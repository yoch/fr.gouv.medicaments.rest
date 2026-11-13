'use strict';

/**
 * Benchmark B4 : Compression vectorielle (Float32 vs Int8 vs PQ16) sur Static-128.
 * Mesure :
 *   - Taille binaire brute + gzip, temps de quantification, RSS/Heap
 *   - Fidélité vs Float32 exact : RMSE, corrélation de Pearson, Overlap@10, Top1-match, Recall@10in100
 *   - Latence scan pur topK(120) (p50/p95) & temps de chargement à froid
 *   - Impact DEV bout-en-bout (eval_suite_v3 + eval_residual_v1) avec B2_emptyfb_stat128_055
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const bdpmState = require('../../../../src/services/bdpm/state');
const vetState = require('../../../../src/services/vet/state');
const { loadData, getSpecialiteByCis, getRelatedByCis, bdpmExtraitUrl, HYDRATE_RELATED_LIMIT } = require('../../../../src/services/dataLoader');
const { loadVetData, getMedicamentByNum, getRelatedByNum } = require('../../../../src/services/vetDataLoader');
const { parseListPaging } = require('../../../../src/utils/corpusPaging');
const { parseStructuredQuery } = require('../../../../src/search/structuredQueryParser');
const { getConceptStore } = require('../../../../src/search/conceptStore');
const { executeExperimentalSearchPage, evaluateEntityCriteria } = require('../../../../src/search/experimentalSearch');
const { evaluateSystem } = require('./eval_harness');
const {
  buildControlledDocuments,
  loadStaticWordPieceEncoder,
  quantizeInt8Docs,
  buildPqIndex,
  topKFloat32,
  topKInt8,
  topKPq
} = require('./b3_encoders');

const ARTIFACT_DIR = path.join(__dirname, '../../../../data/search-indexes/mission-semantic');

function hrMs(t0) {
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

function round(x, d = 4) {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
  return sorted[idx];
}

function buildSemanticQueryText(q, parsed) {
  const parts = [parsed.nameQuery];
  if (parsed.effectiveCriteria.forme) parts.push(parsed.effectiveCriteria.forme);
  if (parsed.effectiveCriteria.voie) parts.push(parsed.effectiveCriteria.voie);
  if (parsed.extracted.species.length > 0) parts.push(...parsed.extracted.species);
  return parts.filter(Boolean).join(' ') || q;
}

function hydrateDocHit(doc, score, parsed, store) {
  const record = doc.source === 'bdpm' ? store.bdpmByCis.get(doc.key) : store.vetByNum.get(doc.key);
  const { boost, criteria_match, dosage_extra } = evaluateEntityCriteria(record, parsed, { useAliases: true });
  const baseObj = doc.source === 'bdpm'
    ? (getSpecialiteByCis(doc.key) || { cis: doc.key, url_bdpm: bdpmExtraitUrl(doc.key) })
    : (getMedicamentByNum(doc.key) || { num: doc.key });

  return {
    type: doc.source === 'bdpm' ? 'medicament' : 'medicament_veterinaire',
    match_quality: 'fuzzy',
    match_via: 'semantic',
    ...baseObj,
    presentations: doc.source === 'bdpm'
      ? getRelatedByCis('presentations', doc.key, HYDRATE_RELATED_LIMIT)
      : getRelatedByNum('presentations', doc.key),
    compositions: doc.source === 'bdpm'
      ? getRelatedByCis('compositions', doc.key, HYDRATE_RELATED_LIMIT)
      : getRelatedByNum('compositions', doc.key),
    criteria_match,
    _semanticScore: score,
    _criteriaBoost: boost,
    _dosageExtra: dosage_extra
  };
}

function allScoresFloat32(qVec, docVecs, N, dim, out) {
  for (let i = 0; i < N; i++) {
    const base = i * dim;
    let dot = 0;
    for (let d = 0; d < dim; d++) dot += qVec[d] * docVecs[base + d];
    out[i] = dot;
  }
}

function allScoresInt8(qVec, int8Index, N, dim, out) {
  const { scales, codes } = int8Index;
  for (let i = 0; i < N; i++) {
    const base = i * dim;
    let dot = 0;
    for (let d = 0; d < dim; d++) dot += qVec[d] * codes[base + d];
    out[i] = dot * scales[i];
  }
}

function allScoresPq(qVec, pqIndex, N, out) {
  const { M, K, dSub, centroids, codes } = pqIndex;
  const lut = new Float32Array(M * K);
  for (let m = 0; m < M; m++) {
    const qBase = m * dSub;
    const cBase = m * K * dSub;
    const lBase = m * K;
    for (let c = 0; c < K; c++) {
      const cb = cBase + c * dSub;
      let dot = 0;
      for (let d = 0; d < dSub; d++) dot += qVec[qBase + d] * centroids[cb + d];
      lut[lBase + c] = dot;
    }
  }
  for (let i = 0; i < N; i++) {
    const codeBase = i * M;
    let sum = 0;
    for (let m = 0; m < M; m++) sum += lut[m * K + codes[codeBase + m]];
    out[i] = sum;
  }
}

function makeHybridFn(docs, bdpmCount, topKFn, encoder, store, minScore = 0.55) {
  return (tc, page = 1, limit = 10) => {
    const b2 = executeExperimentalSearchPage(tc.q, tc.source || 'auto', 1, 100, {}, { mode: 'concepts' });
    if (b2.total > 0) {
      const { offset, safeLimit } = parseListPaging(page, limit);
      return { ...b2, results: b2.results.slice(offset, offset + safeLimit) };
    }

    const parsed = parseStructuredQuery(tc.q, {}, store.taxonomy, { useAliases: true });
    if (parsed.kind === 'exact_code') return { total: 0, results: [] };

    const source = (tc.source || 'auto').toLowerCase();
    const speciesHintVet = source === 'auto' && parsed.extracted.species.length > 0;
    let maskFn = null;
    if (source === 'human') maskFn = (i) => i < bdpmCount;
    else if (source === 'veterinary' || speciesHintVet) maskFn = (i) => i >= bdpmCount;

    const queryText = buildSemanticQueryText(tc.q, parsed);
    const { vec: qVec, matchedTerms } = encoder.encodeQuery(queryText);
    if (matchedTerms === 0) return { total: 0, results: [] };

    const topRaw = topKFn(qVec, 120, maskFn).filter((h) => h.score >= minScore);
    const hydrated = topRaw.map((h) => hydrateDocHit(docs[h.docId], h.score, parsed, store));
    hydrated.sort((a, b) => {
      if (b._criteriaBoost !== a._criteriaBoost) return b._criteriaBoost - a._criteriaBoost;
      const exA = a._dosageExtra ?? Infinity;
      const exB = b._dosageExtra ?? Infinity;
      if (Math.abs(b._semanticScore - a._semanticScore) > 0.04) return b._semanticScore - a._semanticScore;
      if (exA !== exB) return exA < exB ? -1 : 1;
      return b._semanticScore - a._semanticScore;
    });

    const { offset, safeLimit } = parseListPaging(page, limit);
    return {
      total: hydrated.length,
      results: hydrated.slice(offset, offset + safeLimit),
      search: { query: tc.q, mode: 'hybrid' }
    };
  };
}

function serializeAndMeasure(filename, buffers) {
  const totalLen = buffers.reduce((s, b) => s + b.byteLength, 0);
  const out = Buffer.allocUnsafe(totalLen);
  let off = 0;
  for (const b of buffers) {
    Buffer.from(b.buffer, b.byteOffset, b.byteLength).copy(out, off);
    off += b.byteLength;
  }
  const fullPath = path.join(ARTIFACT_DIR, filename);
  fs.writeFileSync(fullPath, out);
  const gzBytes = zlib.gzipSync(out, { level: 6 }).byteLength;

  // Cold read benchmark (median over 7 reads)
  const loadTimes = [];
  for (let r = 0; r < 7; r++) {
    const t0 = process.hrtime.bigint();
    const raw = fs.readFileSync(fullPath);
    // force touch of underlying buffer bytes
    let chk = 0;
    for (let i = 0; i < raw.length; i += 4096) chk ^= raw[i];
    if (chk === -1) console.log(chk);
    loadTimes.push(hrMs(t0));
  }
  loadTimes.sort((a, b) => a - b);
  return {
    rawBytes: out.byteLength,
    gzBytes,
    loadMedianMs: round(loadTimes[3], 2)
  };
}

async function main() {
  await loadData();
  await loadVetData();
  const store = getConceptStore();
  const { docs, bdpmCount } = buildControlledDocuments(
    bdpmState.corpus,
    vetState.corpus,
    bdpmState.cisIndexes,
    vetState.numIndexes
  );
  const N = docs.length;
  const dim = 128;

  const static128 = loadStaticWordPieceEncoder(dim);
  const tEnc0 = process.hrtime.bigint();
  const docVecsF32 = static128.encodeDocuments(docs);
  const encodeDocsMs = round(hrMs(tEnc0), 1);

  const tI80 = process.hrtime.bigint();
  const int8Index = quantizeInt8Docs(docVecsF32, N, dim);
  const int8BuildMs = round(hrMs(tI80), 2);

  const pq16Index = buildPqIndex(docVecsF32, N, dim, { M: 16, K: 256, iters: 15 });
  const pq32Index = buildPqIndex(docVecsF32, N, dim, { M: 32, K: 256, iters: 15 });

  // Serialize each format + 32-byte synthetic header
  const header = new Uint8Array(32);
  const f32Disk = serializeAndMeasure('b4_f32_128d.bin', [header, docVecsF32]);
  const i8Disk = serializeAndMeasure('b4_int8_128d.bin', [header, int8Index.scales, int8Index.codes]);
  const pq32Disk = serializeAndMeasure('b4_pq32_128d.bin', [header, pq32Index.centroids, pq32Index.codes]);
  const pq16Disk = serializeAndMeasure('b4_pq16_128d.bin', [header, pq16Index.centroids, pq16Index.codes]);

  // Remove temp disk files after measurement so scratch binary footprint stays clean
  for (const fn of ['b4_f32_128d.bin', 'b4_int8_128d.bin', 'b4_pq32_128d.bin', 'b4_pq16_128d.bin']) {
    fs.unlinkSync(path.join(ARTIFACT_DIR, fn));
  }

  const evalV3 = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval_suite_v3.json'), 'utf8'));
  const evalRes = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval_residual_v1.json'), 'utf8'));

  // Unique non-OOS dev queries for fidelity + scan micro-benchmark
  const devQueries = [...evalV3.cases, ...evalRes.cases]
    .filter((c) => c.split === 'dev' && !c.oos)
    .map((c) => c.q);
  const qVecs = devQueries.map((q) => {
    const p = parseStructuredQuery(q, {}, store.taxonomy, { useAliases: true });
    return static128.encodeQuery(buildSemanticQueryText(q, p)).vec;
  });

  // Fidelity & overlap vs Float32 exact
  const f32Buf = new Float32Array(N);
  const i8Buf = new Float32Array(N);
  const pq32Buf = new Float32Array(N);
  const pq16Buf = new Float32Array(N);

  const initAcc = () => ({ sumAbsErr: 0, sumSqErr: 0, count: 0, sumX: 0, sumY: 0, sumXX: 0, sumYY: 0, sumXY: 0, ov10: 0, top1: 0, rec10in100: 0 });
  const metrics = { int8: initAcc(), pq32: initAcc(), pq16: initAcc() };

  for (const qv of qVecs) {
    allScoresFloat32(qv, docVecsF32, N, dim, f32Buf);
    allScoresInt8(qv, int8Index, N, dim, i8Buf);
    allScoresPq(qv, pq32Index, N, pq32Buf);
    allScoresPq(qv, pq16Index, N, pq16Buf);

    const topF32 = topKFloat32(qv, docVecsF32, N, dim, 10).map((h) => h.docId);
    const topF32Set10 = new Set(topF32);
    const topI8_100 = topKInt8(qv, int8Index, N, dim, 100).map((h) => h.docId);
    const topPq32_100 = topKPq(qv, pq32Index, N, 100).map((h) => h.docId);
    const topPq16_100 = topKPq(qv, pq16Index, N, 100).map((h) => h.docId);

    const updateAcc = (m, approxBuf, topApprox100) => {
      for (let i = 0; i < N; i++) {
        const x = f32Buf[i];
        const y = approxBuf[i];
        const err = y - x;
        m.sumAbsErr += Math.abs(err);
        m.sumSqErr += err * err;
        m.sumX += x;
        m.sumY += y;
        m.sumXX += x * x;
        m.sumYY += y * y;
        m.sumXY += x * y;
        m.count++;
      }
      const top10 = topApprox100.slice(0, 10);
      let hits10 = 0;
      for (const id of top10) if (topF32Set10.has(id)) hits10++;
      m.ov10 += hits10 / 10;
      if (top10[0] === topF32[0]) m.top1 += 1;
      const set100 = new Set(topApprox100);
      let hits100 = 0;
      for (const id of topF32) if (set100.has(id)) hits100++;
      m.rec10in100 += hits100 / 10;
    };

    updateAcc(metrics.int8, i8Buf, topI8_100);
    updateAcc(metrics.pq32, pq32Buf, topPq32_100);
    updateAcc(metrics.pq16, pq16Buf, topPq16_100);
  }

  const finalizeAcc = (m) => {
    const n = m.count;
    const meanX = m.sumX / n;
    const meanY = m.sumY / n;
    const num = (m.sumXY / n) - meanX * meanY;
    const den = Math.sqrt(((m.sumXX / n) - meanX * meanX) * ((m.sumYY / n) - meanY * meanY));
    return {
      mae: round(m.sumAbsErr / n, 6),
      rmse: round(Math.sqrt(m.sumSqErr / n), 6),
      pearsonR: round(den > 0 ? num / den : 0, 5),
      overlapAt10: round(m.ov10 / qVecs.length, 3),
      top1Agreement: round(m.top1 / qVecs.length, 3),
      recall10In100: round(m.rec10in100 / qVecs.length, 3)
    };
  };

  // Pure scan micro-benchmark (after 20 warmup passes)
  const benchScan = (fn) => {
    for (let w = 0; w < 20; w++) fn(qVecs[w % qVecs.length]);
    const times = [];
    for (let r = 0; r < 5; r++) {
      for (const qv of qVecs) {
        const t0 = process.hrtime.bigint();
        const res = fn(qv);
        if (!res) console.log('empty');
        times.push(hrMs(t0));
      }
    }
    times.sort((a, b) => a - b);
    return { p50Ms: round(quantile(times, 0.5), 3), p95Ms: round(quantile(times, 0.95), 3) };
  };

  const scanF32 = benchScan((qv) => topKFloat32(qv, docVecsF32, N, dim, 120));
  const scanI8 = benchScan((qv) => topKInt8(qv, int8Index, N, dim, 120));
  const scanPq32 = benchScan((qv) => topKPq(qv, pq32Index, N, 120));
  const scanPq16 = benchScan((qv) => topKPq(qv, pq16Index, N, 120));

  // DEV End-to-End evaluation under B2_emptyfb_stat128_055
  const fnB2 = (tc, p = 1, l = 10) => executeExperimentalSearchPage(tc.q, tc.source || 'auto', p, l, {}, { mode: 'concepts' });
  const fnF32 = makeHybridFn(docs, bdpmCount, (qv, k, mask) => topKFloat32(qv, docVecsF32, N, dim, k, mask), static128, store, 0.55);
  const fnI8 = makeHybridFn(docs, bdpmCount, (qv, k, mask) => topKInt8(qv, int8Index, N, dim, k, mask), static128, store, 0.55);
  const fnPq32 = makeHybridFn(docs, bdpmCount, (qv, k, mask) => topKPq(qv, pq32Index, N, k, mask), static128, store, 0.55);
  const fnPq16 = makeHybridFn(docs, bdpmCount, (qv, k, mask) => topKPq(qv, pq16Index, N, k, mask), static128, store, 0.55);

  const summarize = (r, isResidual) => ({
    id1: r.summary.identityTop1,
    var1: r.summary.variantTop1,
    mrr10: r.summary.mrr10,
    ndcg10: r.summary.ndcg10,
    empty: r.summary.emptyRate,
    oosNonEmpty: r.summary.oosNonEmptyRate,
    oosStrongFp: r.summary.oosStrongFpRate,
    p50: r.summary.latencyMs.p50,
    p95: r.summary.latencyMs.p95,
    ...(isResidual ? {
      R1: r.byFamily.R1_severe_typos ? r.byFamily.R1_severe_typos.variantTop1 : null,
      R2: r.byFamily.R2_patient_noise_unaliased ? r.byFamily.R2_patient_noise_unaliased.variantTop1 : null,
      R3: r.byFamily.R3_crosslingual_inn ? r.byFamily.R3_crosslingual_inn.variantTop1 : null
    } : {})
  });

  console.log('=== B4 STORAGE / BUILD / SCAN SUMMARY (N=' + N + ', dim=' + dim + ') ===');
  console.log(JSON.stringify({
    encodeDocsMs,
    float32: { buildMs: 0, payloadBytes: docVecsF32.byteLength, disk: f32Disk, scan120: scanF32 },
    int8: { buildMs: int8BuildMs, payloadBytes: int8Index.bytes, disk: i8Disk, scan120: scanI8, fidelity: finalizeAcc(metrics.int8) },
    pq32: { buildMs: pq32Index.buildMs, payloadBytes: pq32Index.bytes, disk: pq32Disk, scan120: scanPq32, fidelity: finalizeAcc(metrics.pq32) },
    pq16: { buildMs: pq16Index.buildMs, payloadBytes: pq16Index.bytes, disk: pq16Disk, scan120: scanPq16, fidelity: finalizeAcc(metrics.pq16) }
  }, null, 2));

  console.log('\n=== DEV E2E B2_emptyfb_stat128_055 BY COMPRESSION ===');
  for (const [label, suite, isRes] of [['V3_DEV', evalV3, false], ['RESIDUAL_DEV', evalRes, true]]) {
    console.log('-- ' + label + ' --');
    for (const [name, fn] of [
      ['B2_concepts', fnB2],
      ['Hybrid_Float32', fnF32],
      ['Hybrid_Int8', fnI8],
      ['Hybrid_PQ32', fnPq32],
      ['Hybrid_PQ16', fnPq16]
    ]) {
      for (let w = 0; w < 3; w++) fn(suite.cases[0], 1, 10);
      const r = await evaluateSystem(name, suite, fn, { split: 'dev' });
      console.log(name.padEnd(16), JSON.stringify(summarize(r, isRes)));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
