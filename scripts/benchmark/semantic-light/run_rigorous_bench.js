'use strict';

const path = require('path');
const zlib = require('zlib');
const FrozenMiniSearch = require('@yoch/frozenminisearch');
const { OR, AND } = FrozenMiniSearch;

const {
  normalizeText,
  maskNegativeLabelBigrams,
  tokenizeWithMaskedBigrams,
  simpleStemFr,
} = require('./lib/text_utils');
const { loadBdpmRigorousCorpus } = require('./lib/bdpm_loader');
const { buildLsaIndex, searchTopKLsa } = require('./lib/lsa_engine');
const { GALENIC_SYNONYMS, LEXICON_V1, analyzeQuery } = require('./lib/query_processor');
const { buildEvalSuite } = require('./lib/eval_suite');

function fmtMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtPct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx];
}

function buildMorphString(text) {
  const toks = tokenizeWithMaskedBigrams(text);
  const stems = [];
  const seen = new Set();
  for (const t of toks) {
    if (t.length < 3 || /^\d+$/.test(t)) continue;
    const st = simpleStemFr(t);
    if (!seen.has(st)) {
      seen.add(st);
      stems.push(st);
    }
    if (t.length >= 6) {
      const p6 = `p${t.slice(0, 6)}`;
      if (!seen.has(p6)) {
        seen.add(p6);
        stems.push(p6);
      }
    }
  }
  return stems.join(' ');
}

function buildGalenicSemForDoc(doc) {
  const base = normalizeText(`${doc.denomination} ${doc.forme_pharma} ${doc.voie}`);
  const toks = base.split(/[^a-z0-9]+/).filter(Boolean);
  const extra = new Set();
  for (const t of toks) {
    const syns = GALENIC_SYNONYMS[t];
    if (syns) {
      for (const s of syns) extra.add(s);
    }
  }
  return [...extra].join(' ');
}

function precomputeDocHelpers(corpus) {
  for (const doc of corpus.docs) {
    doc._haySub = maskNegativeLabelBigrams(
      normalizeText(`${doc.denomination} ${doc.canonical_subs.join(' ')} ${doc.substances_raw.join(' ')}`)
    );
    doc._negText = maskNegativeLabelBigrams(
      normalizeText(`${doc.denomination} ${doc.forme_pharma} ${doc.canonical_subs.join(' ')}`)
    );
    doc._posFull = maskNegativeLabelBigrams(
      normalizeText(`${doc.denomination} ${doc.forme_pharma} ${doc.classe_pharm} ${doc.smr_str} ${doc.rcp_41}`)
    );
    doc._rcp48Norm = normalizeText(doc.rcp_48);
    doc._rcp4346Norm = normalizeText(`${doc.rcp_43} ${doc.rcp_46}`);
    doc._ciGrossesse =
      /grossesse/.test(normalizeText(doc.rcp_43)) ||
      /contre[- ]?indiqu[^.]{0,120}grossesse|grossesse[^.]{0,120}contre[- ]?indiqu/.test(doc._rcp4346Norm);
    doc._pediatricFriendly =
      /nourrisson|pediatriq|enfant|suspension buvable|sirop|suppositoire/.test(doc._posFull);
    doc._adultHighDose =
      (/\b1000\s*mg\b|\badulte\b/.test(normalizeText(doc.denomination)) || /\badultes?\b/.test(normalizeText(doc.denomination))) &&
      !/enfant|nourrisson|pediatr/.test(normalizeText(doc.denomination));
    doc._denomNorm = normalizeText(doc.denomination);
  }
}

function buildFrozenWithStats(docs, options) {
  const t0 = performance.now();
  const idx = FrozenMiniSearch.buildFrozenFromDocuments(docs, options);
  const buildMs = performance.now() - t0;
  const raw = idx.saveBinarySync();
  const gz = zlib.gzipSync(raw);
  return {
    idx,
    buildMs,
    termCount: typeof idx.termCount === 'function' ? idx.termCount() : idx.termCount,
    msbinBytes: raw.length,
    msbinGzBytes: gz.length,
  };
}

