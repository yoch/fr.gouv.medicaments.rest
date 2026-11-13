'use strict';

/**
 * Encodeurs statiques zéro-dépendance pour l'étape A.4 / B3 :
 *   1. Représentation textuelle courte contrôlée BDPM + ANMV (zéro RCP).
 *   2. Corpus LSA-128 (Word TF-IDF + optionnel Char-3Gram TF-IDF via SVD randomisée pure JS).
 *   3. Modèle pré-entraîné WordPiece statique (static-similarity-mrl-multilingual-v1 64d/128d Int8/F32).
 *   4. Quantificateurs Float32, Int8 symétrique et PQ16 (pour B3 & B4).
 */

const fs = require('node:fs');
const path = require('node:path');
const { normalizeSearchText } = require('../../../../src/utils/searchRanking');

const MODEL_ARTIFACT_DIR = path.join(
  __dirname,
  '../../../../data/search-indexes/mission-semantic'
);

const STOP_WORDS_SHORT = new Set([
  'de', 'du', 'des', 'd', 'le', 'la', 'les', 'l', 'un', 'une', 'en', 'pour', 'par',
  'avec', 'dans', 'sur', 'au', 'aux', 'et', 'ou', 'sans', 'sous'
]);

const CONTAINER_KEYWORDS = [
  'plaquette', 'flacon', 'seringue', 'stylo', 'unidose', 'tube',
  'sachet', 'ampoule', 'pilulier', 'compte-gouttes', 'spray', 'flacon-pressurise'
];

/**
 * Construit les documents courts contrôlés BDPM + ANMV (sans RCP).
 */
function buildControlledDocuments(bdpmCorpus, vetCorpus, cisIndexes, vetNumIndexes) {
  const docs = [];
  const compByCis = cisIndexes.compositionsByCis;
  const presByCis = cisIndexes.presentationsByCis;
  const generByCis = cisIndexes.generiquesByCis;

  for (let i = 0; i < bdpmCorpus.specialites.length; i++) {
    const s = bdpmCorpus.specialites[i];
    const cis = s.cis;

    const compIndices = compByCis ? (compByCis.get(cis) || []) : [];
    const subSet = new Set();
    for (const ci of compIndices) {
      const name = bdpmCorpus.compositions[ci].denomination_substance;
      if (name) subSet.add(normalizeSearchText(name));
    }

    const presIndices = presByCis ? (presByCis.get(cis) || []) : [];
    const presKw = new Set();
    for (const pi of presIndices) {
      const p = bdpmCorpus.presentations[pi];
      const lib = normalizeSearchText(p.libelle || '');
      for (const kw of CONTAINER_KEYWORDS) {
        if (lib.includes(kw)) presKw.add(kw);
      }
      if (p.indications) presKw.add(normalizeSearchText(p.indications));
    }

    const genIndices = generByCis ? (generByCis.get(cis) || []) : [];
    let genHint = '';
    if (genIndices.length > 0) {
      const lg = bdpmCorpus.generiques[genIndices[0]].libelle_groupe || '';
      genHint = lg.split('-')[0].trim();
    }

    const text = [
      s.denomination || '',
      s.forme_pharma || '',
      (s.voies_admin || '').replace(/;/g, ' '),
      ...subSet,
      genHint,
      ...presKw
    ].filter(Boolean).join(' ');

    docs.push({
      docId: docs.length,
      source: 'bdpm',
      key: cis,
      text
    });
  }
  const bdpmCount = docs.length;

  const vetCompByNum = vetNumIndexes.compositionsByNum;
  const vetPresByNum = vetNumIndexes.presentationsByNum;
  for (let i = 0; i < vetCorpus.medicaments.length; i++) {
    const m = vetCorpus.medicaments[i];
    const num = m.num;
    const compIndices = vetCompByNum ? (vetCompByNum.get(num) || []) : [];
    const subs = new Set();
    for (const ci of compIndices) {
      const sub = vetCorpus.compositions[ci].substance;
      if (sub) subs.add(sub);
    }
    const presIndices = vetPresByNum ? (vetPresByNum.get(num) || []) : [];
    const presKw = new Set();
    for (const pi of presIndices) {
      const lib = normalizeSearchText(vetCorpus.presentations[pi].libelle || '');
      for (const kw of CONTAINER_KEYWORDS) {
        if (lib.includes(kw)) presKw.add(kw);
      }
    }

    const text = [
      m.nom || '',
      m.forme_pharmaceutique || '',
      ...subs,
      ...(m.especes || []),
      ...presKw
    ].filter(Boolean).join(' ');

    docs.push({
      docId: docs.length,
      source: 'vet',
      key: num,
      text
    });
  }

  return {
    docs,
    bdpmCount,
    vetCount: docs.length - bdpmCount
  };
}

