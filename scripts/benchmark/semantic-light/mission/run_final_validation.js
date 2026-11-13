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
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
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
const { getConceptStore, getTaxonomyVocab } = require('../../../../src/search/conceptStore');
const { normalizeSearchText } = require('../../../../src/utils/searchRanking');
const { parseListPaging, buildPagedResponse } = require('../../../../src/utils/corpusPaging');
const { shapeSearchResults } = require('../../../../src/utils/searchResponseShape');
const medicamentRoutes = require('../../../../src/routes/medicaments');
const { evaluateSystem } = require('./eval_harness');
const { buildControlledDocuments, loadStaticWordPieceEncoder } = require('./b3_encoders');

const PKG_VERIFY_ROOT =
  process.env.FROZENMINISEARCH_PKG_ROOT ||
  '/home/yoch/.gemini/antigravity-cli/brain/94228641-cb35-4e73-bd50-3e5b84af2042/scratch/pkg-verify';
const PKG_DIR = path.join(PKG_VERIFY_ROOT, 'package');
const pkgRequire = createRequire(path.join(PKG_VERIFY_ROOT, 'consumer.js'));
const MODEL_DIR = path.join(__dirname, '../../../../data/search-indexes/mission-semantic');
const TARBALL_PATH =
  process.env.FROZENMINISEARCH_TGZ ||
  '/home/yoch/.gemini/antigravity-cli/brain/94228641-cb35-4e73-bd50-3e5b84af2042/scratch/yoch-frozenminisearch-1.13.0.tgz';
const SEMANTIC_CANDIDATE_CAP = 40;

function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

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

