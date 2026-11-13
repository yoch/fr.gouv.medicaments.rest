'use strict';

/**
 * Établit l'ablation rigoureuse B2 vs B3 (embeddings statiques zéro-dépendance)
 * sur DEV uniquement (eval_suite_v3 + eval_residual_v1).
 *
 * Compare :
 *   - B2_concepts (référence structurée + concepts)
 *   - Standalone : LSA Word 128, LSA Char3+Word 128, Static MRL 64d/128d Int8
 *   - Hybrides non destructifs (strict fallback b2.total === 0) avec seuils OOS calibrés
 *     et comparaison encodage query brute vs (nameQuery + forme sans dosage chiffré).
 */

const fs = require('node:fs');
const path = require('node:path');

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
  buildLsaEncoder,
  loadStaticWordPieceEncoder,
  topKFloat32
} = require('./b3_encoders');

function memMb() {
  const m = process.memoryUsage();
  return {
    rssMb: Math.round((m.rss / 1048576) * 10) / 10,
    heapUsedMb: Math.round((m.heapUsed / 1048576) * 10) / 10,
    externalMb: Math.round((m.external / 1048576) * 10) / 10,
    arrayBuffersMb: Math.round((m.arrayBuffers / 1048576) * 10) / 10
  };
}

function hydrateDocHit(doc, score, parsed, store, quality = 'fuzzy') {
  const record = doc.source === 'bdpm' ? store.bdpmByCis.get(doc.key) : store.vetByNum.get(doc.key);
  const { boost, criteria_match, dosage_extra } = evaluateEntityCriteria(record, parsed, { useAliases: true });
  const baseObj = doc.source === 'bdpm'
    ? (getSpecialiteByCis(doc.key) || { cis: doc.key, url_bdpm: bdpmExtraitUrl(doc.key) })
    : (getMedicamentByNum(doc.key) || { num: doc.key });

  return {
    type: doc.source === 'bdpm' ? 'medicament' : 'medicament_veterinaire',
    match_quality: quality,
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

function buildSemanticQueryText(q, parsed, encodeMode) {
  if (encodeMode === 'raw') return q;
  // nameQuery + forme/voie/species (sans dosages chiffrés pour éviter l'attraction de densité par « 20 mg »)
  const parts = [parsed.nameQuery];
  if (parsed.effectiveCriteria.forme) parts.push(parsed.effectiveCriteria.forme);
  if (parsed.effectiveCriteria.voie) parts.push(parsed.effectiveCriteria.voie);
  if (parsed.extracted.species.length > 0) parts.push(...parsed.extracted.species);
  return parts.filter(Boolean).join(' ') || q;
}

function makeSemanticStandaloneFn(docs, bdpmCount, docVecs, encoder, store, {
  minScore = 0.30,
  encodeMode = 'structured_nodose'
} = {}) {
  const N = docs.length;
  const dim = encoder.dim;

  return (tc, page = 1, limit = 10) => {
    const parsed = parseStructuredQuery(tc.q, {}, store.taxonomy, { useAliases: true });
    if (parsed.kind === 'exact_code') {
      return executeExperimentalSearchPage(tc.q, tc.source || 'auto', page, limit, {}, { mode: 'concepts' });
    }

    const source = (tc.source || 'auto').toLowerCase();
    const speciesHintVet = source === 'auto' && parsed.extracted.species.length > 0;
    let maskFn = null;
    if (source === 'human') maskFn = (i) => i < bdpmCount;
    else if (source === 'veterinary' || speciesHintVet) maskFn = (i) => i >= bdpmCount;

    const queryText = buildSemanticQueryText(tc.q, parsed, encodeMode);
    const { vec: qVec, matchedTerms } = encoder.encodeQuery(queryText);
    if (matchedTerms === 0) {
      return { total: 0, results: [], search: { query: tc.q, mode: encoder.name } };
    }

    const topRaw = topKFloat32(qVec, docVecs, N, dim, 120, maskFn)
      .filter((h) => h.score >= minScore);

    const hydrated = topRaw.map((h) => hydrateDocHit(docs[h.docId], h.score, parsed, store, 'fuzzy'));
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
      search: {
        query: tc.q,
        mode: encoder.name,
        referentiels: {
          queried: source === 'veterinary' ? ['anmv'] : source === 'human' ? ['bdpm'] : ['bdpm', 'anmv'],
          with_results: hydrated.length > 0 ? [...new Set(hydrated.map((h) => h.type === 'medicament' ? 'bdpm' : 'anmv'))] : []
        }
      }
    };
  };
}

function makeStrictEmptyFallbackFn(docs, bdpmCount, docVecs, encoder, store, {
  minScore = 0.40,
  encodeMode = 'structured_nodose'
} = {}) {
  const standalone = makeSemanticStandaloneFn(docs, bdpmCount, docVecs, encoder, store, { minScore, encodeMode });
  return (tc, page = 1, limit = 10) => {
    const b2 = executeExperimentalSearchPage(tc.q, tc.source || 'auto', 1, 100, {}, { mode: 'concepts' });
    if (b2.total > 0) {
      const { offset, safeLimit } = parseListPaging(page, limit);
      return { ...b2, results: b2.results.slice(offset, offset + safeLimit) };
    }
    return standalone(tc, page, limit);
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

  const lsaWord = buildLsaEncoder(docs, { dim: 128, includeChar3: false });
  const lsaChar3 = buildLsaEncoder(docs, { dim: 128, includeChar3: true });
  const static64 = loadStaticWordPieceEncoder(64);
  const static64DocVecs = static64.encodeDocuments(docs);
  const static128 = loadStaticWordPieceEncoder(128);
  const static128DocVecs = static128.encodeDocuments(docs);

  const blendEncoder = {
    name: 'blend_char3_static128',
    dim: 256,
    encodeQuery: (q) => {
      const a = lsaChar3.encodeQuery(q);
      const b = static128.encodeQuery(q);
      const v = new Float32Array(256);
      const s = 1 / Math.SQRT2;
      for (let d = 0; d < 128; d++) {
        v[d] = a.vec[d] * s;
        v[128 + d] = b.vec[d] * s;
      }
      return { vec: v, matchedTerms: a.matchedTerms + b.matchedTerms };
    }
  };
  const blendDocs = new Float32Array(docs.length * 256);
  for (let i = 0; i < docs.length; i++) {
    for (let d = 0; d < 128; d++) {
      blendDocs[i * 256 + d] = lsaChar3.docVecs[i * 128 + d] / Math.SQRT2;
      blendDocs[i * 256 + 128 + d] = static128DocVecs[i * 128 + d] / Math.SQRT2;
    }
  }

  const evalV3 = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval_suite_v3.json'), 'utf8'));
  const evalRes = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval_residual_v1.json'), 'utf8'));

  const configs = {
    B2_concepts: (tc, p = 1, l = 10) => executeExperimentalSearchPage(tc.q, tc.source || 'auto', p, l, {}, { mode: 'concepts' }),
    B3_lsa_word128_only: makeSemanticStandaloneFn(docs, bdpmCount, lsaWord.docVecs, lsaWord, store, { minScore: 0.35 }),
    B3_lsa_char3_only: makeSemanticStandaloneFn(docs, bdpmCount, lsaChar3.docVecs, lsaChar3, store, { minScore: 0.35 }),
    B3_static64_only: makeSemanticStandaloneFn(docs, bdpmCount, static64DocVecs, static64, store, { minScore: 0.35 }),
    B3_static128_only: makeSemanticStandaloneFn(docs, bdpmCount, static128DocVecs, static128, store, { minScore: 0.35 }),
    B2_emptyfb_char3_035: makeStrictEmptyFallbackFn(docs, bdpmCount, lsaChar3.docVecs, lsaChar3, store, { minScore: 0.35 }),
    B2_emptyfb_stat64_040: makeStrictEmptyFallbackFn(docs, bdpmCount, static64DocVecs, static64, store, { minScore: 0.40 }),
    B2_emptyfb_stat128_raw: makeStrictEmptyFallbackFn(docs, bdpmCount, static128DocVecs, static128, store, { minScore: 0.35, encodeMode: 'raw' }),
    B2_emptyfb_stat128_035: makeStrictEmptyFallbackFn(docs, bdpmCount, static128DocVecs, static128, store, { minScore: 0.35 }),
    B2_emptyfb_stat128_045: makeStrictEmptyFallbackFn(docs, bdpmCount, static128DocVecs, static128, store, { minScore: 0.45 }),
    B2_emptyfb_stat128_055: makeStrictEmptyFallbackFn(docs, bdpmCount, static128DocVecs, static128, store, { minScore: 0.55 }),
    B2_emptyfb_blend256_035: makeStrictEmptyFallbackFn(docs, bdpmCount, blendDocs, blendEncoder, store, { minScore: 0.35 })
  };

  const outV3 = {};
  const outRes = {};
  for (const [name, fn] of Object.entries(configs)) {
    for (let i = 0; i < 3; i++) fn(evalRes.cases[0], 1, 10);
    outV3[name] = await evaluateSystem(name, evalV3, fn, { split: 'dev' });
    outRes[name] = await evaluateSystem(name, evalRes, fn, { split: 'dev' });
  }

  console.log('=== DEV EVAL_SUITE_V3 ===');
  for (const [name, r] of Object.entries(outV3)) {
    console.log(name.padEnd(26), JSON.stringify({
      id1: r.summary.identityTop1, var1: r.summary.variantTop1, mrr10: r.summary.mrr10,
      ndcg10: r.summary.ndcg10, empty: r.summary.emptyRate,
      oosNonEmpty: r.summary.oosNonEmptyRate, oosStrongFp: r.summary.oosStrongFpRate,
      p50: r.summary.latencyMs.p50, p95: r.summary.latencyMs.p95
    }));
  }

  console.log('\n=== DEV EVAL_RESIDUAL_V1 ===');
  for (const [name, r] of Object.entries(outRes)) {
    console.log(name.padEnd(26), JSON.stringify({
      id1: r.summary.identityTop1, var1: r.summary.variantTop1, hit5: r.summary.hit5Var,
      mrr10: r.summary.mrr10, ndcg10: r.summary.ndcg10, empty: r.summary.emptyRate,
      falseCrit: r.summary.falseCriteriaRate, oosNonEmpty: r.summary.oosNonEmptyRate, oosStrongFp: r.summary.oosStrongFpRate,
      p50: r.summary.latencyMs.p50, p95: r.summary.latencyMs.p95,
      R1: r.byFamily.R1_severe_typos.variantTop1,
      R2: r.byFamily.R2_patient_noise_unaliased.variantTop1,
      R3: r.byFamily.R3_crosslingual_inn.variantTop1
    }));
  }

  // Inspection des cosinus max sur R4 OOS vs R2/R1 sauvés
  console.log('\n=== MAX COSINE DIAGNOSTIC ON EMPTY-FALLBACK CANDIDATES (static128 nodose vs raw) ===');
  for (const tc of evalRes.cases.filter((c) => c.split === 'dev')) {
    const b2 = executeExperimentalSearchPage(tc.q, tc.source || 'auto', 1, 5, {}, { mode: 'concepts' });
    if (b2.total === 0 || tc.oos) {
      const parsed = parseStructuredQuery(tc.q, {}, store.taxonomy, { useAliases: true });
      const qt = buildSemanticQueryText(tc.q, parsed, 'structured_nodose');
      const { vec } = static128.encodeQuery(qt);
      const top1 = topKFloat32(vec, static128DocVecs, docs.length, 128, 3);
      console.log(
        `${tc.family.slice(0, 12).padEnd(12)} | q=${tc.q.padEnd(32)} | b2tot=${b2.total} | qt="${qt}" | top1=${docs[top1[0].docId].key} ${docs[top1[0].docId].text.slice(0, 40)} (cos=${top1[0].score.toFixed(3)})`
      );
    }
  }

  fs.writeFileSync(
    path.join(__dirname, 'b3_dev_results.json'),
    `${JSON.stringify({
      mem: memMb(),
      v3Dev: Object.fromEntries(Object.entries(outV3).map(([k, v]) => [k, { summary: v.summary, byFamily: v.byFamily }])),
      residualDev: Object.fromEntries(Object.entries(outRes).map(([k, v]) => [k, { summary: v.summary, byFamily: v.byFamily, perCase: v.perCase }]))
    }, null, 2)}\n`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