// =========================================================================
// Encodeur 1 : LSA-128 pure JS (Word TF-IDF ou Word + Char-3gram TF-IDF)
// =========================================================================

function tokenizeLsa(text, { includeChar3 = false } = {}) {
  const norm = normalizeSearchText(text)
    .replace(/['’/;,+()\-:.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!norm) return [];
  const words = norm.split(' ').filter((w) => w.length >= 2 && !STOP_WORDS_SHORT.has(w));
  if (!includeChar3) return words;

  const out = [...words];
  for (const w of words) {
    if (/^\d+$/.test(w)) continue;
    const padded = `#${w}#`;
    for (let i = 0; i <= padded.length - 3; i++) {
      out.push(`c:${padded.slice(i, i + 3)}`);
    }
  }
  return out;
}

/** Décomposition propre Jacobi d'une matrice symétrique k x k (row-major Float64). */
function symmetricEigenJacobi(mat, k, maxSweeps = 40) {
  const A = new Float64Array(mat);
  const V = new Float64Array(k * k);
  for (let i = 0; i < k; i++) V[i * k + i] = 1;

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let maxOff = 0;
    for (let p = 0; p < k - 1; p++) {
      for (let q = p + 1; q < k; q++) {
        const apq = A[p * k + q];
        const absApq = Math.abs(apq);
        if (absApq > maxOff) maxOff = absApq;
        if (absApq < 1e-12) continue;

        const app = A[p * k + p];
        const aqq = A[q * k + q];
        const tau = (aqq - app) / (2 * apq);
        const t = tau >= 0
          ? 1 / (tau + Math.sqrt(1 + tau * tau))
          : -1 / (-tau + Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;

        A[p * k + p] = app - t * apq;
        A[q * k + q] = aqq + t * apq;
        A[p * k + q] = 0;
        A[q * k + p] = 0;

        for (let r = 0; r < k; r++) {
          if (r === p || r === q) continue;
          const arp = A[r * k + p];
          const arq = A[r * k + q];
          const nrp = c * arp - s * arq;
          const nrq = s * arp + c * arq;
          A[r * k + p] = A[p * k + r] = nrp;
          A[r * k + q] = A[q * k + r] = nrq;
        }
        for (let r = 0; r < k; r++) {
          const vrp = V[r * k + p];
          const vrq = V[r * k + q];
          V[r * k + p] = c * vrp - s * vrq;
          V[r * k + q] = s * vrp + c * vrq;
        }
      }
    }
    if (maxOff < 1e-10) break;
  }

  const pairs = [];
  for (let i = 0; i < k; i++) pairs.push({ val: A[i * k + i], idx: i });
  pairs.sort((a, b) => b.val - a.val);
  return { pairs, V };
}

function orthonormalizeColumns(M, rows, cols) {
  for (let c = 0; c < cols; c++) {
    for (let prev = 0; prev < c; prev++) {
      let dot = 0;
      for (let r = 0; r < rows; r++) dot += M[r * cols + prev] * M[r * cols + c];
      for (let r = 0; r < rows; r++) M[r * cols + c] -= dot * M[r * cols + prev];
    }
    let norm2 = 0;
    for (let r = 0; r < rows; r++) {
      const v = M[r * cols + c];
      norm2 += v * v;
    }
    const inv = norm2 > 1e-24 ? 1 / Math.sqrt(norm2) : 0;
    for (let r = 0; r < rows; r++) M[r * cols + c] *= inv;
  }
}

function buildLsaEncoder(docs, {
  dim = 128,
  includeChar3 = false,
  minDf = 2,
  maxVocab = 28000,
  powerIters = 2
} = {}) {
  const t0 = process.hrtime.bigint();
  const N = docs.length;

  // 1. Calcul DF + filtrage vocabulaire borné
  const dfMap = new Map();
  const tokenizedDocs = new Array(N);
  for (let i = 0; i < N; i++) {
    const toks = tokenizeLsa(docs[i].text, { includeChar3 });
    tokenizedDocs[i] = toks;
    const uniq = new Set(toks);
    for (const t of uniq) dfMap.set(t, (dfMap.get(t) || 0) + 1);
  }

  const vocabEntries = [];
  for (const [term, df] of dfMap.entries()) {
    if (df >= minDf && df < N * 0.9) vocabEntries.push([term, df]);
  }
  if (vocabEntries.length > maxVocab) {
    vocabEntries.sort((a, b) => b[1] - a[1]);
    vocabEntries.length = maxVocab;
  }
  const V = vocabEntries.length;
  const termToId = new Map();
  const idf = new Float32Array(V);
  for (let j = 0; j < V; j++) {
    const [term, df] = vocabEntries[j];
    termToId.set(term, j);
    idf[j] = Math.log((N + 1) / (df + 1)) + 1;
  }

  // 2. Matrice creuse TF-IDF L2-normalisée par document (CSR)
  const docPtr = new Int32Array(N + 1);
  let totalNnz = 0;
  const docColTemp = new Array(N);
  const docValTemp = new Array(N);
  for (let i = 0; i < N; i++) {
    const counts = new Map();
    for (const t of tokenizedDocs[i]) {
      const tid = termToId.get(t);
      if (tid !== undefined) counts.set(tid, (counts.get(tid) || 0) + 1);
    }
    const cols = [];
    const vals = [];
    let norm2 = 0;
    for (const [tid, tf] of counts.entries()) {
      const w = (1 + Math.log(tf)) * idf[tid];
      cols.push(tid);
      vals.push(w);
      norm2 += w * w;
    }
    const inv = norm2 > 0 ? 1 / Math.sqrt(norm2) : 0;
    for (let k = 0; k < vals.length; k++) vals[k] *= inv;
    docColTemp[i] = cols;
    docValTemp[i] = vals;
    totalNnz += cols.length;
    docPtr[i + 1] = totalNnz;
  }
  const csrCols = new Int32Array(totalNnz);
  const csrVals = new Float32Array(totalNnz);
  let cursor = 0;
  for (let i = 0; i < N; i++) {
    const cols = docColTemp[i];
    const vals = docValTemp[i];
    for (let k = 0; k < cols.length; k++) {
      csrCols[cursor] = cols[k];
      csrVals[cursor] = vals[k];
      cursor++;
    }
  }

  // 3. SVD randomisée A (N x V) ≈ U * S * W^T avec rang r = dim + 16
  const r = Math.min(V, dim + 16);
  const Q = new Float32Array(V * r);
  let seed = 0x9e3779b9;
  for (let idx = 0; idx < Q.length; idx++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    Q[idx] = ((seed / 4294967296) - 0.5) * 2;
  }
  orthonormalizeColumns(Q, V, r);

  const Y = new Float32Array(N * r);
  const Z = new Float32Array(V * r);

  function spmmRight(inV, outN) {
    outN.fill(0);
    for (let i = 0; i < N; i++) {
      const start = docPtr[i];
      const end = docPtr[i + 1];
      const baseOut = i * r;
      for (let p = start; p < end; p++) {
        const w = csrVals[p];
        const baseIn = csrCols[p] * r;
        for (let c = 0; c < r; c++) {
          outN[baseOut + c] += w * inV[baseIn + c];
        }
      }
    }
  }

  function spmmLeft(inN, outV) {
    outV.fill(0);
    for (let i = 0; i < N; i++) {
      const start = docPtr[i];
      const end = docPtr[i + 1];
      const baseIn = i * r;
      for (let p = start; p < end; p++) {
        const w = csrVals[p];
        const baseOut = csrCols[p] * r;
        for (let c = 0; c < r; c++) {
          outV[baseOut + c] += w * inN[baseIn + c];
        }
      }
    }
  }

  spmmRight(Q, Y);
  orthonormalizeColumns(Y, N, r);
  for (let it = 0; it < powerIters; it++) {
    spmmLeft(Y, Z);
    orthonormalizeColumns(Z, V, r);
    spmmRight(Z, Y);
    orthonormalizeColumns(Y, N, r);
  }

  // B = A^T * Y  (V x r) puis G = B^T * B  (r x r)
  const B = new Float32Array(V * r);
  spmmLeft(Y, B);
  const G = new Float64Array(r * r);
  for (let v = 0; v < V; v++) {
    const base = v * r;
    for (let c1 = 0; c1 < r; c1++) {
      const b1 = B[base + c1];
      if (b1 === 0) continue;
      for (let c2 = c1; c2 < r; c2++) {
        G[c1 * r + c2] += b1 * B[base + c2];
      }
    }
  }
  for (let c1 = 0; c1 < r; c1++) {
    for (let c2 = 0; c2 < c1; c2++) {
      G[c1 * r + c2] = G[c2 * r + c1];
    }
  }

  const { pairs, V: eigVecs } = symmetricEigenJacobi(G, r);
  const actualDim = Math.min(dim, r);

  // Projection terme -> R^dim : T[v * dim + d] = sum_c B[v, c] * eigVecs[c, col_d] / sqrt(lambda_d)
  // Pour documents : doc[i, d] = sum_c Y[i, c] * eigVecs[c, col_d] * sqrt(lambda_d) -> L2 normalisé!
  const termProj = new Float32Array(V * actualDim);
  const invSigmas = new Float64Array(actualDim);
  const sigmas = new Float64Array(actualDim);
  const colIdx = new Int32Array(actualDim);
  for (let d = 0; d < actualDim; d++) {
    const lam = Math.max(pairs[d].val, 1e-12);
    sigmas[d] = Math.sqrt(lam);
    invSigmas[d] = 1 / sigmas[d];
    colIdx[d] = pairs[d].idx;
  }

  for (let v = 0; v < V; v++) {
    const bBase = v * r;
    const tBase = v * actualDim;
    for (let d = 0; d < actualDim; d++) {
      const kCol = colIdx[d];
      let sum = 0;
      for (let c = 0; c < r; c++) {
        sum += B[bBase + c] * eigVecs[c * r + kCol];
      }
      termProj[tBase + d] = sum * invSigmas[d];
    }
  }

  const docVecs = new Float32Array(N * actualDim);
  for (let i = 0; i < N; i++) {
    const yBase = i * r;
    const dBase = i * actualDim;
    let norm2 = 0;
    for (let d = 0; d < actualDim; d++) {
      const kCol = colIdx[d];
      let sum = 0;
      for (let c = 0; c < r; c++) {
        sum += Y[yBase + c] * eigVecs[c * r + kCol];
      }
      const val = sum * sigmas[d];
      docVecs[dBase + d] = val;
      norm2 += val * val;
    }
    if (norm2 > 1e-24) {
      const inv = 1 / Math.sqrt(norm2);
      for (let d = 0; d < actualDim; d++) docVecs[dBase + d] *= inv;
    }
  }

  const buildMs = Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 100) / 100;

  function encodeQuery(queryText) {
    const toks = tokenizeLsa(queryText, { includeChar3 });
    const counts = new Map();
    for (const t of toks) {
      const tid = termToId.get(t);
      if (tid !== undefined) counts.set(tid, (counts.get(tid) || 0) + 1);
    }
    const qVec = new Float32Array(actualDim);
    if (counts.size === 0) return { vec: qVec, matchedTerms: 0 };

    let tfidfNorm2 = 0;
    const entries = [];
    for (const [tid, tf] of counts.entries()) {
      const w = (1 + Math.log(tf)) * idf[tid];
      entries.push([tid, w]);
      tfidfNorm2 += w * w;
    }
    const invTf = tfidfNorm2 > 0 ? 1 / Math.sqrt(tfidfNorm2) : 0;
    for (const [tid, w] of entries) {
      const weight = w * invTf;
      const tBase = tid * actualDim;
      for (let d = 0; d < actualDim; d++) {
        qVec[d] += weight * termProj[tBase + d];
      }
    }
    let norm2 = 0;
    for (let d = 0; d < actualDim; d++) norm2 += qVec[d] * qVec[d];
    if (norm2 > 1e-24) {
      const inv = 1 / Math.sqrt(norm2);
      for (let d = 0; d < actualDim; d++) qVec[d] *= inv;
    }
    return { vec: qVec, matchedTerms: counts.size };
  }

  return {
    name: includeChar3 ? `lsa_char3_${actualDim}` : `lsa_word_${actualDim}`,
    dim: actualDim,
    vocabSize: V,
    buildMs,
    termProjBytes: termProj.byteLength,
    docVecs,
    encodeQuery
  };
}

// =========================================================================
// Encodeur 2 : WordPiece Static Embedding (static-similarity-mrl-multilingual-v1)
// =========================================================================

const PUNCT_RE = /[\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E\p{P}]/u;

function bertPreTokenize(text) {
  const clean = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const words = [];
  let cur = '';
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (/\s/.test(ch)) {
      if (cur) {
        words.push(cur);
        cur = '';
      }
    } else if (PUNCT_RE.test(ch)) {
      if (cur) {
        words.push(cur);
        cur = '';
      }
      words.push(ch);
    } else {
      cur += ch;
    }
  }
  if (cur) words.push(cur);
  return words;
}