function gitInfo(repoPath) {
  try {
    const head = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const branch = execFileSync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', repoPath, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    return { branch, head, clean: dirty.length === 0 };
  } catch (e) {
    return { error: e.message };
  }
}

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
  // Consommation via exports officiels '.', './vectors', './vectors/train' + browser
  const cjsMain = pkgRequire('@yoch/frozenminisearch');
  const cjsVec = pkgRequire('@yoch/frozenminisearch/vectors');
  const cjsTrain = pkgRequire('@yoch/frozenminisearch/vectors/train');
  const esmMain = await import(pathToFileURL(path.join(PKG_DIR, 'dist/es/index.js')).href);
  const esmVec = await import(pathToFileURL(path.join(PKG_DIR, 'dist/es/vectors.js')).href);
  const browserMain = await import(pathToFileURL(path.join(PKG_DIR, 'dist/browser/index.js')).href);
  const browserVec = await import(pathToFileURL(path.join(PKG_DIR, 'dist/browser/vectors.js')).href);
  const pkgMeta = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
  assertCondition(pkgMeta.version === '1.13.0', `Expected tarball 1.13.0, got ${pkgMeta.version}`);

  // Séparation stricte des bundles principaux vs ./vectors vs ./vectors/train
  assertCondition(cjsMain.FrozenVectorIndex === undefined, 'Main bundle CJS must not re-export FrozenVectorIndex');
  assertCondition(esmMain.FrozenVectorIndex === undefined, 'Main bundle ESM must not re-export FrozenVectorIndex');
  assertCondition(browserMain.FrozenVectorIndex === undefined, 'Main bundle Browser must not re-export FrozenVectorIndex');
  assertCondition(typeof cjsVec.FrozenVectorIndex === 'function', 'Subpath ./vectors must export FrozenVectorIndex');
  assertCondition(typeof cjsTrain.encodeDenseVectorPack === 'function', 'Subpath ./vectors/train must export encodeDenseVectorPack');

  const bdpmSpec = BDPM_INDEX_SPECS.specialites;
  const vetSpec = VET_INDEX_SPECS.medicaments;
  const bdpmCjs = buildHostFromRows(cjsMain.FrozenMiniSearch, bdpmState.corpus.specialites, bdpmSpec);
  const vetCjs = buildHostFromRows(cjsMain.FrozenMiniSearch, vetState.corpus.medicaments, vetSpec);
  const bdpmEsm = buildHostFromRows(esmMain.FrozenMiniSearch, bdpmState.corpus.specialites, bdpmSpec);
  const vetEsm = buildHostFromRows(esmMain.FrozenMiniSearch, vetState.corpus.medicaments, vetSpec);
  const bdpmBrowser = buildHostFromRows(browserMain.FrozenMiniSearch, bdpmState.corpus.specialites, bdpmSpec);

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

  // 2. Identités FXV1 v2 (representationVersion + snapshotId déterministe)
  const metaPath = path.join(MODEL_DIR, 'static_mrl_128d.meta.json');
  const int8WeightPath = path.join(MODEL_DIR, 'static_mrl_128d_int8.bin');
  const bdpmExpected = {
    representationVersion: 'static-wp-mrl-128d-int8:v1',
    snapshotId: computeCorpusSnapshotId('bdpm', bdpmState.corpus.specialites, 'denomination', int8WeightPath, metaPath)
  };
  const vetExpected = {
    representationVersion: 'static-wp-mrl-128d-int8:v1',
    snapshotId: computeCorpusSnapshotId('anmv', vetState.corpus.medicaments, 'nom', int8WeightPath, metaPath)
  };

  // Construction Int8 via ./vectors et PQ32 / PQ16 via ./vectors/train
  const bdpmInt8 = cjsVec.FrozenVectorIndex.fromDenseFloat32(bdpmCjs, bdpmF32, {
    quantization: 'int8', dim: 128, metric: 'cosine', normalize: true, ...bdpmExpected
  });
  const vetInt8 = cjsVec.FrozenVectorIndex.fromDenseFloat32(vetCjs, vetF32, {
    quantization: 'int8', dim: 128, metric: 'cosine', normalize: true, ...vetExpected
  });
  assertCondition(bdpmInt8.stats().normalized === true && vetInt8.stats().normalized === true, 'normalize: true must report stats().normalized=true');

  const pq32BdpmBytes = cjsTrain.encodeDenseVectorPack(bdpmCjs, bdpmF32, {
    quantization: 'pq', dim: 128, metric: 'cosine', normalize: true, pqSubspaces: 32, pqIterations: 15, ...bdpmExpected
  });
  const pq32VetBytes = cjsTrain.encodeDenseVectorPack(vetCjs, vetF32, {
    quantization: 'pq', dim: 128, metric: 'cosine', normalize: true, pqSubspaces: 32, pqIterations: 15, ...vetExpected
  });
  const pq16BdpmBytes = cjsTrain.encodeDenseVectorPack(bdpmCjs, bdpmF32, {
    quantization: 'pq', dim: 128, metric: 'cosine', normalize: true, pqSubspaces: 16, pqIterations: 15, ...bdpmExpected
  });
  const pq16VetBytes = cjsTrain.encodeDenseVectorPack(vetCjs, vetF32, {
    quantization: 'pq', dim: 128, metric: 'cosine', normalize: true, pqSubspaces: 16, pqIterations: 15, ...vetExpected
  });

  const tLoadInt80 = process.hrtime.bigint();
  const binCjs = bdpmInt8.saveBinary();
  const loadedEsm = esmVec.FrozenVectorIndex.loadBinary(makeUnalignedView(binCjs, 3), bdpmEsm, bdpmExpected);
  const loadInt8EsmMs = round(Number(process.hrtime.bigint() - tLoadInt80) / 1e6, 2);

  const tLoadPq320 = process.hrtime.bigint();
  const bdpmPq32 = cjsVec.FrozenVectorIndex.loadBinary(pq32BdpmBytes, bdpmCjs, bdpmExpected);
  const loadPq32BdpmMs = round(Number(process.hrtime.bigint() - tLoadPq320) / 1e6, 2);
  const vetPq32 = cjsVec.FrozenVectorIndex.loadBinary(pq32VetBytes, vetCjs, vetExpected);

  const tLoadPq160 = process.hrtime.bigint();
  const bdpmPq16 = cjsVec.FrozenVectorIndex.loadBinary(pq16BdpmBytes, bdpmCjs, bdpmExpected);
  const loadPq16BdpmMs = round(Number(process.hrtime.bigint() - tLoadPq160) / 1e6, 2);
  const vetPq16 = cjsVec.FrozenVectorIndex.loadBinary(pq16VetBytes, vetCjs, vetExpected);

  // Compatibilité fingerprint, snapshotId, representationVersion & sensibilité à l'ordre
  bdpmInt8.assertCompatibleWith(bdpmEsm, bdpmExpected);
  assertThrows(() => bdpmInt8.assertCompatibleWith(bdpmEsm, { ...bdpmExpected, representationVersion: 'wrong-ver' }), 'Must reject representationVersion mismatch');
  assertThrows(() => bdpmInt8.assertCompatibleWith(bdpmEsm, { ...bdpmExpected, snapshotId: 'sha256:0000' }), 'Must reject snapshotId mismatch');
  assertThrows(() => bdpmInt8.assertCompatibleWith(vetCjs, bdpmExpected), 'Must reject mismatching host (BDPM vs ANMV)');
  const swappedRows = [...bdpmState.corpus.specialites];
  [swappedRows[0], swappedRows[1]] = [swappedRows[1], swappedRows[0]];
  const bdpmSwapped = buildHostFromRows(cjsMain.FrozenMiniSearch, swappedRows.slice(0, 50), bdpmSpec);
  assertThrows(() => bdpmInt8.assertCompatibleWith(bdpmSwapped, bdpmExpected), 'Must reject swapped/partial host');

  // Round-trip CJS -> ESM (non aligné) -> Browser (non aligné)
  const binEsm = loadedEsm.saveBinary();
  const loadedBrowser = browserVec.FrozenVectorIndex.loadBinary(makeUnalignedView(binEsm, 5), bdpmBrowser, bdpmExpected);
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

  // Rejet expected mismatch au loadBinary + corruption CRC & trailing bytes
  assertThrows(
    () => cjsVec.FrozenVectorIndex.loadBinary(binCjs, bdpmCjs, { ...bdpmExpected, representationVersion: 'wrong' }),
    'loadBinary must reject representationVersion mismatch'
  );
  assertThrows(
    () => cjsVec.FrozenVectorIndex.loadBinary(binCjs, bdpmCjs, { ...bdpmExpected, snapshotId: 'sha256:stale' }),
    'loadBinary must reject snapshotId mismatch'
  );
  const corruptHeader = new Uint8Array(binCjs);
  corruptHeader[16] ^= 0x01;
  assertThrows(() => cjsVec.FrozenVectorIndex.loadBinary(corruptHeader, bdpmCjs, bdpmExpected), 'Must reject header CRC flip');
  const corruptBody = new Uint8Array(binCjs);
  corruptBody[corruptBody.length - 10] ^= 0x80;
  assertThrows(() => cjsVec.FrozenVectorIndex.loadBinary(corruptBody, bdpmCjs, bdpmExpected), 'Must reject payload CRC flip');
  const trailing = new Uint8Array(binCjs.length + 1);
  trailing.set(binCjs);
  assertThrows(() => cjsVec.FrozenVectorIndex.loadBinary(trailing, bdpmCjs, bdpmExpected), 'Must reject trailing byte');

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
    subpathSplitVerified: true,
    lexicalParity: { bdpmProbes: bdpmProbes.length, bdpmMismatches, vetProbes: vetProbes.length, vetMismatches },
    fxv1BdpmMeta: { ...bdpmExpected, mappingFingerprint: bdpmInt8.mappingFingerprint, byteLength: bdpmInt8.byteLength },
    fxv1VetMeta: { ...vetExpected, mappingFingerprint: vetInt8.mappingFingerprint, byteLength: vetInt8.byteLength },
    loadBinaryBdpmMs: { int8Esm: loadInt8EsmMs, pq32: loadPq32BdpmMs, pq16: loadPq16BdpmMs },
    roundTripCjsEsmBrowserIdentical: true,
    corruptionAndMetadataChecksPassed: 8,
    preKFilterBeyondRank85Passed: true,
    pkgBindings: { cjsMain, cjsVec },
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

