'use strict';

/**
 * Validation finale de mission :
 *  1. Cross-validation complète du tarball `@yoch/frozenminisearch@1.13.0`
 *     (CJS + ESM + Browser) vs `@yoch/frozenminisearch@1.12.3` sur le vrai
 *     corpus BDPM (15 845) + ANMV (3 213) : parité lexicale B0 100%,
 *     FrozenVectorIndex Int8 / Float32 / PQ32 / PQ16, round-trips binaires FXV1
 *     non alignés inter-environnements, rejet CRC/fingerprint/trailing bytes,
 *     et filtre pré-k au-delà du rang 85.
 *  2. Calibration OOS & seuils exclusivement sur DEV (+ sondes DEV adverses)
 *     puis GEL explicite de `FROZEN_MIN_SCORE = 0.55`.
 *  3. Évaluation unique sur `dev` ET `heldout` (`eval_suite_v3.json` +
 *     `eval_residual_v1.json`) pour B0, B1, B2, Hybrid_Int8_Tarball@0.55,
 *     Hybrid_PQ32_Tarball@0.55 et Hybrid_PQ16_Tarball@0.55, sans jamais afficher
 *     les requêtes `heldout`, avec trace des chemins d'exécution, contrôle strict
 *     de provenance `match_via: 'semantic'` et invariants de dédup/pagination.
 *  4. Benchmark HTTP E2E apparié en ordre alterné (ABCD / DCBA) sur serveur
 *     Express loopback réel (`/api/medicaments/search` + route compagnon hybrid)
 *     avec p50 / IQR / p95 en ms absolus et delta apparié par requête.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const express = require('express');

const { loadData, getSpecialiteByCis, getRelatedByCis, bdpmExtraitUrl, HYDRATE_RELATED_LIMIT } = require('../../../../src/services/dataLoader');
const { loadVetData, getMedicamentByNum, getRelatedByNum, getVetSearchIndexes } = require('../../../../src/services/vetDataLoader');
const { getMetadata } = require('../../../../src/services/dataLoader');
const bdpmState = require('../../../../src/services/bdpm/state');
const vetState = require('../../../../src/services/vet/state');
const { BDPM_INDEX_SPECS, VET_INDEX_SPECS } = require('../../../../src/search/indexSpecs');
const { miniSearchIndexConfig } = require('../../../../src/utils/miniSearchIndexConfig');
const { buildIndexDocument } = require('../../../../src/utils/corpusStore');
const { executeHybridSearchPage } = require('../../../../src/services/searchOrchestrator');
const { executeExperimentalSearchPage } = require('../../../../src/search/experimentalSearch');
const { parseStructuredQuery } = require('../../../../src/search/structuredQueryParser');
const { analyzeQuerySafetyAndIntent } = require('../../../../src/search/queryIntentGuard');
const { getConceptStore } = require('../../../../src/search/conceptStore');
const { normalizeSearchText } = require('../../../../src/utils/searchRanking');
const { parseListPaging, buildPagedResponse } = require('../../../../src/utils/corpusPaging');
const { shapeSearchResults } = require('../../../../src/utils/searchResponseShape');
const medicamentRoutes = require('../../../../src/routes/medicaments');
const { evaluateSystem } = require('./eval_harness');
const { buildControlledDocuments, loadStaticWordPieceEncoder } = require('./b3_encoders');

const PKG_DIR = path.join(
  __dirname,
  '../../../../data/search-indexes/mission-semantic/pkg-verify/package'
);
const PKG_CJS = path.join(PKG_DIR, 'dist/cjs/index.require.cjs');
const PKG_ESM = path.join(PKG_DIR, 'dist/es/index.js');
const PKG_BROWSER = path.join(PKG_DIR, 'dist/browser/index.js');

const STOP_WORDS_SEMANTIC = new Set([
  'a', 'au', 'aux', 'avec', 'contre', 'd', 'dans', 'de', 'des', 'du', 'en', 'et',
  'l', 'la', 'le', 'les', 'medicament', 'medicaments', 'ou', 'par', 'pour',
  'prendre', 'que', 'quel', 'quelle', 'quelles', 'quels', 'qui', 'sans', 'sur',
  'un', 'une'
]);

function round(v, digits = 3) {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}

function buildHostFromRows(FrozenMiniSearch, rows, spec) {
  const opts = miniSearchIndexConfig(spec.fields, spec.boost);
  const docs = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    docs[i] = buildIndexDocument(rows[i], i, spec.fields);
  }
  return FrozenMiniSearch.fromDocuments(docs, opts);
}

function makeUnalignedView(u8, byteOffset = 3) {
  const buf = new ArrayBuffer(u8.byteLength + byteOffset + 5);
  const view = new Uint8Array(buf, byteOffset, u8.byteLength);
  view.set(u8);
  return view;
}

function assertCondition(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function assertThrows(fn, msg) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assertCondition(threw, msg);
}

function buildSemanticQueryText(rawQuery, parsed) {
  const sourceText = parsed.nameQuery || rawQuery;
  const norm = normalizeSearchText(sourceText)
    .replace(/['’/;,+()\-:.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!norm) return '';
  const tokens = norm.split(' ').filter((t) => t.length >= 2 && !STOP_WORDS_SEMANTIC.has(t));
  const extras = [];
  if (parsed.effectiveCriteria.forme) extras.push(normalizeSearchText(parsed.effectiveCriteria.forme));
  if (parsed.effectiveCriteria.voie) extras.push(normalizeSearchText(parsed.effectiveCriteria.voie));
  if (parsed.effectiveCriteria.species) extras.push(...parsed.effectiveCriteria.species);
  return [...tokens, ...extras].join(' ').trim();
}

async function runTarballCrossValidation(bdpmF32, vetF32, enc) {
  const cjsPkg = require(PKG_CJS);
  const esmPkg = await import(pathToFileURL(PKG_ESM).href);
  const browserPkg = await import(pathToFileURL(PKG_BROWSER).href);
  const pkgMeta = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
  assertCondition(pkgMeta.version === '1.13.0', `Expected tarball 1.13.0, got ${pkgMeta.version}`);

  const bdpmSpec = BDPM_INDEX_SPECS.specialites;
  const vetSpec = VET_INDEX_SPECS.medicaments;
  const bdpmCjs = buildHostFromRows(cjsPkg.FrozenMiniSearch, bdpmState.corpus.specialites, bdpmSpec);
  const vetCjs = buildHostFromRows(cjsPkg.FrozenMiniSearch, vetState.corpus.medicaments, vetSpec);
  const bdpmEsm = buildHostFromRows(esmPkg.FrozenMiniSearch, bdpmState.corpus.specialites, bdpmSpec);
  const vetEsm = buildHostFromRows(esmPkg.FrozenMiniSearch, vetState.corpus.medicaments, vetSpec);
  const bdpmBrowser = buildHostFromRows(browserPkg.FrozenMiniSearch, bdpmState.corpus.specialites, bdpmSpec);

  // 1. Parité lexicale 100% entre l'index live 1.12.3 et les 3 bundles 1.13.0 (CJS/ESM/Browser)
  const liveBdpm = bdpmState.searchIndexes.specialites;
  const liveVet = getVetSearchIndexes().medicaments;
  const bdpmProbes = [
    'paracetamol', 'doliprane 1000', 'amoxicilline acide clavulanique', 'ibuprofene',
    'levothyrox', 'ventoline', 'spasfon', 'eliquis', 'kardegic', 'augmntin',
    'metformine', 'atorvastatine', 'omeprazole', 'toplexil', '60234100'
  ];
  const vetProbes = ['metacam', 'nobivac', 'synulox', 'meloxidyl', 'clavaseptin', 'amoxicilline'];

  let bdpmMismatches = 0;
  for (const q of bdpmProbes) {
    const refIds = JSON.stringify(liveBdpm.search(q).slice(0, 15).map((r) => [r.id, Math.round(r.score * 1e6)]));
    const cjsIds = JSON.stringify(bdpmCjs.search(q).slice(0, 15).map((r) => [r.id, Math.round(r.score * 1e6)]));
    const esmIds = JSON.stringify(bdpmEsm.search(q).slice(0, 15).map((r) => [r.id, Math.round(r.score * 1e6)]));
    const brwIds = JSON.stringify(bdpmBrowser.search(q).slice(0, 15).map((r) => [r.id, Math.round(r.score * 1e6)]));
    if (refIds !== cjsIds || refIds !== esmIds || refIds !== brwIds) bdpmMismatches++;
  }
  let vetMismatches = 0;
  for (const q of vetProbes) {
    const refIds = JSON.stringify(liveVet.search(q).slice(0, 15).map((r) => [r.id, Math.round(r.score * 1e6)]));
    const cjsIds = JSON.stringify(vetCjs.search(q).slice(0, 15).map((r) => [r.id, Math.round(r.score * 1e6)]));
    const esmIds = JSON.stringify(vetEsm.search(q).slice(0, 15).map((r) => [r.id, Math.round(r.score * 1e6)]));
    if (refIds !== cjsIds || refIds !== esmIds) vetMismatches++;
  }
  assertCondition(bdpmMismatches === 0 && vetMismatches === 0, 'Lexical parity mismatch 1.12.3 vs 1.13.0');

  // 2. Construction FrozenVectorIndex (Int8, Float32, PQ32, PQ16) + invariants corpusFingerprint & FXV1
  const bdpmInt8 = cjsPkg.FrozenVectorIndex.fromDenseFloat32(bdpmCjs, bdpmF32, {
    quantization: 'int8', dim: 128, metric: 'cosine', normalized: true
  });
  const vetInt8 = cjsPkg.FrozenVectorIndex.fromDenseFloat32(vetCjs, vetF32, {
    quantization: 'int8', dim: 128, metric: 'cosine', normalized: true
  });
  const bdpmPq32 = cjsPkg.FrozenVectorIndex.fromDenseFloat32(bdpmCjs, bdpmF32, {
    quantization: 'pq', dim: 128, metric: 'cosine', normalized: true,
    pqSubspaces: 32, pqCentroidsPerSubspace: 256, pqMaxIterations: 15
  });
  const vetPq32 = cjsPkg.FrozenVectorIndex.fromDenseFloat32(vetCjs, vetF32, {
    quantization: 'pq', dim: 128, metric: 'cosine', normalized: true,
    pqSubspaces: 32, pqCentroidsPerSubspace: 256, pqMaxIterations: 15
  });
  const bdpmPq16 = cjsPkg.FrozenVectorIndex.fromDenseFloat32(bdpmCjs, bdpmF32, {
    quantization: 'pq', dim: 128, metric: 'cosine', normalized: true,
    pqSubspaces: 16, pqCentroidsPerSubspace: 256, pqMaxIterations: 15
  });
  const vetPq16 = cjsPkg.FrozenVectorIndex.fromDenseFloat32(vetCjs, vetF32, {
    quantization: 'pq', dim: 128, metric: 'cosine', normalized: true,
    pqSubspaces: 16, pqCentroidsPerSubspace: 256, pqMaxIterations: 15
  });

  // Compatibilité fingerprint & sensibilité à l'ordre
  bdpmInt8.assertCompatibleWith(bdpmEsm);
  assertThrows(() => bdpmInt8.assertCompatibleWith(vetCjs), 'Must reject mismatching host (BDPM vs ANMV)');
  const swappedRows = [...bdpmState.corpus.specialites];
  [swappedRows[0], swappedRows[1]] = [swappedRows[1], swappedRows[0]];
  const bdpmSwapped = buildHostFromRows(cjsPkg.FrozenMiniSearch, swappedRows.slice(0, 50), bdpmSpec);
  assertThrows(() => bdpmInt8.assertCompatibleWith(bdpmSwapped), 'Must reject swapped/partial host');

  // Round-trip CJS -> ESM (non aligné) -> Browser (non aligné) -> CJS
  const binCjs = bdpmInt8.saveBinary();
  const loadedEsm = esmPkg.FrozenVectorIndex.loadBinary(makeUnalignedView(binCjs, 3), bdpmEsm);
  const binEsm = loadedEsm.saveBinary();
  const loadedBrowser = browserPkg.FrozenVectorIndex.loadBinary(makeUnalignedView(binEsm, 5), bdpmBrowser);
  const qVec = enc.encodeQuery('ibuprofene comprime').vec;
  const topCjs = bdpmInt8.topK(qVec, { k: 10 });
  const topEsm = loadedEsm.topK(qVec, { k: 10 });
  const topBrowser = loadedBrowser.topK(qVec, { k: 10 });
  assertCondition(
    JSON.stringify(topCjs.map((x) => [x.id, round(x.score, 6)])) ===
      JSON.stringify(topEsm.map((x) => [x.id, round(x.score, 6)])) &&
    JSON.stringify(topCjs.map((x) => [x.id, round(x.score, 6)])) ===
      JSON.stringify(topBrowser.map((x) => [x.id, round(x.score, 6)])),
    'CJS / ESM / Browser unaligned FXV1 round-trip topK must match bit-for-bit'
  );

  // Corruption CRC & trailing bytes
  const corruptHeader = new Uint8Array(binCjs);
  corruptHeader[16] ^= 0x01;
  assertThrows(() => cjsPkg.FrozenVectorIndex.loadBinary(corruptHeader, bdpmCjs), 'Must reject header CRC flip');
  const corruptBody = new Uint8Array(binCjs);
  corruptBody[corruptBody.length - 10] ^= 0x80;
  assertThrows(() => cjsPkg.FrozenVectorIndex.loadBinary(corruptBody, bdpmCjs), 'Must reject payload CRC flip');
  const trailing = new Uint8Array(binCjs.length + 1);
  trailing.set(binCjs);
  assertThrows(() => cjsPkg.FrozenVectorIndex.loadBinary(trailing, bdpmCjs), 'Must reject trailing byte');

  // Pre-k filter au-delà du rang 85 sur BDPM live (N = 15 845)
  const top100 = bdpmInt8.topK(qVec, { k: 100 });
  assertCondition(top100.length === 100, 'Expected 100 unfiltered results');
  const excludedTop90 = new Set(top100.slice(0, 90).map((r) => r.id));
  const filteredNext10 = bdpmInt8.topK(qVec, { k: 10, filter: (id) => !excludedTop90.has(id) });
  assertCondition(filteredNext10.length === 10, 'Expected 10 filtered results beyond rank 90');
  assertCondition(
    JSON.stringify(filteredNext10.map((r) => r.id)) === JSON.stringify(top100.slice(90, 100).map((r) => r.id)),
    'Pre-k filter past rank 85 must recover exact ranks 91..100'
  );

  return {
    version: pkgMeta.version,
    lexicalParity: { bdpmProbes: bdpmProbes.length, bdpmMismatches, vetProbes: vetProbes.length, vetMismatches },
    fxv1FingerprintBdpm: bdpmInt8.corpusFingerprint,
    fxv1FingerprintVet: vetInt8.corpusFingerprint,
    roundTripCjsEsmBrowserIdentical: true,
    corruptionChecksPassed: 3,
    preKFilterBeyondRank85Passed: true,
    indexes: {
      int8: { bdpm: bdpmInt8, vet: vetInt8 },
      pq32: { bdpm: bdpmPq32, vet: vetPq32 },
      pq16: { bdpm: bdpmPq16, vet: vetPq16 }
    }
  };
}

function hydrateSemanticHit(source, key, score) {
  const quality = score >= 0.72 ? 'semantic_strong' : 'semantic_weak';
  if (source === 'bdpm') {
    return {
      type: 'medicament',
      match_quality: quality,
      match_via: 'semantic',
      ...(getSpecialiteByCis(key) || { cis: key, url_bdpm: bdpmExtraitUrl(key) }),
      presentations: getRelatedByCis('presentations', key, HYDRATE_RELATED_LIMIT),
      compositions: getRelatedByCis('compositions', key, HYDRATE_RELATED_LIMIT),
      semantic_score: round(score, 4)
    };
  }
  return {
    type: 'medicament_veterinaire',
    match_quality: quality,
    match_via: 'semantic',
    ...(getMedicamentByNum(key) || { num: key }),
    presentations: getRelatedByNum('presentations', key),
    compositions: getRelatedByNum('compositions', key),
    semantic_score: round(score, 4)
  };
}

function createHybridSearchFn({ bdpmVec, vetVec, enc, minScore = 0.55, onTrace = null }) {
  return function hybridSearch(tcOrQ, arg2 = 1, arg3 = 10, arg4 = {}) {
    const isCaseObj = typeof tcOrQ === 'object' && tcOrQ !== null;
    const q = isCaseObj ? tcOrQ.q : tcOrQ;
    const source = isCaseObj ? (tcOrQ.source || 'auto') : (arg2 || 'auto');
    const page = isCaseObj ? arg2 : (arg3 ?? 1);
    const limit = isCaseObj ? arg3 : (arg4 ?? 10);
    const explicitCriteria = isCaseObj ? (arg4 || {}) : {};

    const b2 = executeExperimentalSearchPage(q, source, page, limit, explicitCriteria, { mode: 'concepts' });
    if (b2.search.abstained) {
      if (onTrace) onTrace('abstained', q, b2);
      return b2;
    }
    if (b2.total > 0) {
      let pathName = 'concepts_direct';
      if (b2.search.parsed && b2.search.parsed.kind === 'exact_code') pathName = 'exact_code';
      else if (b2.results[0] && (b2.results[0].match_via === 'generique' || b2.results[0].match_via === 'concept')) {
        pathName = 'concepts_relation';
      } else if (
        b2.search.parsed &&
        (b2.search.parsed.dosage || b2.search.parsed.forme || b2.search.parsed.voie ||
          (b2.search.parsed.intents && b2.search.parsed.intents.length > 0))
      ) {
        pathName = 'concepts_structured_or_alias';
      }
      if (onTrace) onTrace(pathName, q, b2);
      return b2;
    }

    const store = getConceptStore();
    const parsed = parseStructuredQuery(q, explicitCriteria, store.taxonomy, { useAliases: true });
    const safety = analyzeQuerySafetyAndIntent(q, parsed);
    if (!safety.supported) {
      if (onTrace) onTrace('abstained', q, b2);
      return b2;
    }

    // Ne jamais faire de repli vectoriel sur un code exact invalide (CIS/CIP13/GTIN/ATC inexistant)
    if (parsed.kind === 'exact_code') {
      if (onTrace) onTrace('exact_code_empty', q, b2);
      return b2;
    }

    const semText = buildSemanticQueryText(q, parsed);
    if (!semText) {
      if (onTrace) onTrace('semantic_skipped_empty', q, b2);
      return b2;
    }

    const { vec: qVec, matchedTerms } = enc.encodeQuery(semText);
    if (matchedTerms === 0) {
      if (onTrace) onTrace('semantic_skipped_oov', q, b2);
      return b2;
    }

    const srcNorm = (source || 'auto').toLowerCase();
    const speciesHintVet = parsed.extracted.species.length > 0 && srcNorm === 'auto';
    const wantBdpm = srcNorm === 'human' || srcNorm === 'mixed' || (srcNorm === 'auto' && !speciesHintVet);
    const wantVet = srcNorm === 'veterinary' || srcNorm === 'mixed' || srcNorm === 'auto';

    const queried = [];
    const withResults = [];
    const candidates = [];
    const seenKeys = new Set();

    if (wantVet) {
      queried.push('anmv');
      const vetHits = vetVec.topK(qVec, { k: 40, minScore });
      if (vetHits.length > 0) withResults.push('anmv');
      for (const h of vetHits) {
        const rec = vetState.corpus.medicaments[h.id];
        if (!rec) continue;
        const dk = `vet:${rec.num}`;
        if (seenKeys.has(dk)) continue;
        seenKeys.add(dk);
        candidates.push({ source: 'vet', key: rec.num, score: h.score, label: rec.nom || rec.num });
      }
    }

    const vetHasHits = candidates.length > 0;
    if (wantBdpm && !(speciesHintVet && vetHasHits)) {
      queried.push('bdpm');
      const bdpmHits = bdpmVec.topK(qVec, { k: 40, minScore });
      if (bdpmHits.length > 0) withResults.push('bdpm');
      for (const h of bdpmHits) {
        const rec = bdpmState.corpus.specialites[h.id];
        if (!rec) continue;
        const dk = `bdpm:${rec.cis}`;
        if (seenKeys.has(dk)) continue;
        seenKeys.add(dk);
        candidates.push({ source: 'bdpm', key: rec.cis, score: h.score, label: rec.denomination || rec.cis });
      }
    }

    if (candidates.length === 0) {
      if (onTrace) onTrace('semantic_fallback_abstained', q, b2);
      return b2;
    }

    candidates.sort((a, b) => (b.score - a.score) || a.label.localeCompare(b.label, 'fr'));
    const { offset, safeLimit } = parseListPaging(page, limit);
    const sliced = candidates.slice(offset, offset + safeLimit);
    const results = sliced.map((c) => hydrateSemanticHit(c.source, c.key, c.score));

    const out = {
      total: candidates.length,
      results,
      search: {
        ...b2.search,
        mode: 'concepts+fxv1_semantic_fallback',
        referentiels: { queried, with_results: withResults },
        semantic_fallback_used: true,
        semantic_min_score: minScore,
        top_cosine: round(candidates[0].score, 4)
      }
    };
    if (onTrace) onTrace('semantic_fallback_hit', q, out);
    return out;
  };
}

function buildDevCalibrationProbes() {
  return [
    // Symtômes / questions thérapeutiques / hors corpus (doivent abstenir ou 0 résultat à >=0.55)
    { q: 'quel sirop contre toux seche', expectedAbstainOrEmpty: true, kind: 'oos_symptom' },
    { q: 'traitement hypertension arterielle', expectedAbstainOrEmpty: true, kind: 'oos_symptom' },
    { q: 'medicament mal de gorge intense', expectedAbstainOrEmpty: true, kind: 'oos_symptom' },
    { q: 'remede migraine chronique', expectedAbstainOrEmpty: true, kind: 'oos_symptom' },
    { q: 'solution pour dormir rapidement', expectedAbstainOrEmpty: true, kind: 'oos_symptom' },
    { q: 'antibiotique sans ordonnance', expectedAbstainOrEmpty: true, kind: 'oos_clinical' },
    { q: 'xyzabc999888medic', expectedAbstainOrEmpty: true, kind: 'oos_nonsense' },
    { q: '3400999999999', expectedAbstainOrEmpty: true, kind: 'invalid_cip13' },
    { q: '99999999', expectedAbstainOrEmpty: true, kind: 'invalid_cis' },
    // Sécurité A1 : négations & RCP cliniques (doivent abstenir)
    { q: 'pas de paracetamol', expectedAbstainOrEmpty: true, kind: 'a1_negation' },
    { q: 'doliprane sans codeine', expectedAbstainOrEmpty: true, kind: 'a1_negation' },
    { q: 'sans ibuprofene ni aspirine', expectedAbstainOrEmpty: true, kind: 'a1_multi_negation' },
    { q: 'ibuprofene contre indique grossesse', expectedAbstainOrEmpty: true, kind: 'a1_rcp' },
    { q: 'non contre indique pendant la grossesse', expectedAbstainOrEmpty: true, kind: 'a1_rcp_negated' },
    { q: 'effets indesirables amoxicilline', expectedAbstainOrEmpty: true, kind: 'a1_rcp_adverse' },
    // Légitimes hors-RCP : doivent passer & être supportés
    { q: 'doliprane sans sucre', expectedAbstainOrEmpty: false, expectSupported: true, kind: 'a1_verbatim_sans' },
    { q: 'douleur adulte 70 kg', expectedAbstainOrEmpty: true, expectWeightNoPed: true, kind: 'a1_weight_guard' },
    // Repli sémantique DEV valide (doivent passer au seuil gelé >=0.55)
    { q: 'ibuprofene comprime a avaler', expectedAbstainOrEmpty: false, expectFallback: true, expectSubstr: 'IBUPROFENE', kind: 'dev_r2_human' },
    { q: 'medicament metacam chien', expectedAbstainOrEmpty: false, expectFallback: true, expectSubstr: 'METACAM', kind: 'dev_r2_vet' }
  ];
}

function summarizeSystemEval(res) {
  return {
    summary: res.summary,
    byFamily: res.byFamily
  };
}

async function runHttpPairedBenchmark(hybridFn, queries) {
  const app = express();
  app.use(express.json());
  app.use('/api/medicaments', medicamentRoutes);
  app.get('/api/medicaments/search-hybrid', (req, res) => {
    const { q, page = 1, limit = 10, source, dosage, forme, voie, detail } = req.query;
    if (!q) return res.status(400).json({ error: 'q requis' });
    const criteria = {
      dosage: dosage || null,
      forme: forme || null,
      voie: voie || null
    };
    const { results, total, search } = hybridFn({ q, source: source || 'auto' }, page, limit, criteria);
    const shaped = shapeSearchResults(results, { detail: detail === 'full' ? 'full' : 'summary' });
    const response = buildPagedResponse({
      total, page, limit, metadata: getMetadata(), materializePage: () => shaped
    });
    response.search = search;
    return res.json(response);
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const modes = ['legacy', 'structured', 'concepts', 'hybrid_int8'];
  const buildUrl = (mode, qObj) => {
    const qs = `q=${encodeURIComponent(qObj.q)}&source=${encodeURIComponent(qObj.source || 'auto')}&limit=10`;
    if (mode === 'hybrid_int8') return `${baseUrl}/api/medicaments/search-hybrid?${qs}`;
    return `${baseUrl}/api/medicaments/search?${qs}&mode=${mode}`;
  };

  // Warmup
  for (const qObj of queries.slice(0, 12)) {
    for (const m of modes) {
      const r = await fetch(buildUrl(m, qObj));
      await r.json();
    }
  }

  // 4 rondes alternées (ABCD, DCBA, ABCD, DCBA) pour neutraliser biais d'ordre/JIT/cache CPU
  const perModeSamples = Object.fromEntries(modes.map((m) => [m, []]));
  const perPairByQuery = [];
  for (let roundIdx = 0; roundIdx < 4; roundIdx++) {
    const order = roundIdx % 2 === 0 ? modes : [...modes].reverse();
    for (const qObj of queries) {
      const roundTimes = {};
      for (const m of order) {
        const t0 = process.hrtime.bigint();
        const resp = await fetch(buildUrl(m, qObj));
        assertCondition(resp.status === 200, `HTTP ${resp.status} for mode=${m}`);
        await resp.json();
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        perModeSamples[m].push(ms);
        roundTimes[m] = ms;
      }
      perPairByQuery.push({
        round: roundIdx,
        deltaHybridMinusB2: roundTimes.hybrid_int8 - roundTimes.concepts,
        deltaHybridMinusB0: roundTimes.hybrid_int8 - roundTimes.legacy
      });
    }
  }

  await new Promise((resolve) => server.close(resolve));

  const stats = {};
  for (const m of modes) {
    const arr = perModeSamples[m];
    const p25 = percentile(arr, 0.25);
    const p50 = percentile(arr, 0.5);
    const p75 = percentile(arr, 0.75);
    const p95 = percentile(arr, 0.95);
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    stats[m] = {
      requests: arr.length,
      p50Ms: round(p50, 2),
      iqrMs: round(p75 - p25, 2),
      p95Ms: round(p95, 2),
      meanMs: round(mean, 2)
    };
  }
  return {
    queriesPerRound: queries.length,
    rounds: 4,
    alternatingOrder: 'ABCD / DCBA',
    modes: stats,
    pairedDeltaMedianMs: {
      hybridMinusB2: round(percentile(perPairByQuery.map((x) => x.deltaHybridMinusB2), 0.5), 3),
      hybridMinusB0: round(percentile(perPairByQuery.map((x) => x.deltaHybridMinusB0), 0.5), 3)
    }
  };
}

async function main() {
  await loadData();
  await loadVetData();
  getConceptStore();

  const enc = loadStaticWordPieceEncoder(128, { useF32: false });
  const built = buildControlledDocuments(
    bdpmState.corpus,
    vetState.corpus,
    bdpmState.cisIndexes,
    vetState.numIndexes
  );
  const bdpmF32 = enc.encodeDocuments(built.docs.slice(0, built.bdpmCount));
  const vetF32 = enc.encodeDocuments(built.docs.slice(built.bdpmCount));

  console.log('=== 1. TARBALL @yoch/frozenminisearch@1.13.0 CROSS-VALIDATION ===');
  const tarballCheck = await runTarballCrossValidation(bdpmF32, vetF32, enc);
  console.log(JSON.stringify({
    version: tarballCheck.version,
    lexicalParity: tarballCheck.lexicalParity,
    fxv1FingerprintBdpm: tarballCheck.fxv1FingerprintBdpm,
    fxv1FingerprintVet: tarballCheck.fxv1FingerprintVet,
    roundTripCjsEsmBrowserIdentical: tarballCheck.roundTripCjsEsmBrowserIdentical,
    corruptionChecksPassed: tarballCheck.corruptionChecksPassed,
    preKFilterBeyondRank85Passed: tarballCheck.preKFilterBeyondRank85Passed
  }, null, 2));

  const evalV3 = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval_suite_v3.json'), 'utf8'));
  const evalRes = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval_residual_v1.json'), 'utf8'));
  const devProbes = buildDevCalibrationProbes();

  // Vérification spécifique A1 poids patient & verbatim sans sucre
  const weightParsed = parseStructuredQuery('douleur adulte 70 kg', {}, getConceptStore().taxonomy, { useAliases: true });
  const weightSafety = analyzeQuerySafetyAndIntent('douleur adulte 70 kg', weightParsed);
  const sansSucreParsed = parseStructuredQuery('doliprane sans sucre', {}, getConceptStore().taxonomy, { useAliases: true });
  const sansSucreSafety = analyzeQuerySafetyAndIntent('doliprane sans sucre', sansSucreParsed);
  assertCondition(weightParsed.effectiveCriteria.dosage === null && weightSafety.patientWeight === '70 kg' && !weightSafety.pediatricInferred, 'Weight guard failed');
  assertCondition(sansSucreSafety.supported && sansSucreSafety.verbatimQualifiers.includes('sans sucre'), 'Verbatim sans sucre failed');

  console.log('\n=== 2. DEV-ONLY THRESHOLD SWEEP & FREEZE (NEVER USING HELDOUT) ===');
  const thresholds = [0.35, 0.45, 0.50, 0.55, 0.60, 0.65];
  const devCalibration = [];
  for (const th of thresholds) {
    const fn = createHybridSearchFn({
      bdpmVec: tarballCheck.indexes.int8.bdpm,
      vetVec: tarballCheck.indexes.int8.vet,
      enc,
      minScore: th
    });
    const resDev = await evaluateSystem(`Hybrid_Int8_DEV_${th}`, evalRes, (tc, p, l) => fn(tc, p, l), { split: 'dev' });
    let probePass = 0;
    let probeFalsePositiveOos = 0;
    let probeFallbackHit = 0;
    for (const p of devProbes) {
      const out = fn({ q: p.q, source: 'auto' }, 1, 10);
      if (p.expectedAbstainOrEmpty) {
        if (out.total === 0) probePass++;
        else probeFalsePositiveOos++;
      } else {
        if (out.total > 0) {
          probePass++;
          if (p.expectFallback) {
            const topName = normalizeSearchText(out.results[0].denomination || out.results[0].nom || '');
            if (topName.includes(normalizeSearchText(p.expectSubstr))) probeFallbackHit++;
          }
        }
      }
    }
    devCalibration.push({
      threshold: th,
      residualDevVar1: resDev.summary.variantTop1,
      residualDevR2: resDev.byFamily.R2_patient_noise_unaliased.variantTop1,
      residualDevOosNonEmpty: resDev.summary.oosNonEmptyRate,
      devProbesPassed: `${probePass}/${devProbes.length}`,
      devProbeOosFalsePositives: probeFalsePositiveOos,
      devFallbackValidHits: `${probeFallbackHit}/2`
    });
  }
  console.log(JSON.stringify(devCalibration, null, 2));

  // GEL EXPLICITE DU SEUIL AVANT TOUTE ÉVALUATION HELDOUT
  const FROZEN_MIN_SCORE = 0.55;
  console.log(`\n[FREEZE] FROZEN_MIN_SCORE = ${FROZEN_MIN_SCORE} (Int8 WordPiece Static-128 via @yoch/frozenminisearch@1.13.0)`);

  const traceDev = {};
  const traceHeldout = {};
  const makeCounter = (storeMap) => (pathName, _q, out) => {
    storeMap[pathName] = (storeMap[pathName] || 0) + 1;
    if (out.search && out.search.semantic_fallback_used) {
      for (const r of out.results || []) {
        if (r.match_via === 'exact' || r.match_via !== 'semantic') {
          throw new Error(`Invalid provenance on semantic fallback: match_via=${r.match_via}`);
        }
      }
    }
  };

  const systems = {
    B0_legacy: (tc, page = 1, limit = 10) => executeHybridSearchPage(tc.q, tc.source || 'auto', page, limit, {}),
    B1_structured: (tc, page = 1, limit = 10) => executeExperimentalSearchPage(tc.q, tc.source || 'auto', page, limit, {}, { mode: 'structured' }),
    B2_concepts: (tc, page = 1, limit = 10) => executeExperimentalSearchPage(tc.q, tc.source || 'auto', page, limit, {}, { mode: 'concepts' }),
    Hybrid_Int8_Tarball_055: null,
    Hybrid_PQ32_Tarball_055: createHybridSearchFn({
      bdpmVec: tarballCheck.indexes.pq32.bdpm,
      vetVec: tarballCheck.indexes.pq32.vet,
      enc,
      minScore: FROZEN_MIN_SCORE
    }),
    Hybrid_PQ16_Tarball_055: createHybridSearchFn({
      bdpmVec: tarballCheck.indexes.pq16.bdpm,
      vetVec: tarballCheck.indexes.pq16.vet,
      enc,
      minScore: FROZEN_MIN_SCORE
    })
  };

  const hybridDevRunner = createHybridSearchFn({
    bdpmVec: tarballCheck.indexes.int8.bdpm,
    vetVec: tarballCheck.indexes.int8.vet,
    enc,
    minScore: FROZEN_MIN_SCORE,
    onTrace: makeCounter(traceDev)
  });
  const hybridHeldoutRunner = createHybridSearchFn({
    bdpmVec: tarballCheck.indexes.int8.bdpm,
    vetVec: tarballCheck.indexes.int8.vet,
    enc,
    minScore: FROZEN_MIN_SCORE,
    onTrace: makeCounter(traceHeldout)
  });

  console.log('\n=== 3. SINGLE FROZEN BENCHMARK RUN (DEV & HELDOUT — SANS AFFICHAGE DE REQUÊTES HELDOUT) ===');
  const results = { v3: { dev: {}, heldout: {} }, residual: { dev: {}, heldout: {} } };

  for (const [sysName, baseFn] of Object.entries(systems)) {
    for (const split of ['dev', 'heldout']) {
      const fn = sysName === 'Hybrid_Int8_Tarball_055'
        ? (split === 'dev' ? hybridDevRunner : hybridHeldoutRunner)
        : baseFn;

      const v3All = await evaluateSystem(`${sysName}_v3_${split}`, evalV3, fn, { split });
      const v3Cur = await evaluateSystem(`${sysName}_v3_${split}_cur`, evalV3, fn, { split, provenance: 'curated' });
      const v3Gen = await evaluateSystem(`${sysName}_v3_${split}_gen`, evalV3, fn, { split, provenance: 'corpus_generated' });
      results.v3[split][sysName] = {
        all: summarizeSystemEval(v3All),
        curated: v3Cur.summary,
        corpus_generated: v3Gen.summary
      };

      const resAll = await evaluateSystem(`${sysName}_res_${split}`, evalRes, fn, { split });
      results.residual[split][sysName] = summarizeSystemEval(resAll);
    }
  }

  // Vérification d'invariants pagination & provenance
  const pagInvariance = [];
  for (const q of ['paracetamol', 'ibuprofene comprime a avaler', 'medicament metacam chien']) {
    const p1 = hybridDevRunner({ q, source: 'auto' }, 1, 5);
    const p2 = hybridDevRunner({ q, source: 'auto' }, 2, 5);
    const full = hybridDevRunner({ q, source: 'auto' }, 1, 10);
    const idsSplit = [...p1.results, ...p2.results].map((r) => r.cis || r.num);
    const idsFull = full.results.map((r) => r.cis || r.num);
    pagInvariance.push({
      q,
      total: full.total,
      dedupUnique: new Set(idsSplit).size === idsSplit.length,
      matchesFull10: JSON.stringify(idsSplit) === JSON.stringify(idsFull),
      matchVia: full.results[0] ? full.results[0].match_via : null
    });
  }

  // Benchmark HTTP E2E apparié en ordre alterné sur les requêtes DEV (V3 + Residual + Probes)
  const devHttpQueries = [
    ...evalV3.cases.filter((c) => c.split === 'dev').map((c) => ({ q: c.q, source: c.source || 'auto' })),
    ...evalRes.cases.filter((c) => c.split === 'dev').map((c) => ({ q: c.q, source: c.source || 'auto' }))
  ];
  const httpE2E = await runHttpPairedBenchmark(
    createHybridSearchFn({
      bdpmVec: tarballCheck.indexes.int8.bdpm,
      vetVec: tarballCheck.indexes.int8.vet,
      enc,
      minScore: FROZEN_MIN_SCORE
    }),
    devHttpQueries
  );

  const report = {
    generatedAt: new Date().toISOString(),
    frozenMinScore: FROZEN_MIN_SCORE,
    tarballCheck: {
      version: tarballCheck.version,
      lexicalParity: tarballCheck.lexicalParity,
      fxv1FingerprintBdpm: tarballCheck.fxv1FingerprintBdpm,
      fxv1FingerprintVet: tarballCheck.fxv1FingerprintVet,
      roundTripCjsEsmBrowserIdentical: tarballCheck.roundTripCjsEsmBrowserIdentical,
      corruptionChecksPassed: tarballCheck.corruptionChecksPassed,
      preKFilterBeyondRank85Passed: tarballCheck.preKFilterBeyondRank85Passed
    },
    a1SafetyChecks: {
      weightParsedDosage: weightParsed.effectiveCriteria.dosage,
      weightSafety,
      sansSucreSafety
    },
    devThresholdSweep: devCalibration,
    executionPathTraces: { dev: traceDev, heldout: traceHeldout },
    paginationAndProvenanceInvariance: pagInvariance,
    httpE2EPairedAlternating: httpE2E,
    results
  };

  fs.writeFileSync(
    path.join(__dirname, 'final_mission_validation.json'),
    `${JSON.stringify(report, null, 2)}\n`
  );

  const compact = (suite, split) => Object.fromEntries(
    Object.entries(results[suite][split]).map(([k, v]) => [k, v.all ? v.all.summary : v.summary])
  );
  console.log('\n--- V3 DEV ---');
  console.log(JSON.stringify(compact('v3', 'dev'), null, 2));
  console.log('\n--- V3 HELDOUT (FROZEN) ---');
  console.log(JSON.stringify(compact('v3', 'heldout'), null, 2));
  console.log('\n--- RESIDUAL DEV ---');
  console.log(JSON.stringify(compact('residual', 'dev'), null, 2));
  console.log('\n--- RESIDUAL HELDOUT (FROZEN) ---');
  console.log(JSON.stringify(compact('residual', 'heldout'), null, 2));
  console.log('\n--- TRACE PATHS & HTTP E2E ---');
  console.log(JSON.stringify({ traceDev, traceHeldout, pagInvariance, httpE2E }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