function loadStaticWordPieceEncoder(dim = 128, { useF32 = false } = {}) {
  const t0 = process.hrtime.bigint();
  const metaPath = path.join(MODEL_ARTIFACT_DIR, `static_mrl_${dim}d.meta.json`);
  const binPath = path.join(
    MODEL_ARTIFACT_DIR,
    useF32 ? `static_mrl_${dim}d_f32.bin` : `static_mrl_${dim}d_int8.bin`
  );
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const raw = fs.readFileSync(binPath);

  if (raw.toString('ascii', 0, 4) !== 'STV1') {
    throw new Error(`Magic invalide dans ${binPath}`);
  }
  const vocabSize = raw.readUInt32LE(4);
  const fileDim = raw.readUInt32LE(8);
  const quantized = raw.readUInt8(12);
  if (fileDim !== dim || vocabSize !== meta.vocabSize) {
    throw new Error('Dimension ou vocabulaire incohérent');
  }

  const tokenToId = new Map();
  for (let i = 0; i < meta.idToToken.length; i++) {
    tokenToId.set(meta.idToToken[i], i);
  }
  const unkId = tokenToId.get(meta.unkToken) ?? 0;

  let rowScales = null;
  let weightsInt8 = null;
  let weightsF32 = null;
  if (quantized === 1) {
    const scalesOffset = 16;
    const weightsOffset = scalesOffset + vocabSize * 4;
    rowScales = new Float32Array(
      raw.buffer,
      raw.byteOffset + scalesOffset,
      vocabSize
    );
    weightsInt8 = new Int8Array(
      raw.buffer,
      raw.byteOffset + weightsOffset,
      vocabSize * dim
    );
  } else {
    weightsF32 = new Float32Array(
      raw.buffer,
      raw.byteOffset + 16,
      vocabSize * dim
    );
  }

  function tokenizeIds(text) {
    const pre = bertPreTokenize(text);
    const ids = [];
    for (const word of pre) {
      if (word.length > 100) {
        ids.push(unkId);
        continue;
      }
      let start = 0;
      let isBad = false;
      const subIds = [];
      while (start < word.length) {
        let end = word.length;
        let foundId = -1;
        while (start < end) {
          let sub = word.slice(start, end);
          if (start > 0) sub = `##${sub}`;
          const tid = tokenToId.get(sub);
          if (tid !== undefined) {
            foundId = tid;
            break;
          }
          end--;
        }
        if (foundId === -1) {
          isBad = true;
          break;
        }
        subIds.push(foundId);
        start = end;
      }
      if (isBad) ids.push(unkId);
      else for (const id of subIds) ids.push(id);
    }
    return ids;
  }

  function encodeText(text) {
    const ids = tokenizeIds(text);
    const vec = new Float32Array(dim);
    if (ids.length === 0) return { vec, matchedTerms: 0 };
    let nonUnk = 0;
    for (let t = 0; t < ids.length; t++) {
      const tid = ids[t];
      if (tid !== unkId) nonUnk++;
      const base = tid * dim;
      if (quantized === 1) {
        const s = rowScales[tid];
        for (let d = 0; d < dim; d++) vec[d] += weightsInt8[base + d] * s;
      } else {
        for (let d = 0; d < dim; d++) vec[d] += weightsF32[base + d];
      }
    }
    let norm2 = 0;
    for (let d = 0; d < dim; d++) norm2 += vec[d] * vec[d];
    if (norm2 > 1e-24) {
      const inv = 1 / Math.sqrt(norm2);
      for (let d = 0; d < dim; d++) vec[d] *= inv;
    }
    return { vec, matchedTerms: nonUnk };
  }

  function encodeDocuments(docs) {
    const N = docs.length;
    const out = new Float32Array(N * dim);
    for (let i = 0; i < N; i++) {
      const { vec } = encodeText(docs[i].text);
      out.set(vec, i * dim);
    }
    return out;
  }

  const loadMs = Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 100) / 100;

  return {
    name: `static_mrl_${dim}d_${useF32 ? 'f32' : 'int8'}`,
    dim,
    vocabSize,
    loadMs,
    modelBytes: raw.length,
    parityCases: meta.parityCases,
    tokenizeIds,
    encodeQuery: encodeText,
    encodeDocuments
  };
}