function searchTwoPass(idx, queryStr, fieldsBoost, limit = 60, fuzzy = 0.2) {
  const toks = queryStr.split(/\s+/).filter(Boolean);
  if (toks.length === 0) return [];
  const optsBase = {
    boost: fieldsBoost,
    prefix: true,
    fuzzy: (term) => (term.length >= 5 && !/^\d+$/.test(term) ? fuzzy : false),
  };

  let hits = [];
  if (toks.length >= 2 && toks.length <= 5) {
    hits = idx.search(queryStr, { ...optsBase, combineWith: AND }).slice(0, limit);
  }
  if (hits.length < 15) {
    const orHits = idx.search(queryStr, { ...optsBase, combineWith: OR }).slice(0, limit);
    if (hits.length === 0) {
      hits = orHits;
    } else {
      const seen = new Set(hits.map((h) => h.id));
      for (const h of orHits) {
        if (!seen.has(h.id)) {
          seen.add(h.id);
          hits.push({ ...h, score: h.score * 0.55 });
        }
        if (hits.length >= limit) break;
      }
    }
  }
  return hits;
}

function applyClinicalRerank(candidates, qInfo, docs, { substAware = true, brandToCanonSubs = null } = {}) {
  const scored = [];
  let targetSigInfo = null;
  if (substAware && qInfo.isSubstitution && brandToCanonSubs && qInfo.detectedBrands.length > 0) {
    targetSigInfo = brandToCanonSubs.get(qInfo.detectedBrands[0]) || null;
  }
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const doc = docs[cand.id];
    if (!doc) continue;

    // 1. Strict user negation filter ("sans paracetamol", "sans aspirine", etc.)
    if (qInfo.excludeSubstances.length > 0) {
      let violated = false;
      for (const ex of qInfo.excludeSubstances) {
        if (doc._haySub.includes(ex)) {
          violated = true;
          break;
        }
      }
      if (violated) continue;
    }

    let s = cand.score;

    // 2. Commercialized & ambulatory default prior
    s *= doc.is_commercialisee ? 1.35 : 0.12;
    if (!qInfo.wantsHospital && doc.is_hospital) {
      s *= 0.35;
    }

    // 3. Positive "sanssucre" requirement (sirop sans sucre)
    if (qInfo.requireSansSucre) {
      s *= /\bsanssucre\b/.test(doc._negText) ? 3.5 : 0.08;
    }

    // 4. OTC ("sans ordonnance")
    if (qInfo.requireOtc) {
      if (doc.is_hospital || doc.is_prescription) s *= 0.015;
      else s *= 1.6;
    }

    // 5. Pediatric / adult dosage guard
    if (qInfo.isPediatric) {
      if (doc._pediatricFriendly) s *= 1.5;
      if (doc._adultHighDose) s *= 0.1;
    }

    // 6. Pregnancy contraindication guard (auto-derived from RCP 4.3 / 4.6)
    if (qInfo.isPregnancy) {
      if (doc._ciGrossesse) s *= 0.03;
      else if (doc.rcp_46 && /peut etre envisage/.test(normalizeText(doc.rcp_46))) s *= 1.5;
    }

    // 7. Substitution / generic intent awareness
    if (substAware && qInfo.isSubstitution) {
      const asksGeneric = /\b(generique|remplacer|alternative|equivalent)\b/.test(qInfo.norm);
      const asksActiveInfo = /\b(principe actif|quelle molecule|quel est le principe)\b/.test(qInfo.norm);
      if (asksGeneric && !asksActiveInfo) {
        if (targetSigInfo) {
          if (doc.sub_sig === targetSigInfo.subSig) s *= 2.6;
          else if (doc.canonical_subs.length > targetSigInfo.subs.length) s *= 0.2;
        }
        if (doc.gener_type === '0') s *= 0.18;
        else if (doc.gener_type && doc.gener_type !== '0') s *= 1.4;
        for (const brand of qInfo.detectedBrands) {
          if (doc._denomNorm.startsWith(brand)) {
            s *= 0.12;
            break;
          }
        }
      }
    }

    scored.push({ id: cand.id, score: s, rawScore: cand.score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function buildExpansionTerms(qInfo, { useBrands = false, useGalenic = false, useMorph = false, useLexV1 = false } = {}) {
  const parts = [...qInfo.contentTerms];
  if (useBrands && qInfo.isSubstitution && qInfo.inferredSubTerms.length > 0) {
    // Asking for generic/equivalent/alternative of a brand: lean on its inferred active substance
    const keepNumericOrForm = qInfo.contentTerms.filter(
      (t) => !qInfo.detectedBrands.includes(t)
    );
    return {
      lexTerms: [...new Set([...qInfo.inferredSubTerms, ...keepNumericOrForm])],
      vecTerms: [...new Set([...qInfo.inferredSubTerms, ...keepNumericOrForm, ...qInfo.detectedBrands])],
      extraBoosts: [],
    };
  }
  if (useGalenic) {
    for (const t of qInfo.contentTerms) {
      const syns = GALENIC_SYNONYMS[t];
      if (syns) {
        for (const s of syns) parts.push(s);
      }
    }
  }
  if (useMorph) {
    for (const st of qInfo.morphTerms) parts.push(st);
  }
  const extraBoosts = [];
  if (useLexV1) {
    for (const t of qInfo.contentTerms) {
      const exp = LEXICON_V1[t];
      if (exp) {
        for (const [medTerm, w] of exp) {
          extraBoosts.push([medTerm, w]);
          parts.push(medTerm);
        }
      }
    }
  }
  return {
    lexTerms: [...new Set(parts)],
    vecTerms: [...new Set(parts)],
    extraBoosts,
  };
}

function rrfFuse(lexRanked, vecRanked, { rrfK = 40, vecWeight = 0.8, limit = 80 } = {}) {
  const map = new Map();
  const maxL = Math.min(limit, lexRanked.length);
  for (let i = 0; i < maxL; i++) {
    const id = lexRanked[i].id;
    map.set(id, { id, score: 1 / (rrfK + i + 1), lexRank: i + 1, vecRank: null });
  }
  const maxV = Math.min(limit, vecRanked.length);
  for (let i = 0; i < maxV; i++) {
    const id = vecRanked[i].id;
    const contrib = vecWeight / (rrfK + i + 1);
    const prev = map.get(id);
    if (prev) {
      prev.score += contrib;
      prev.vecRank = i + 1;
    } else {
      map.set(id, { id, score: contrib, lexRank: null, vecRank: i + 1 });
    }
  }
  const out = [...map.values()];
  out.sort((a, b) => b.score - a.score);
  return out;
}

function evaluateModel(name, runner, suite, docs) {
  const latencies = [];
  const rows = [];
  const oosRows = [];

  for (const qItem of suite) {
    const t0 = performance.now();
    const resIds = runner(qItem);
    const dt = performance.now() - t0;
    latencies.push(dt);

    const top10 = resIds.slice(0, 10).map((id) => docs[id]).filter(Boolean);
    const top5 = top10.slice(0, 5);
    const top3 = top10.slice(0, 3);
    const top1 = top10[0] || null;

    if (qItem.isOos) {
      oosRows.push({
        qItem,
        hallucinated: top10.length > 0,
        count: top10.length,
        top1Name: top1 ? top1.denomination : null,
      });
      continue;
    }

    let firstRelRank = -1;
    let relIn5 = 0;
    let relIn10 = 0;
    let trapIn5 = false;
    let trapReason = null;

    for (let r = 0; r < top10.length; r++) {
      const d = top10[r];
      const isRel = qItem.checkRelevant(d);
      if (isRel) {
        if (firstRelRank === -1) firstRelRank = r;
        if (r < 5) relIn5++;
        relIn10++;
      }
      if (r < 5 && !trapIn5 && qItem.checkTrap) {
        const tr = qItem.checkTrap(d, r);
        if (tr) {
          trapIn5 = true;
          trapReason = tr;
        }
      }
    }

    const commTop3 =
      top3.length > 0 ? top3.filter((d) => d.is_commercialisee).length / top3.length : 0;

    rows.push({
      id: qItem.id,
      category: qItem.category,
      query: qItem.query,
      p1: top1 && qItem.checkRelevant(top1) ? 1 : 0,
      hits5: relIn5 > 0 ? 1 : 0,
      prec5: relIn5 / 5,
      r10: relIn10 > 0 ? 1 : 0,
      mrr10: firstRelRank !== -1 ? 1 / (firstRelRank + 1) : 0,
      trap5: trapIn5 ? 1 : 0,
      trapReason,
      commTop3,
      top3Names: top3.map((d) => d.denomination),
      empty: top10.length === 0 ? 1 : 0,
    });
  }

  function agg(list) {
    const n = list.length || 1;
    return {
      n: list.length,
      p1: list.reduce((a, b) => a + b.p1, 0) / n,
      hits5: list.reduce((a, b) => a + b.hits5, 0) / n,
      prec5: list.reduce((a, b) => a + b.prec5, 0) / n,
      r10: list.reduce((a, b) => a + b.r10, 0) / n,
      mrr10: list.reduce((a, b) => a + b.mrr10, 0) / n,
      trap5: list.reduce((a, b) => a + b.trap5, 0) / n,
      comm3: list.reduce((a, b) => a + b.commTop3, 0) / n,
      empty: list.reduce((a, b) => a + b.empty, 0) / n,
    };
  }

  const byCat = {};
  for (const r of rows) {
    if (!byCat[r.category]) byCat[r.category] = [];
    byCat[r.category].push(r);
  }
  const catSummary = {};
  for (const [k, v] of Object.entries(byCat)) {
    catSummary[k] = agg(v);
  }

  const oosHall = oosRows.length
    ? oosRows.filter((x) => x.hallucinated).length / oosRows.length
    : 0;

  return {
    name,
    overall: agg(rows),
    byCat: catSummary,
    oosHallRate: oosHall,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    rows,
    oosRows,
  };
}

async function main() {
  console.log('=== BENCHMARK RIGOUREUX v2 : fr.gouv.medicaments.rest x FrozenMiniSearch ===\n');
  const corpus = loadBdpmRigorousCorpus({ includeRcp48: true });
  precomputeDocHelpers(corpus);

  const commCount = corpus.docs.filter((d) => d.is_commercialisee).length;
  const generCount = corpus.docs.filter((d) => d.gener_group_id !== null).length;
  const rcp41Count = corpus.docs.filter((d) => d.rcp_41.length > 0).length;
  const rcp48Count = corpus.docs.filter((d) => d.rcp_48.length > 0).length;
  const clsCount = corpus.docs.filter((d) => d.classe_pharm.length > 0).length;
  const atcCount = corpus.docs.filter((d) => d.atc_code.length > 0).length;

  console.log(`[Corpus BDPM] Specs=${corpus.docs.length} | Commercialisées=${commCount} | CIS_GENER=${generCount} (${fmtPct(generCount / corpus.docs.length)})`);
  console.log(`[Auto Links]  Marques->Molécules (CIS_bdpm×CIS_COMPO)=${corpus.brandToCanonSubs.size} | Signatures=${corpus.docsBySubSig.size}`);
  console.log(`[RCP/Clinique] RCP 4.1=${rcp41Count} | RCP 4.8=${rcp48Count} | Classe pharm=${clsCount} | ATC=${atcCount}\n`);

  // Build M0_PROD baseline (real fr.gouv.medicaments.rest dataLoader + executeHybridSearchPage)
  process.env.DATA_DIR = corpus.dataDir;
  process.env.LOAD_HAS_AVIS = 'false';
  const { loadData } = require('../../../src/services/dataLoader');
  const { executeHybridSearchPage } = require('../../../src/services/searchOrchestrator');
  const tProd0 = performance.now();
  await loadData();
  const prodLoadMs = performance.now() - tProd0;
  console.log(`[M0_PROD] loadData() terminé en ${prodLoadMs.toFixed(0)} ms\n`);

  // Build RichRaw docs (NO _sem, NO brand inference)
  const docsRich = corpus.docs.map((d) => ({
    id: d.id,
    cis: d.cis,
    denomination: maskNegativeLabelBigrams(normalizeText(d.denomination)),
    substances: maskNegativeLabelBigrams(
      normalizeText(`${d.canonical_subs.join(' ')} ${d.substances_raw.join(' ')}`)
    ),
    classe_pharm: normalizeText(d.classe_pharm),
    atc: d.atc_code,
    rcp_pos: maskNegativeLabelBigrams(normalizeText(`${d.smr_str} ${d.rcp_41}`)),
    forme_voie: maskNegativeLabelBigrams(normalizeText(`${d.forme_pharma} ${d.voie}`)),
  }));

  // Build AutoBDPM docs (Approaches 2A + 2B: auto CIS_GENER + auto Brand<->Mol + galenic, ZERO symptom lexicon)
  const docsAuto = corpus.docs.map((d, i) => {
    const base = docsRich[i];
    const semParts = [];
    if (d.gener_group_id) {
      semParts.push(d.gener_type === '0' ? 'princeps' : 'generique');
      const princs = corpus.princepsByGroup.get(d.gener_group_id) || [];
      for (const pName of princs) {
        semParts.push(normalizeText(pName.split(',')[0]));
      }
      if (d.gener_label) semParts.push(normalizeText(d.gener_label));
    }
    const gal = buildGalenicSemForDoc(d);
    if (gal) semParts.push(gal);
    return {
      ...base,
      _sem: maskNegativeLabelBigrams(semParts.join(' ')),
    };
  });

  // Build AutoBDPM + Morph docs (Approach 2C)
  const docsAutoMorph = docsAuto.map((d) => ({
    ...d,
    _morph: buildMorphString(`${d.denomination} ${d.substances} ${d.classe_pharm} ${d.rcp_pos}`),
  }));

  // Separate RCP Safety Index (4.8 adverse events + 4.3/4.6 contraindications) — Approach 2D
  const docsSafety = corpus.docs.map((d) => ({
    id: d.id,
    denomination: docsRich[d.id].denomination,
    rcp_48: normalizeText(d.rcp_48),
    rcp_4346: normalizeText(`${d.rcp_43} ${d.rcp_46}`),
  }));

  const idxRich = buildFrozenWithStats(docsRich, {
    fields: ['cis', 'denomination', 'substances', 'classe_pharm', 'atc', 'rcp_pos', 'forme_voie'],
    idField: 'id',
  });
  const idxAuto = buildFrozenWithStats(docsAuto, {
    fields: ['cis', 'denomination', 'substances', 'classe_pharm', 'atc', 'rcp_pos', 'forme_voie', '_sem'],
    idField: 'id',
  });
  const idxAutoMorph = buildFrozenWithStats(docsAutoMorph, {
    fields: ['cis', 'denomination', 'substances', 'classe_pharm', 'atc', 'rcp_pos', 'forme_voie', '_sem', '_morph'],
    idField: 'id',
  });
  const idxSafety = buildFrozenWithStats(docsSafety, {
    fields: ['denomination', 'rcp_48', 'rcp_4346'],
    idField: 'id',
  });

  // Build LSA 128 and LSA 256 on strictly POSITIVE text (NO rcp_48, NO rcp_43)
  const lsaCorpusTexts = corpus.docs.map((d) => {
    const subs = d.canonical_subs.join(' ');
    const gal = buildGalenicSemForDoc(d);
    // Repeat active molecule and therapeutic class 2x so clinical axes anchor SVD concepts
    return `${docsRich[d.id].denomination} ${subs} ${subs} ${d.classe_pharm} ${d.classe_pharm} ${d.atc_code} ${d.smr_str} ${d.rcp_41} ${gal}`;
  });
  const lsa128 = buildLsaIndex(lsaCorpusTexts, { k: 128, powerIter: 2, minDf: 3, maxDfRatio: 0.55 });
  const lsa256 = buildLsaIndex(lsaCorpusTexts, { k: 256, powerIter: 2, minDf: 3, maxDfRatio: 0.55 });

  console.log('--- Empreinte Mémoire & Temps de Build ---');
  for (const [label, b] of [
    ['Idx RichRaw (pos)', idxRich],
    ['Idx AutoBDPM (2A+2B)', idxAuto],
    ['Idx AutoBDPM+Morph (2C)', idxAutoMorph],
    ['Idx RcpSafety (4.8/4.3)', idxSafety],
  ]) {
    console.log(
      `  ${label.padEnd(26)} build=${b.buildMs.toFixed(0).padStart(5)}ms | terms=${String(b.termCount).padStart(6)} | .msbin=${fmtMb(b.msbinBytes)} | .gz=${fmtMb(b.msbinGzBytes)}`
    );
  }
  console.log(
    `  ${'LSA-128 Int8'.padEnd(26)} build=${lsa128.buildMs.toFixed(0).padStart(5)}ms | vocab=${String(lsa128.V).padStart(6)} | RAM=${fmtMb(lsa128.runtimeBytes)} | docGz=${fmtMb(zlib.gzipSync(Buffer.from(lsa128.docVecs.buffer)).length)}`
  );
  console.log(
    `  ${'LSA-256 Int8'.padEnd(26)} build=${lsa256.buildMs.toFixed(0).padStart(5)}ms | vocab=${String(lsa256.V).padStart(6)} | RAM=${fmtMb(lsa256.runtimeBytes)} | docGz=${fmtMb(zlib.gzipSync(Buffer.from(lsa256.docVecs.buffer)).length)}\n`
  );

  const BOOST_BASE = {
    cis: 6,
    atc: 5,
    denomination: 4,
    substances: 3.5,
    classe_pharm: 2.2,
    forme_voie: 1.5,
    rcp_pos: 1.1,
  };
  const BOOST_AUTO = { ...BOOST_BASE, _sem: 2.6 };
  const BOOST_MORPH = { ...BOOST_AUTO, _morph: 1.4 };

  const docIdByCis = corpus.docByCis;

  function runStructuredLex(idxObj, boosts, rawQuery, opts = {}) {
    const qInfo = analyzeQuery(rawQuery, corpus.brandToCanonSubs);
    const { useBrands, useGalenic, useMorph, useLexV1, confidenceGate } = opts;

    // Route causal 4.8 & contraindication 4.3/4.6 queries to dedicated RcpSafety index (M1b+)
    if (qInfo.isAdverse || qInfo.isContraindication) {
      const targetField = qInfo.isAdverse ? 'rcp_48' : 'rcp_4346';
      const safetyBoost = qInfo.isAdverse ? { rcp_48: 4, denomination: 0.5, rcp_4346: 0 } : { rcp_4346: 4, denomination: 0.5, rcp_48: 0 };
      const qStr = qInfo.contentTerms.join(' ');
      if (!qStr) return [];
      const hits = idxSafety.idx.search(qStr, {
        fields: [targetField, 'denomination'],
        boost: safetyBoost,
        combineWith: OR,
        prefix: true,
        fuzzy: 0.15,
      }).slice(0, 80);
      return applyClinicalRerank(hits, qInfo, corpus.docs, { substAware: false }).map((x) => x.id);
    }

    const exp = buildExpansionTerms(qInfo, { useBrands, useGalenic, useMorph, useLexV1 });
    const qStr = exp.lexTerms.join(' ');
    if (!qStr) return [];

    const lexHits = searchTwoPass(idxObj.idx, qStr, boosts, 100, 0.2);

    // Optional confidence gate for OOS abstention evaluation
    if (confidenceGate && lexHits.length === 0) return [];
    if (confidenceGate) {
      const contentLen = qInfo.contentTerms.length;
      const topHit = lexHits[0];
      const matchedTermsCount = topHit && topHit.terms ? topHit.terms.length : 0;
      // Compute if AT LEAST 1 domain/medical term or decent vector similarity supports this query
      const hasStrongLex = topHit && topHit.score >= 3.2 && (contentLen <= 2 ? matchedTermsCount >= 1 : matchedTermsCount >= 2 || topHit.score >= 8.0);
      if (!hasStrongLex) {
        return [];
      }
    }

    return applyClinicalRerank(lexHits, qInfo, corpus.docs, { substAware: useBrands, brandToCanonSubs: corpus.brandToCanonSubs }).map((x) => x.id);
  }

  function runHybrid(idxObj, boosts, lsa, rawQuery, { confidenceGate = false } = {}) {
    const qInfo = analyzeQuery(rawQuery, corpus.brandToCanonSubs);

    if (qInfo.isAdverse || qInfo.isContraindication) {
      const targetField = qInfo.isAdverse ? 'rcp_48' : 'rcp_4346';
      const qStr = qInfo.contentTerms.join(' ');
      if (!qStr) return [];
      const hits = idxSafety.idx.search(qStr, {
        fields: [targetField, 'denomination'],
        boost: qInfo.isAdverse ? { rcp_48: 4, denomination: 0.4 } : { rcp_4346: 4, denomination: 0.4 },
        combineWith: OR,
        prefix: true,
        fuzzy: 0.15,
      }).slice(0, 80);
      return applyClinicalRerank(hits, qInfo, corpus.docs, { substAware: false }).map((x) => x.id);
    }

    const exp = buildExpansionTerms(qInfo, { useBrands: true, useGalenic: true });
    const qStr = exp.lexTerms.join(' ');
    if (!qStr) return [];

    const lexHits = searchTwoPass(idxObj.idx, qStr, boosts, 100, 0.2);

    // Exact CIS or ATC fast-path: skip LSA dilution on exact identifier codes
    const isCodeQuery = /^(?:\d{8}|[a-z]\d{2}[a-z0-9]{0,4})$/i.test(qInfo.norm.trim());
    if (isCodeQuery && lexHits.length > 0) {
      return applyClinicalRerank(lexHits, qInfo, corpus.docs, { substAware: true, brandToCanonSubs: corpus.brandToCanonSubs }).map((x) => x.id);
    }

    const vecHits = searchTopKLsa(lsa, exp.vecTerms, 80);

    if (confidenceGate) {
      const topLex = lexHits[0];
      const topVec = vecHits[0];
      const vecCos = topVec ? topVec.score / (127 * 127) : 0;
      const nonNumericLex = topLex && topLex.terms
        ? topLex.terms.filter((t) => t.length >= 4 && !/^\d+$/.test(t) && !/^(?:mg|ml|kg|ui)$/.test(t))
        : [];
      const contentAlpha = qInfo.contentTerms.filter((t) => t.length >= 4 && !/^\d+$/.test(t) && !/^(?:mg|ml|kg|ui)$/.test(t));
      const strongLex = topLex && nonNumericLex.length >= Math.min(2, Math.max(1, contentAlpha.length)) && topLex.score >= 4.0;
      const strongSingleField = topLex && nonNumericLex.length >= 1 && topLex.score >= 12.0;
      const strongVec = vecCos >= 0.45 && nonNumericLex.length >= 1;
      if (!strongLex && !strongSingleField && !strongVec) return [];
    }

    const fused = rrfFuse(lexHits, vecHits, { rrfK: 40, vecWeight: 0.85, limit: 100 });
    return applyClinicalRerank(fused, qInfo, corpus.docs, { substAware: true, brandToCanonSubs: corpus.brandToCanonSubs }).map((x) => x.id);
  }

  const suite = buildEvalSuite(corpus);
  console.log(`[Eval Suite] ${suite.length} requêtes réparties sur 10 sous-catégories.\n`);

  const models = [
    [
      'M0_PROD_Hybrid',
      (q) => {
        const res = executeHybridSearchPage(q.query, 'human', 1, 20);
        const ids = [];
        for (const r of res.results) {
          const d = docIdByCis.get(r.cis);
          if (d) ids.push(d.id);
        }
        return ids;
      },
    ],
    [
      'M1_Rich_BM25_OR',
      (q) =>
        idxRich.idx
          .search(normalizeText(q.query), {
            boost: BOOST_BASE,
            combineWith: OR,
            prefix: true,
            fuzzy: 0.2,
          })
          .slice(0, 20)
          .map((h) => h.id),
    ],
    [
      'M1b_Rich_Clean',
      (q) => runStructuredLex(idxRich, BOOST_BASE, q.query, { useBrands: false, useGalenic: false }),
    ],
    [
      'M2_AutoBDPM_2A2B',
      (q) => runStructuredLex(idxAuto, BOOST_AUTO, q.query, { useBrands: true, useGalenic: true }),
    ],
    [
      'M2b_AutoBDPM_Morph',
      (q) => runStructuredLex(idxAutoMorph, BOOST_MORPH, q.query, { useBrands: true, useGalenic: true, useMorph: true }),
    ],
    [
      'M2c_Auto_LexV1',
      (q) => runStructuredLex(idxAuto, BOOST_AUTO, q.query, { useBrands: true, useGalenic: true, useLexV1: true }),
    ],
    [
      'M3_LSA128_Pure',
      (q) => {
        const qInfo = analyzeQuery(q.query, corpus.brandToCanonSubs);
        const terms = qInfo.contentTerms.length ? qInfo.contentTerms : qInfo.rawTokens;
        return searchTopKLsa(lsa128, terms, 20).map((h) => h.id);
      },
    ],
    [
      'M3_LSA256_Pure',
      (q) => {
        const qInfo = analyzeQuery(q.query, corpus.brandToCanonSubs);
        const terms = qInfo.contentTerms.length ? qInfo.contentTerms : qInfo.rawTokens;
        return searchTopKLsa(lsa256, terms, 20).map((h) => h.id);
      },
    ],
    [
      'M3_Hyb_LSA128',
      (q) => runHybrid(idxAuto, BOOST_AUTO, lsa128, q.query),
    ],
    [
      'M3_Hyb_LSA256',
      (q) => runHybrid(idxAuto, BOOST_AUTO, lsa256, q.query),
    ],
    [
      'M3_Hyb_LSA256_Gate',
      (q) => runHybrid(idxAuto, BOOST_AUTO, lsa256, q.query, { confidenceGate: true }),
    ],
  ];

  const results = [];
  for (const [mName, fn] of models) {
    results.push(evaluateModel(mName, fn, suite, corpus.docs));
  }

  console.log('=== TABLEAU 1 : GLOBAL (216 requêtes valides + 10 requêtes hors-périmètre) ===');
  console.log(
    'Modèle'.padEnd(20) +
      'P@1'.padStart(7) +
      'Hit@5'.padStart(7) +
      'Prec@5'.padStart(7) +
      'R@10'.padStart(7) +
      'MRR@10'.padStart(8) +
      'Trap@5'.padStart(8) +
      'Comm@3'.padStart(8) +
      'OOS_Hall'.padStart(9) +
      'Empty'.padStart(7) +
      'p50ms'.padStart(7) +
      'p95ms'.padStart(7)
  );
  console.log('-'.repeat(103));
  for (const r of results) {
    const o = r.overall;
    console.log(
      r.name.padEnd(20) +
        fmtPct(o.p1).padStart(7) +
        fmtPct(o.hits5).padStart(7) +
        fmtPct(o.prec5).padStart(7) +
        fmtPct(o.r10).padStart(7) +
        o.mrr10.toFixed(3).padStart(8) +
        fmtPct(o.trap5).padStart(8) +
        fmtPct(o.comm3).padStart(8) +
        fmtPct(r.oosHallRate).padStart(9) +
        fmtPct(o.empty).padStart(7) +
        r.p50Ms.toFixed(1).padStart(7) +
        r.p95Ms.toFixed(1).padStart(7)
    );
  }

  const cats = Object.keys(results[0].byCat);
  console.log('\n=== TABLEAU 2 : MRR@10 PAR CATÉGORIE ===');
  console.log('Catégorie'.padEnd(22) + results.map((r) => r.name.replace(/^M\d+[a-z]?_/, '').slice(0, 9).padStart(10)).join(''));
  console.log('-'.repeat(22 + results.length * 10));
  for (const cat of cats) {
    const line =
      `${cat}(${results[0].byCat[cat].n})`.padEnd(22) +
      results.map((r) => r.byCat[cat].mrr10.toFixed(3).padStart(10)).join('');
    console.log(line);
  }

  console.log('\n=== TABLEAU 3 : HITS@5 (%) PAR CATÉGORIE ===');
  console.log('Catégorie'.padEnd(22) + results.map((r) => r.name.replace(/^M\d+[a-z]?_/, '').slice(0, 9).padStart(10)).join(''));
  console.log('-'.repeat(22 + results.length * 10));
  for (const cat of cats) {
    const line =
      `${cat}(${results[0].byCat[cat].n})`.padEnd(22) +
      results.map((r) => fmtPct(r.byCat[cat].hits5).padStart(10)).join('');
    console.log(line);
  }

  console.log('\n=== TABLEAU 4 : TRAP RATE @5 (%) PAR CATÉGORIE ===');
  console.log('Catégorie'.padEnd(22) + results.map((r) => r.name.replace(/^M\d+[a-z]?_/, '').slice(0, 9).padStart(10)).join(''));
  console.log('-'.repeat(22 + results.length * 10));
  for (const cat of cats) {
    const line =
      `${cat}(${results[0].byCat[cat].n})`.padEnd(22) +
      results.map((r) => fmtPct(r.byCat[cat].trap5).padStart(10)).join('');
    console.log(line);
  }

  // Qualitative showcase on key user-mentioned & tricky queries
  const keyQueries = [
    'que prendre contre les maux de tete ?',
    'quel medoc pour la tension ?',
    'equivalent du doliprane',
    'equivalent du gaviscon',
    'sucre eleve dans le sang diabete',
    'quel medicament donne des maux de tete en effet secondaire ?',
    'anti inflammatoire douleur sans aspirine',
    'vers dans le ventre enfant demangeaisons',
    'medicament pour la constipation depuis 3 jours',
    'croquettes chiens sterilises 10 kg',
  ];
  const showcaseModels = ['M0_PROD_Hybrid', 'M2_AutoBDPM_2A2B', 'M3_LSA256_Pure', 'M3_Hyb_LSA256', 'M3_Hyb_LSA256_Gate'];
  console.log('\n=== EXEMPLES QUALITATIFS (Top-3) ===');
  for (const qText of keyQueries) {
    console.log(`\nQ: "${qText}"`);
    for (const mName of showcaseModels) {
      const mRes = results.find((x) => x.name === mName);
      const row = mRes.rows.find((x) => x.query === qText) || mRes.oosRows.find((x) => x.qItem.query === qText);
      if (row && row.top3Names) {
        const mark = row.p1 ? '[OK@1]' : row.hits5 ? '[OK@5]' : '[MISS]';
        const tr = row.trapReason ? ` TRAP=${row.trapReason}` : '';
        console.log(`  ${mName.padEnd(19)} ${mark}${tr} -> ${row.top3Names.join(' | ') || '(VIDE)'}`);
      } else if (row) {
        console.log(`  ${mName.padEnd(19)} ${row.hallucinated ? `[OOS_HALL n=${row.count}]` : '[OOS_ABSTAIN]'} -> ${row.top1Name || '(VIDE)'}`);
      }
    }
  }

  // Honest Failure Analysis for M3_Hyb_LSA256 on F5b, F4, F6
  const hyb256 = results.find((x) => x.name === 'M3_Hyb_LSA256');
  console.log('\n=== ANALYSE DES ÉCHECS : M3_Hyb_LSA256 (Hits@5 == 0 ou Trap@5 == 1) ===');
  const fails = hyb256.rows.filter((r) => r.hits5 === 0 || r.trap5 === 1);
  console.log(`Total cas en échec ou piège sur 216 requêtes : ${fails.length}`);
  for (const f of fails.slice(0, 25)) {
    console.log(
      `  [${f.category} ${f.id}] "${f.query}" | hits5=${f.hits5} trap=${f.trapReason || '-'} | Top3: ${f.top3Names.join(' | ') || '(VIDE)'}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