function createHybridSearchFn({
  bdpmVec,
  vetVec,
  enc,
  minScore = 0.55,
  candidateCap = SEMANTIC_CANDIDATE_CAP,
  isAdmissible = null,
  onTrace = null
}) {
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

    const taxonomy = getTaxonomyVocab();
    const parsed = parseStructuredQuery(q, explicitCriteria, taxonomy, { useAliases: true });
    const safety = analyzeQuerySafetyAndIntent(q, parsed, explicitCriteria);
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

    const rawSrc = (source || 'auto').toLowerCase();
    const srcNorm = ['auto', 'human', 'veterinary', 'mixed'].includes(rawSrc) ? rawSrc : 'auto';
    const speciesHintVet = parsed.extracted.species.length > 0 && srcNorm === 'auto';
    const store = parsed.extracted.species.length > 0 ? getConceptStore() : null;

    const makeFilter = (targetSource) => {
      if (!isAdmissible && !(targetSource === 'vet' && parsed.extracted.species.length > 0)) {
        return undefined;
      }
      return (_id, shortId) => {
        const rec = targetSource === 'bdpm'
          ? bdpmState.corpus.specialites[shortId]
          : vetState.corpus.medicaments[shortId];
        if (!rec) return false;
        if (targetSource === 'vet' && parsed.extracted.species.length > 0 && store) {
          const vRec = store.vetByNum.get(rec.num);
          if (!vRec || !parsed.extracted.species.every((sp) => vRec.speciesTokens.has(sp))) {
            return false;
          }
        }
        if (isAdmissible && !isAdmissible(targetSource, rec, shortId)) {
          return false;
        }
        return true;
      };
    };

    const queried = [];
    const withResults = [];
    const candidates = [];
    const seenKeys = new Set();
    let anyTruncated = false;

    const collectFromIndex = (targetSource, vecIndex, refLabel) => {
      if (!vecIndex) return 0;
      queried.push(refLabel);
      const hits = vecIndex.topK(qVec, {
        k: candidateCap + 1,
        minScore,
        filter: makeFilter(targetSource)
      });
      if (hits.length > candidateCap) anyTruncated = true;
      const capped = hits.length > candidateCap ? hits.slice(0, candidateCap) : hits;
      if (capped.length > 0) withResults.push(refLabel);
      let added = 0;
      for (const h of capped) {
        const rec = targetSource === 'bdpm'
          ? bdpmState.corpus.specialites[h.id]
          : vetState.corpus.medicaments[h.id];
        if (!rec) continue;
        const key = targetSource === 'bdpm' ? rec.cis : rec.num;
        const dk = `${targetSource}:${key}`;
        if (seenKeys.has(dk)) continue;
        seenKeys.add(dk);
        candidates.push({
          source: targetSource,
          key,
          score: h.score,
          label: (targetSource === 'bdpm' ? rec.denomination : rec.nom) || key
        });
        added++;
      }
      return added;
    };

    let sourcePolicy = 'human_only';
    if (srcNorm === 'human') {
      sourcePolicy = 'human_only';
      collectFromIndex('bdpm', bdpmVec, 'bdpm');
    } else if (srcNorm === 'veterinary') {
      sourcePolicy = 'veterinary_only';
      collectFromIndex('vet', vetVec, 'anmv');
    } else if (srcNorm === 'mixed') {
      sourcePolicy = 'mixed_both';
      collectFromIndex('bdpm', bdpmVec, 'bdpm');
      collectFromIndex('vet', vetVec, 'anmv');
    } else if (speciesHintVet) {
      sourcePolicy = 'auto_vet_species_priority';
      const vetAdded = collectFromIndex('vet', vetVec, 'anmv');
      if (vetAdded === 0) {
        collectFromIndex('bdpm', bdpmVec, 'bdpm');
      }
    } else {
      sourcePolicy = 'auto_human_then_vet';
      const bdpmAdded = collectFromIndex('bdpm', bdpmVec, 'bdpm');
      if (bdpmAdded === 0) {
        collectFromIndex('vet', vetVec, 'anmv');
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
        top_cosine: round(candidates[0].score, 4),
        semantic_fallback: {
          bounded: true,
          candidate_cap: candidateCap,
          returned_pool_count: candidates.length,
          truncated: anyTruncated,
          total_is_lower_bound: anyTruncated,
          total_semantics: anyTruncated ? 'bounded_lower_bound' : 'exhaustive_above_min_score',
          page_out_of_bounded_window: anyTruncated && offset >= candidateCap,
          source_policy: sourcePolicy
        }
      }
    };
    if (onTrace) onTrace('semantic_fallback_hit', q, out);
    return out;
  };
}