// =========================================================================
// Compression d'index vectoriel (B4) : Float32 / Int8 / PQ16
// =========================================================================

function quantizeInt8Docs(docVecsF32, N, dim) {
  const scales = new Float32Array(N);
  const codes = new Int8Array(N * dim);
  for (let i = 0; i < N; i++) {
    const base = i * dim;
    let maxAbs = 0;
    for (let d = 0; d < dim; d++) {
      const a = Math.abs(docVecsF32[base + d]);
      if (a > maxAbs) maxAbs = a;
    }
    const s = maxAbs > 1e-12 ? maxAbs / 127 : 1 / 127;
    scales[i] = s;
    const inv = 1 / s;
    for (let d = 0; d < dim; d++) {
      const q = Math.round(docVecsF32[base + d] * inv);
      codes[base + d] = q > 127 ? 127 : q < -127 ? -127 : q;
    }
  }
  return { scales, codes, bytes: scales.byteLength + codes.byteLength };
}

/**
 * Product Quantization PQ16 (M=16 sous-espaces x K=256 centroïdes par défaut).
 * 128d -> 16 x 8d -> centroïdes = 16 * 256 * 8 * 4 = 131,072 B, codes = 16 B/doc.
 */
function buildPqIndex(docVecsF32, N, dim, { M = 16, K = 256, iters = 12 } = {}) {
  const t0 = process.hrtime.bigint();
  if (dim % M !== 0) throw new Error(`dim ${dim} non divisible par M=${M}`);
  const dSub = dim / M;
  const centroids = new Float32Array(M * K * dSub);
  const codes = new Uint8Array(N * M);

  // Sous-échantillon déterministe pour k-means rapide
  const sampleStep = Math.max(1, Math.floor(N / 4096));
  const samples = [];
  for (let i = 0; i < N; i += sampleStep) samples.push(i);
  const S = samples.length;

  let seed = 0x1234567;
  for (let m = 0; m < M; m++) {
    const cBase = m * K * dSub;
    const colOffset = m * dSub;

    // Initialisation uniforme répartie sur échantillons
    for (let k = 0; k < K; k++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const docIdx = samples[seed % S];
      const src = docIdx * dim + colOffset;
      const dst = cBase + k * dSub;
      for (let d = 0; d < dSub; d++) centroids[dst + d] = docVecsF32[src + d];
    }

    const sums = new Float64Array(K * dSub);
    const counts = new Int32Array(K);
    for (let it = 0; it < iters; it++) {
      sums.fill(0);
      counts.fill(0);
      for (let si = 0; si < S; si++) {
        const docBase = samples[si] * dim + colOffset;
        let bestK = 0;
        let bestDist = Infinity;
        for (let k = 0; k < K; k++) {
          const kb = cBase + k * dSub;
          let dist = 0;
          for (let d = 0; d < dSub; d++) {
            const diff = docVecsF32[docBase + d] - centroids[kb + d];
            dist += diff * diff;
          }
          if (dist < bestDist) {
            bestDist = dist;
            bestK = k;
          }
        }
        counts[bestK]++;
        const sb = bestK * dSub;
        for (let d = 0; d < dSub; d++) sums[sb + d] += docVecsF32[docBase + d];
      }
      for (let k = 0; k < K; k++) {
        const cnt = counts[k];
        if (cnt > 0) {
          const kb = cBase + k * dSub;
          const sb = k * dSub;
          const inv = 1 / cnt;
          for (let d = 0; d < dSub; d++) centroids[kb + d] = sums[sb + d] * inv;
        }
      }
    }

    // Assigner tous les N documents à leur centroïde
    for (let i = 0; i < N; i++) {
      const docBase = i * dim + colOffset;
      let bestK = 0;
      let bestDist = Infinity;
      for (let k = 0; k < K; k++) {
        const kb = cBase + k * dSub;
        let dist = 0;
        for (let d = 0; d < dSub; d++) {
          const diff = docVecsF32[docBase + d] - centroids[kb + d];
          dist += diff * diff;
        }
        if (dist < bestDist) {
          bestDist = dist;
          bestK = k;
        }
      }
      codes[i * M + m] = bestK;
    }
  }

  const buildMs = Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 100) / 100;
  return {
    M,
    K,
    dSub,
    centroids,
    codes,
    buildMs,
    bytes: centroids.byteLength + codes.byteLength
  };
}

