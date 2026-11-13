'use strict';

// Pure-JS Halko Randomized SVD (LSA) + Int8 quantized index.
// Zero external dependencies. Uses Float64Array during SVD, stores Int8Array at runtime.

const { CLINICAL_STOPWORDS, normalizeText, tokenizeWithMaskedBigrams } = require('./text_utils');

function tokenizeForLsa(text, { dropStopwords = true, minLen = 2 } = {}) {
  if (!text) return [];
  const raw = tokenizeWithMaskedBigrams(text);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (t.length < minLen || /^\d+$/.test(t)) continue;
    if (dropStopwords && CLINICAL_STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussianRng(seed = 42) {
  const rand = mulberry32(seed);
  return () => {
    const u1 = Math.max(1e-12, rand());
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
}

function orthonormalizeCols(M, rows, cols) {
  let rank = 0;
  for (let j = 0; j < cols; j++) {
    for (let p = 0; p < rank; p++) {
      let dot = 0;
      for (let i = 0; i < rows; i++) {
        dot += M[i * cols + p] * M[i * cols + j];
      }
      for (let i = 0; i < rows; i++) {
        M[i * cols + j] -= dot * M[i * cols + p];
      }
    }
    let normSq = 0;
    for (let i = 0; i < rows; i++) {
      const v = M[i * cols + j];
      normSq += v * v;
    }
    const norm = Math.sqrt(normSq);
    if (norm > 1e-10) {
      const inv = 1 / norm;
      for (let i = 0; i < rows; i++) {
        M[i * cols + rank] = M[i * cols + j] * inv;
      }
      rank++;
    }
  }
  return rank;
}

function jacobiSymmetricEigen(S, r, maxSweeps = 40) {
  const A = new Float64Array(S);
  const V = new Float64Array(r * r);
  for (let i = 0; i < r; i++) V[i * r + i] = 1;

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let offNorm = 0;
    for (let p = 0; p < r - 1; p++) {
      for (let q = p + 1; q < r; q++) {
        const apq = A[p * r + q];
        offNorm += apq * apq;
        if (Math.abs(apq) <= 1e-14) continue;
        const app = A[p * r + p];
        const aqq = A[q * r + q];
        const tau = (aqq - app) / (2 * apq);
        const t = tau >= 0 ? 1 / (tau + Math.sqrt(1 + tau * tau)) : -1 / (-tau + Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;

        A[p * r + p] = app - t * apq;
        A[q * r + q] = aqq + t * apq;
        A[p * r + q] = 0;
        A[q * r + p] = 0;

        for (let k = 0; k < r; k++) {
          if (k === p || k === q) continue;
          const akp = A[k * r + p];
          const akq = A[k * r + q];
          const nkp = c * akp - s * akq;
          const nkq = s * akp + c * akq;
          A[k * r + p] = nkp;
          A[p * r + k] = nkp;
          A[k * r + q] = nkq;
          A[q * r + k] = nkq;
        }
        for (let k = 0; k < r; k++) {
          const vkp = V[k * r + p];
          const vkq = V[k * r + q];
          V[k * r + p] = c * vkp - s * vkq;
          V[k * r + q] = s * vkp + c * vkq;
        }
      }
    }
    if (offNorm <= 1e-18) break;
  }

  const order = Array.from({ length: r }, (_, i) => i).sort((a, b) => A[b * r + b] - A[a * r + a]);
  const eigVals = new Float64Array(r);
  const eigVecs = new Float64Array(r * r);
  for (let col = 0; col < r; col++) {
    const src = order[col];
    eigVals[col] = Math.max(0, A[src * r + src]);
    for (let row = 0; row < r; row++) {
      eigVecs[row * r + col] = V[row * r + src];
    }
  }
  return { eigVals, eigVecs };
}

function buildLsaIndex(docTexts, {
  k = 128,
  oversample = 10,
  powerIter = 2,
  minDf = 3,
  maxDfRatio = 0.6,
  dropStopwords = true,
  seed = 42,
} = {}) {
  const t0 = performance.now();
  const N = docTexts.length;
  const maxDf = Math.max(2, Math.floor(N * maxDfRatio));

  const docTokens = new Array(N);
  const dfMap = new Map();
  for (let i = 0; i < N; i++) {
    const toks = tokenizeForLsa(docTexts[i], { dropStopwords });
    docTokens[i] = toks;
    const seen = new Set(toks);
    for (const t of seen) dfMap.set(t, (dfMap.get(t) || 0) + 1);
  }

  const vocab = [];
  const termToId = new Map();
  for (const [term, df] of dfMap) {
    if (df >= minDf && df <= maxDf) {
      termToId.set(term, vocab.length);
      vocab.push(term);
    }
  }
  const V = vocab.length;
  const idf = new Float32Array(V);
  for (let tid = 0; tid < V; tid++) {
    const df = dfMap.get(vocab[tid]);
    idf[tid] = Math.log(1 + (N - df + 0.5) / (df + 0.5));
  }

  const rowPtr = new Int32Array(N + 1);
  const colIdxList = [];
  const valList = [];
  const tfCounts = new Map();

  for (let i = 0; i < N; i++) {
    rowPtr[i] = colIdxList.length;
    const toks = docTokens[i];
    tfCounts.clear();
    for (let j = 0; j < toks.length; j++) {
      const tid = termToId.get(toks[j]);
      if (tid !== undefined) tfCounts.set(tid, (tfCounts.get(tid) || 0) + 1);
    }
    let normSq = 0;
    const start = colIdxList.length;
    for (const [tid, tf] of tfCounts) {
      const w = (1 + Math.log(tf)) * idf[tid];
      colIdxList.push(tid);
      valList.push(w);
      normSq += w * w;
    }
    if (normSq > 0) {
      const inv = 1 / Math.sqrt(normSq);
      for (let p = start; p < colIdxList.length; p++) valList[p] *= inv;
    }
    docTokens[i] = null;
  }
  rowPtr[N] = colIdxList.length;

  const colIdx = Int32Array.from(colIdxList);
  const vals = Float32Array.from(valList);
  const nnz = colIdx.length;

  const rTarget = Math.min(k + oversample, N, V);
  if (rTarget === 0 || nnz === 0) throw new Error('LSA: empty matrix');

  function mulAX(X, r, Y) {
    Y.fill(0);
    for (let i = 0; i < N; i++) {
      const start = rowPtr[i];
      const end = rowPtr[i + 1];
      const yBase = i * r;
      for (let p = start; p < end; p++) {
        const w = vals[p];
        const xBase = colIdx[p] * r;
        for (let c = 0; c < r; c++) Y[yBase + c] += w * X[xBase + c];
      }
    }
  }

  function mulATQ(Q, r, Z) {
    Z.fill(0);
    for (let i = 0; i < N; i++) {
      const start = rowPtr[i];
      const end = rowPtr[i + 1];
      const qBase = i * r;
      for (let p = start; p < end; p++) {
        const w = vals[p];
        const zBase = colIdx[p] * r;
        for (let c = 0; c < r; c++) Z[zBase + c] += w * Q[qBase + c];
      }
    }
  }

  const r = rTarget;
  const rng = gaussianRng(seed);
  const Omega = new Float64Array(V * r);
  for (let i = 0; i < Omega.length; i++) Omega[i] = rng();

  const Y = new Float64Array(N * r);
  const Z = new Float64Array(V * r);
  mulAX(Omega, r, Y);
  let activeR = orthonormalizeCols(Y, N, r);

  let Q = Y;
  if (activeR < r) {
    const Q2 = new Float64Array(N * activeR);
    for (let i = 0; i < N; i++) {
      for (let c = 0; c < activeR; c++) Q2[i * activeR + c] = Q[i * r + c];
    }
    Q = Q2;
  }

  const rr = activeR;
  const finalK = Math.min(k, rr);
  const Zsub = rr === r ? Z : new Float64Array(V * rr);
  const Ysub = rr === r ? Y : new Float64Array(N * rr);

  for (let it = 0; it < powerIter; it++) {
    mulATQ(Q, rr, Zsub);
    orthonormalizeCols(Zsub, V, rr);
    mulAX(Zsub, rr, Ysub);
    orthonormalizeCols(Ysub, N, rr);
    Q.set(Ysub);
  }

  mulATQ(Q, rr, Zsub);
  const S = new Float64Array(rr * rr);
  for (let t = 0; t < V; t++) {
    const base = t * rr;
    for (let a = 0; a < rr; a++) {
      const va = Zsub[base + a];
      if (va === 0) continue;
      for (let b = a; b < rr; b++) S[a * rr + b] += va * Zsub[base + b];
    }
  }
  for (let a = 0; a < rr; a++) {
    for (let b = 0; b < a; b++) S[a * rr + b] = S[b * rr + a];
  }

  const { eigVals, eigVecs } = jacobiSymmetricEigen(S, rr);
  const sigma = new Float64Array(finalK);
  for (let c = 0; c < finalK; c++) sigma[c] = Math.sqrt(eigVals[c]);

  const docFloat = new Float32Array(N * finalK);
  let maxDocAbs = 0;
  for (let i = 0; i < N; i++) {
    const qBase = i * rr;
    const dBase = i * finalK;
    let normSq = 0;
    for (let c = 0; c < finalK; c++) {
      let acc = 0;
      for (let j = 0; j < rr; j++) acc += Q[qBase + j] * eigVecs[j * rr + c];
      const val = acc * sigma[c];
      docFloat[dBase + c] = val;
      normSq += val * val;
    }
    if (normSq > 1e-12) {
      const inv = 1 / Math.sqrt(normSq);
      for (let c = 0; c < finalK; c++) {
        const v = docFloat[dBase + c] * inv;
        docFloat[dBase + c] = v;
        const av = Math.abs(v);
        if (av > maxDocAbs) maxDocAbs = av;
      }
    }
  }

  const docScale = maxDocAbs > 0 ? maxDocAbs / 127 : 1;
  const invDocScale = 1 / docScale;
  const docVecs = new Int8Array(N * finalK);
  for (let i = 0; i < docFloat.length; i++) {
    docVecs[i] = Math.max(-127, Math.min(127, Math.round(docFloat[i] * invDocScale)));
  }

  const termVecs = new Int8Array(V * finalK);
  const termScales = new Float32Array(V);
  const tmpTerm = new Float64Array(finalK);
  for (let t = 0; t < V; t++) {
    const bBase = t * rr;
    let maxAbs = 0;
    for (let c = 0; c < finalK; c++) {
      if (sigma[c] <= 1e-10) {
        tmpTerm[c] = 0;
        continue;
      }
      let acc = 0;
      for (let j = 0; j < rr; j++) acc += Zsub[bBase + j] * eigVecs[j * rr + c];
      const v = acc / sigma[c];
      tmpTerm[c] = v;
      const av = Math.abs(v);
      if (av > maxAbs) maxAbs = av;
    }
    const scale = maxAbs > 0 ? maxAbs / 127 : 1;
    termScales[t] = scale;
    const inv = 1 / scale;
    const tBase = t * finalK;
    for (let c = 0; c < finalK; c++) {
      termVecs[tBase + c] = Math.max(-127, Math.min(127, Math.round(tmpTerm[c] * inv)));
    }
  }

  const buildMs = performance.now() - t0;
  const runtimeBytes =
    docVecs.byteLength + termVecs.byteLength + termScales.byteLength + idf.byteLength;

  return {
    N, V, k: finalK, nnz, buildMs, runtimeBytes,
    vocab, termToId, idf, docVecs, termVecs, termScales, dropStopwords,
  };
}

function encodeQueryLsa(lsa, queryOrTerms) {
  const k = lsa.k;
  const toks = Array.isArray(queryOrTerms)
    ? queryOrTerms
    : tokenizeForLsa(queryOrTerms, { dropStopwords: lsa.dropStopwords });
  if (toks.length === 0) return null;

  const qCounts = new Map();
  for (let i = 0; i < toks.length; i++) {
    const tid = lsa.termToId.get(toks[i]);
    if (tid !== undefined) qCounts.set(tid, (qCounts.get(tid) || 0) + 1);
  }
  if (qCounts.size === 0) return null;

  const qFloat = new Float64Array(k);
  for (const [tid, tf] of qCounts) {
    const w = (1 + Math.log(tf)) * lsa.idf[tid] * lsa.termScales[tid];
    const tBase = tid * k;
    for (let c = 0; c < k; c++) qFloat[c] += w * lsa.termVecs[tBase + c];
  }

  let normSq = 0;
  for (let c = 0; c < k; c++) normSq += qFloat[c] * qFloat[c];
  if (normSq <= 1e-12) return null;
  const invNorm = 1 / Math.sqrt(normSq);
  let maxAbs = 0;
  for (let c = 0; c < k; c++) {
    qFloat[c] *= invNorm;
    const av = Math.abs(qFloat[c]);
    if (av > maxAbs) maxAbs = av;
  }
  const qScale = maxAbs > 0 ? 127 / maxAbs : 1;
  const qInt8 = new Int8Array(k);
  for (let c = 0; c < k; c++) {
    qInt8[c] = Math.max(-127, Math.min(127, Math.round(qFloat[c] * qScale)));
  }
  return qInt8;
}

function searchTopKLsa(lsa, queryOrTerms, limit = 20) {
  const qInt8 = encodeQueryLsa(lsa, queryOrTerms);
  if (!qInt8) return [];
  const N = lsa.N;
  const k = lsa.k;
  const docVecs = lsa.docVecs;
  const out = [];
  let minIdx = 0;
  let minScore = Infinity;

  for (let i = 0; i < N; i++) {
    const base = i * k;
    let s = 0;
    for (let c = 0; c < k; c++) s += qInt8[c] * docVecs[base + c];
    if (out.length < limit) {
      out.push({ id: i, score: s });
      if (s < minScore) {
        minScore = s;
        minIdx = out.length - 1;
      }
    } else if (s > minScore) {
      out[minIdx] = { id: i, score: s };
      minScore = out[0].score;
      minIdx = 0;
      for (let j = 1; j < out.length; j++) {
        if (out[j].score < minScore) {
          minScore = out[j].score;
          minIdx = j;
        }
      }
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

module.exports = {
  buildLsaIndex,
  encodeQueryLsa,
  searchTopKLsa,
};