function runFallbackContractTests({ tarballCheck, enc, minScore }) {
  const { bdpm: bdpmVec, vet: vetVec } = tarballCheck.indexes.int8;
  const { cjsMain, cjsVec } = tarballCheck.pkgBindings;
  const qProbe = 'ibuprofene comprime a avaler';
  const parsedProbe = parseStructuredQuery(qProbe, {}, getTaxonomyVocab(), { useAliases: true });
  const qVec = enc.encodeQuery(buildSemanticQueryText(qProbe, parsedProbe)).vec;
  const rawPool = bdpmVec.topK(qVec, { k: 80, minScore });
  assertCondition(rawPool.length > 40, `Need >40 docs >=${minScore} on BDPM for bounded cap test, got ${rawPool.length}`);

  const fnBounded = createHybridSearchFn({ bdpmVec, vetVec, enc, minScore, candidateCap: 40 });
  const p1 = fnBounded({ q: qProbe, source: 'human' }, 1, 10);
  const p4 = fnBounded({ q: qProbe, source: 'human' }, 4, 10);
  const p5 = fnBounded({ q: qProbe, source: 'human' }, 5, 10);
  assertCondition(p1.search.semantic_fallback_used === true, 'Expected semantic fallback trigger');
  assertCondition(p1.total === 40 && p1.results.length === 10, 'Page 1 bounded pool must expose cap 40 and 10 results');
  assertCondition(p1.search.semantic_fallback.truncated === true && p1.search.semantic_fallback.total_is_lower_bound === true, 'Must signal truncated lower bound when >40 admissible exist');
  assertCondition(p1.search.semantic_fallback.total_semantics === 'bounded_lower_bound', 'Must mark bounded_lower_bound');
  assertCondition(p4.results.length === 10 && new Set([...p1.results, ...p4.results].map((r) => r.cis)).size === 20, 'Pages 1 and 4 must not collide');
  assertCondition(p5.results.length === 0 && p5.search.semantic_fallback.page_out_of_bounded_window === true, 'Deep page >=40 must stay empty and expose page_out_of_bounded_window');

  // Filtre pre-k sur BDPM réel excluant le top 35 : récupère 10 docs admissibles au-delà du rang 35
  const excludedLiveIds = new Set(rawPool.slice(0, 35).map((h) => h.id));
  const fnLiveFiltered = createHybridSearchFn({
    bdpmVec,
    vetVec,
    enc,
    minScore,
    candidateCap: 40,
    isAdmissible: (source, _rec, shortId) => !(source === 'bdpm' && excludedLiveIds.has(shortId))
  });
  const liveFilteredRes = fnLiveFiltered({ q: qProbe, source: 'human' }, 1, 10);
  assertCondition(liveFilteredRes.results.length === 10, 'Pre-k exclusion of top 35 on BDPM must yield 10 admissible docs');
  assertCondition(liveFilteredRes.results.every((r) => {
    const shortIdx = bdpmState.corpus.specialites.findIndex((s) => s.cis === r.cis);
    return !excludedLiveIds.has(shortIdx);
  }), 'Pre-k exclusion on BDPM must never leak excluded docs');

  // Corpus synthétique contrôlé (75 docs dont 60 admissibles >= minScore) : test >40 admissibles, pages profondes & exclusion top-45
  const dim = 8;
  const synDocs = Array.from({ length: 75 }, (_, i) => ({ id: i, text: `synthetique_${i}` }));
  const synHost = cjsMain.FrozenMiniSearch.fromDocuments(synDocs, { fields: ['text'] });
  const synDense = new Float32Array(75 * dim);
  for (let i = 0; i < 75; i++) {
    // Vecteurs unitaires de similarité strictement décroissante avec [1, 0, ...]
    const cos = i < 65 ? 0.99 - i * 0.005 : 0.2;
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    synDense[i * dim] = cos;
    synDense[i * dim + 1] = sin;
  }
  const synVec = cjsVec.FrozenVectorIndex.fromDenseFloat32(synHost, synDense, {
    quantization: 'float32',
    dim,
    metric: 'cosine',
    normalize: true,
    representationVersion: 'syn-test:v1',
    snapshotId: 'sha256:syn75'
  });
  const synQuery = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
  const synInadmissible = new Set([60, 61, 62, 63, 64]); // laissent exactement 60 admissibles (>=0.55)
  const synTopCap = synVec.topK(synQuery, {
    k: 41,
    minScore,
    filter: (id) => !synInadmissible.has(id)
  });
  assertCondition(synTopCap.length === 41, `Synthetic >40 contract expected 41 hits (cap+1), got ${synTopCap.length}`);
  const synExcluded45 = new Set(Array.from({ length: 45 }, (_, i) => i));
  const synNext10 = synVec.topK(synQuery, {
    k: 10,
    minScore,
    filter: (id) => !synInadmissible.has(id) && !synExcluded45.has(id)
  });
  assertCondition(
    JSON.stringify(synNext10.map((h) => h.id)) === JSON.stringify([45, 46, 47, 48, 49, 50, 51, 52, 53, 54]),
    'Synthetic pre-k filter excluding top 45 (>40) must recover exact ranks 45..54'
  );
  const synAll60 = synVec.topK(synQuery, {
    k: 70,
    minScore,
    filter: (id) => !synInadmissible.has(id)
  });
  assertCondition(synAll60.length === 60 && synAll60.slice(40, 50).length === 10, 'Synthetic exhaustive >= minScore must contain all 60 admissible docs across deep pages');

  // Politique de source
  const vetRes = fnBounded({ q: 'medicament metacam chien', source: 'veterinary' }, 1, 10);
  assertCondition(vetRes.results.every((r) => r.type === 'medicament_veterinaire') && vetRes.search.referentiels.queried.join(',') === 'anmv', 'veterinary policy must query ANMV only');
  const mixRes = fnBounded({ q: qProbe, source: 'mixed' }, 1, 10);
  assertCondition(mixRes.search.semantic_fallback.source_policy === 'mixed_both', 'mixed policy expected');

  // Aucun repli sur code inexistant / garde-fou RCP / critere negatifs explicites
  const invCode = fnBounded({ q: '99999999', source: 'auto' }, 1, 10);
  const rcGuard = fnBounded({ q: 'ibuprofene compatible grossesse', source: 'auto' }, 1, 10);
  const negCrit = fnBounded({ q: 'amoxicilline', source: 'auto' }, 1, 10, { voie: 'non orale' });
  assertCondition(invCode.total === 0 && !invCode.search.semantic_fallback_used, 'Invalid exact code must not trigger fallback');
  assertCondition(rcGuard.total === 0 && rcGuard.search.abstained && !rcGuard.search.semantic_fallback_used, 'Clinical guard must abstain without fallback');
  assertCondition(negCrit.total === 0 && negCrit.search.abstained && !negCrit.search.semantic_fallback_used, 'Negative explicit criterion must abstain without fallback');

  return {
    liveBdpmAdmissiblePoolCount: rawPool.length,
    boundedCap40Verified: true,
    deepPage5EmptyAndFlagged: true,
    preKExcludeTop35BdpmRecovered10: true,
    synthetic75PreKExcludeTop45Recovered10: true,
    sourcePolicyVerified: true,
    guardAndInvalidCodeNoFallback: true
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
  const { indexes, pkgBindings, ...tarballSummary } = tarballCheck;
  void indexes;
  void pkgBindings;
  console.log(JSON.stringify(tarballSummary, null, 2));

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

  const fallbackContractChecks = runFallbackContractTests({
    tarballCheck,
    enc,
    minScore: FROZEN_MIN_SCORE
  });

  const deltaMetrics = (a, b) => ({
    deltaIdentityTop1: round(a.identityTop1 - b.identityTop1, 4),
    deltaVariantTop1: round(a.variantTop1 - b.variantTop1, 4),
    deltaHit5Var: round(a.hit5Var - b.hit5Var, 4),
    deltaMrr10: round(a.mrr10 - b.mrr10, 4),
    deltaNdcg10: round(a.ndcg10 - b.ndcg10, 4),
    deltaEmptyRate: round(a.emptyRate - b.emptyRate, 4),
    deltaOosNonEmptyRate: round(a.oosNonEmptyRate - b.oosNonEmptyRate, 4)
  });

  const marginalFallbackDelta = {
    v3_heldout_hybridInt8_minus_B2: deltaMetrics(
      results.v3.heldout.Hybrid_Int8_Tarball_055.all.summary,
      results.v3.heldout.B2_concepts.all.summary
    ),
    residual_dev_hybridInt8_minus_B2: deltaMetrics(
      results.residual.dev.Hybrid_Int8_Tarball_055.summary,
      results.residual.dev.B2_concepts.summary
    ),
    residual_heldout_hybridInt8_minus_B2: deltaMetrics(
      results.residual.heldout.Hybrid_Int8_Tarball_055.summary,
      results.residual.heldout.B2_concepts.summary
    )
  };

  const repoRoot = path.resolve(__dirname, '../../../..');
  const minisearchRepoPath =
    process.env.FROZENMINISEARCH_REPO_DIR ||
    path.resolve(repoRoot, '../../../minisearch/.worktrees/semantic-aux');
  const manifest = {
    generatedAt: new Date().toISOString(),
    repos: {
      pharmaWorktree: {
        path: repoRoot,
        ...gitInfo(repoRoot)
      },
      frozenminisearchWorktree: {
        path: fs.existsSync(minisearchRepoPath) ? minisearchRepoPath : null,
        ...gitInfo(minisearchRepoPath)
      }
    },
    packageArtifact: {
      name: '@yoch/frozenminisearch',
      version: tarballCheck.version,
      tarballPath: fs.existsSync(TARBALL_PATH) ? TARBALL_PATH : null,
      tarballSha256: sha256File(TARBALL_PATH),
      unpackedPkgDir: PKG_DIR
    },
    runtimePaths: {
      dataDir: process.env.DATA_DIR || path.join(repoRoot, 'data'),
      modelDir: MODEL_DIR
    },
    dataAndModelRevisions: {
      corpusMetadata: getMetadata(),
      bdpmCount: bdpmState.corpus.specialites.length,
      vetCount: vetState.corpus.medicaments.length,
      bdpmSnapshotId: tarballSummary.fxv1BdpmMeta.snapshotId,
      vetSnapshotId: tarballSummary.fxv1VetMeta.snapshotId,
      modelMetaSha256: sha256File(path.join(MODEL_DIR, 'static_mrl_128d.meta.json')),
      modelInt8Sha256: sha256File(path.join(MODEL_DIR, 'static_mrl_128d_int8.bin'))
    },
    testSuitesSha256: {
      eval_suite_v3: sha256File(path.join(__dirname, 'eval_suite_v3.json')),
      eval_residual_v1: sha256File(path.join(__dirname, 'eval_residual_v1.json')),
      experimentalSearch_test: sha256File(path.join(repoRoot, 'tests/experimentalSearch.test.js'))
    }
  };

  fs.writeFileSync(
    path.join(__dirname, 'reproducibility_manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  const report = {
    generatedAt: manifest.generatedAt,
    frozenMinScore: FROZEN_MIN_SCORE,
    tarballCheck: tarballSummary,
    fallbackContractChecks,
    marginalFallbackDelta,
    manifestSummary: manifest,
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
  console.log('\n--- MARGINAL FALLBACK DELTA & CONTRACT CHECKS ---');
  console.log(JSON.stringify({ marginalFallbackDelta, fallbackContractChecks, traceDev, traceHeldout, pagInvariance, httpE2E }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