function topKFloat32(qVec, docVecs, N, dim, k, maskFn = null) {
  const heapIdx = new Int32Array(k);
  const heapScore = new Float32Array(k).fill(-Infinity);
  let minPos = 0;
  let minVal = -Infinity;

  for (let i = 0; i < N; i++) {
    if (maskFn && !maskFn(i)) continue;
    const base = i * dim;
    let dot = 0;
    for (let d = 0; d < dim; d++) dot += qVec[d] * docVecs[base + d];
    if (dot > minVal) {
      heapIdx[minPos] = i;
      heapScore[minPos] = dot;
      minVal = heapScore[0];
      minPos = 0;
      for (let j = 1; j < k; j++) {
        if (heapScore[j] < minVal) {
          minVal = heapScore[j];
          minPos = j;
        }
      }
    }
  }
  const out = [];
  for (let j = 0; j < k; j++) {
    if (heapScore[j] > -Infinity) out.push({ docId: heapIdx[j], score: heapScore[j] });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function topKInt8(qVec, int8Index, N, dim, k, maskFn = null) {
  const { scales, codes } = int8Index;
  const heapIdx = new Int32Array(k);
  const heapScore = new Float32Array(k).fill(-Infinity);
  let minPos = 0;
  let minVal = -Infinity;

  for (let i = 0; i < N; i++) {
    if (maskFn && !maskFn(i)) continue;
    const base = i * dim;
    let dot = 0;
    for (let d = 0; d < dim; d++) dot += qVec[d] * codes[base + d];
    dot *= scales[i];
    if (dot > minVal) {
      heapIdx[minPos] = i;
      heapScore[minPos] = dot;
      minVal = heapScore[0];
      minPos = 0;
      for (let j = 1; j < k; j++) {
        if (heapScore[j] < minVal) {
          minVal = heapScore[j];
          minPos = j;
        }
      }
    }
  }
  const out = [];
  for (let j = 0; j < k; j++) {
    if (heapScore[j] > -Infinity) out.push({ docId: heapIdx[j], score: heapScore[j] });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function topKPq(qVec, pqIndex, N, k, maskFn = null) {
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

  const heapIdx = new Int32Array(k);
  const heapScore = new Float32Array(k).fill(-Infinity);
  let minPos = 0;
  let minVal = -Infinity;

  for (let i = 0; i < N; i++) {
    if (maskFn && !maskFn(i)) continue;
    const codeBase = i * M;
    let sum = 0;
    for (let m = 0; m < M; m++) {
      sum += lut[m * K + codes[codeBase + m]];
    }
    if (sum > minVal) {
      heapIdx[minPos] = i;
      heapScore[minPos] = sum;
      minVal = heapScore[0];
      minPos = 0;
      for (let j = 1; j < k; j++) {
        if (heapScore[j] < minVal) {
          minVal = heapScore[j];
          minPos = j;
        }
      }
    }
  }

  const out = [];
  for (let j = 0; j < k; j++) {
    if (heapScore[j] > -Infinity) out.push({ docId: heapIdx[j], score: heapScore[j] });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

module.exports = {
  buildControlledDocuments,
  buildLsaEncoder,
  loadStaticWordPieceEncoder,
  quantizeInt8Docs,
  buildPqIndex,
  topKFloat32,
  topKInt8,
  topKPq
};
