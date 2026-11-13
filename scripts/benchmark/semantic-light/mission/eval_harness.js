'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const request = require('supertest');

const medicamentRoutes = require('../../../../src/routes/medicaments');
const { executeHybridSearchPage } = require('../../../../src/services/searchOrchestrator');
const { shapeSearchResults } = require('../../../../src/utils/searchResponseShape');

function dcgAtK(relevances, k) {
  let sum = 0;
  for (let i = 0; i < Math.min(k, relevances.length); i++) {
    const rel = relevances[i];
    if (rel > 0) sum += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }
  return sum;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}

function round(v, digits = 3) {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

/**
 * Évalue une fonction `searchFn(queryCase, page, limit)` qui retourne :
 *   { total, results, search, timing? }
 * où chaque élément de `results` contient { type, cis, num, match_quality, match_via, criteria_match? }.
 */
async function evaluateSystem(name, evalSuite, searchFn, {
  split = 'all',
  provenance = 'all',
  measureHttp = false,
  httpRouteFn = null
} = {}) {
  const cases = evalSuite.cases.filter((c) => {
    if (split !== 'all' && c.split !== split) return false;
    if (provenance !== 'all' && c.provenance !== provenance) return false;
    return true;
  });

  const validMetrics = {
    n: 0,
    identityTop1: 0,
    variantTop1: 0,
    hit5Var: 0,
    hit10Var: 0,
    mrr10Var: 0,
    ndcg10Var: 0,
    recall10: 0,
    recall10Capped: 0,
    trapTop1: 0,
    trapBeforeVar: 0,
    empty: 0,
    dedupViolations: 0,
    qualityChecks: 0,
    qualityFailures: 0,
    sourceChecks: 0,
    sourceFailures: 0
  };
  const impossibleMetrics = { n: 0, falseCriteria: 0, fakeStrongOrMulti: 0 };
  const oosMetrics = { n: 0, nonEmpty: 0, strongFalsePositive: 0 };
  const byFamily = {};
  const latencies = [];
  const perCase = [];

  for (const tc of cases) {
    const fam = (byFamily[tc.family] ??= {
      n: 0, validN: 0, impossibleN: 0, oosN: 0,
      identityTop1: 0, variantTop1: 0, mrr10Var: 0, ndcg10Var: 0, recall10Capped: 0,
      trapTop1: 0, empty: 0, failures: 0
    });
    fam.n++;

    const t0 = process.hrtime.bigint();
    const out = await searchFn(tc, 1, 10);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    latencies.push(ms);

    const results = out.results || [];
    const ids = results.map((r) => (r.type === 'medicament_veterinaire' ? r.num : r.cis));
    const uniqueIds = new Set(ids);
    if (uniqueIds.size !== ids.length) validMetrics.dedupViolations += (ids.length - uniqueIds.size);

    if (tc.oos) {
      fam.oosN++;
      oosMetrics.n++;
      if (results.length > 0) oosMetrics.nonEmpty++;
      const strong = results.some((r) => r.match_quality === 'exact' || r.match_quality === 'prefix' || r.match_quality === 'semantic_strong');
      if (strong) {
        oosMetrics.strongFalsePositive++;
        fam.failures++;
      }
      perCase.push({ id: tc.id, family: tc.family, split: tc.split, q: tc.q, kind: 'oos', total: out.total, strong, top1: results[0] ? (results[0].denomination || results[0].nom) : null, ms: round(ms, 2) });
      continue;
    }

    if (tc.impossible) {
      fam.impossibleN++;
      impossibleMetrics.n++;
      let badCriteria = false;
      if (tc.forbidCriteriaSatisfied && results.length > 0) {
        badCriteria = results.slice(0, 5).some((r) => {
          const cm = r.criteria_match || {};
          return tc.forbidCriteriaSatisfied.every((k) => cm[k] === true);
        });
      }
      let fakeStrong = false;
      if (tc.multiSubstanceExpected && results.some((r) => (r.criteria_match && r.criteria_match.all_substances === true) || r.match_quality === 'exact' || r.match_quality === 'prefix')) {
        fakeStrong = true;
      }
      if (/^\d+$/.test(tc.q.trim()) && results.some((r) => r.match_quality === 'exact' || r.match_quality === 'prefix' || r.match_quality === 'semantic_strong')) {
        fakeStrong = true;
      }
      if (badCriteria) impossibleMetrics.falseCriteria++;
      if (fakeStrong) impossibleMetrics.fakeStrongOrMulti++;
      if (badCriteria || fakeStrong) fam.failures++;
      perCase.push({ id: tc.id, family: tc.family, split: tc.split, q: tc.q, kind: 'impossible', total: out.total, badCriteria, fakeStrong, top1: results[0] ? (results[0].denomination || results[0].nom) : null, ms: round(ms, 2) });
      continue;
    }

    // Valid recoverable query
    fam.validN++;
    validMetrics.n++;
    const idSet = new Set(tc.expectedIdentityIds || []);
    const varSet = new Set(tc.expectedVariantIds || []);
    const trapSet = new Set(tc.trapIds || []);

    if (ids.length === 0) {
      validMetrics.empty++;
      fam.empty++;
    }
    const id1 = ids.length > 0 && idSet.has(ids[0]) ? 1 : 0;
    const var1 = ids.length > 0 && varSet.has(ids[0]) ? 1 : 0;
    const hit5 = ids.slice(0, 5).some((id) => varSet.has(id)) ? 1 : 0;
    const hit10 = ids.slice(0, 10).some((id) => varSet.has(id)) ? 1 : 0;
    const firstVarIdx = ids.slice(0, 10).findIndex((id) => varSet.has(id));
    const mrr10 = firstVarIdx >= 0 ? 1 / (firstVarIdx + 1) : 0;

    // Graded nDCG@10 (2 = exact variant, 1 = same identity, 0 = irrelevant)
    const rels = ids.slice(0, 10).map((id) => (varSet.has(id) ? 2 : idSet.has(id) ? 1 : 0));
    const ideal = [];
    for (let i = 0; i < Math.min(10, varSet.size); i++) ideal.push(2);
    const idOnlyCount = Math.max(0, idSet.size - varSet.size);
    for (let i = 0; ideal.length < 10 && i < idOnlyCount; i++) ideal.push(1);
    const idcg = dcgAtK(ideal, 10);
    const ndcg10 = idcg > 0 ? dcgAtK(rels, 10) / idcg : 0;

    const matchedVar10 = ids.slice(0, 10).filter((id) => varSet.has(id)).length;
    const r10 = varSet.size > 0 ? matchedVar10 / varSet.size : 0;
    const r10Cap = varSet.size > 0 ? matchedVar10 / Math.min(10, varSet.size) : 0;

    const trapTop1 = ids.length > 0 && trapSet.has(ids[0]) ? 1 : 0;
    const firstTrapIdx = ids.slice(0, 5).findIndex((id) => trapSet.has(id));
    const trapBeforeVar = firstTrapIdx >= 0 && (firstVarIdx < 0 || firstTrapIdx < firstVarIdx) ? 1 : 0;

    validMetrics.identityTop1 += id1;
    validMetrics.variantTop1 += var1;
    validMetrics.hit5Var += hit5;
    validMetrics.hit10Var += hit10;
    validMetrics.mrr10Var += mrr10;
    validMetrics.ndcg10Var += ndcg10;
    validMetrics.recall10 += r10;
    validMetrics.recall10Capped += r10Cap;
    validMetrics.trapTop1 += trapTop1;
    validMetrics.trapBeforeVar += trapBeforeVar;

    fam.identityTop1 += id1;
    fam.variantTop1 += var1;
    fam.mrr10Var += mrr10;
    fam.ndcg10Var += ndcg10;
    fam.recall10Capped += r10Cap;
    fam.trapTop1 += trapTop1;

    if (tc.expectQualityAt1) {
      validMetrics.qualityChecks++;
      if (!results[0] || results[0].match_quality !== tc.expectQualityAt1) {
        validMetrics.qualityFailures++;
      }
    }
    if (tc.expectSourceWithResults || tc.expectSourceNotQueried) {
      validMetrics.sourceChecks++;
      const meta = out.search || {};
      const queried = (meta.referentiels && meta.referentiels.queried) || [];
      const withRes = (meta.referentiels && meta.referentiels.with_results) || [];
      let bad = false;
      if (tc.expectSourceWithResults) {
        for (const s of tc.expectSourceWithResults) {
          if (!withRes.includes(s)) bad = true;
        }
      }
      if (tc.expectSourceNotQueried) {
        for (const s of tc.expectSourceNotQueried) {
          if (queried.includes(s)) bad = true;
        }
      }
      if (bad) validMetrics.sourceFailures++;
    }

    perCase.push({
      id: tc.id,
      family: tc.family,
      split: tc.split,
      provenance: tc.provenance,
      q: tc.q,
      kind: 'valid',
      id1,
      var1,
      mrr10: round(mrr10),
      ndcg10: round(ndcg10),
      trapTop1,
      total: out.total,
      top1: results[0] ? `${results[0].cis || results[0].num} :: ${results[0].denomination || results[0].nom}` : null,
      top1Quality: results[0] ? results[0].match_quality : null,
      top1Via: results[0] ? results[0].match_via : null,
      ms: round(ms, 2)
    });
  }

  let httpStats = null;
  if (measureHttp && httpRouteFn) {
    const httpMs = [];
    for (const tc of cases.slice(0, 30)) {
      const t0 = process.hrtime.bigint();
      await httpRouteFn(tc);
      httpMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    httpStats = { p50Ms: round(percentile(httpMs, 0.5), 2), p95Ms: round(percentile(httpMs, 0.95), 2) };
  }

  const vn = validMetrics.n || 1;
  const familySummary = {};
  for (const [k, f] of Object.entries(byFamily)) {
    const fvn = f.validN || 1;
    familySummary[k] = {
      n: f.n,
      validN: f.validN,
      identityTop1: f.validN ? round(f.identityTop1 / fvn) : null,
      variantTop1: f.validN ? round(f.variantTop1 / fvn) : null,
      mrr10: f.validN ? round(f.mrr10Var / fvn) : null,
      ndcg10: f.validN ? round(f.ndcg10Var / fvn) : null,
      recall10Capped: f.validN ? round(f.recall10Capped / fvn) : null,
      trapTop1: f.validN ? round(f.trapTop1 / fvn) : null,
      empty: f.validN ? round(f.empty / fvn) : null,
      guardFailures: f.failures
    };
  }

  return {
    name,
    split,
    provenance,
    summary: {
      validN: validMetrics.n,
      identityTop1: round(validMetrics.identityTop1 / vn),
      variantTop1: round(validMetrics.variantTop1 / vn),
      hit5Var: round(validMetrics.hit5Var / vn),
      hit10Var: round(validMetrics.hit10Var / vn),
      mrr10: round(validMetrics.mrr10Var / vn),
      ndcg10: round(validMetrics.ndcg10Var / vn),
      recall10: round(validMetrics.recall10 / vn),
      recall10Capped: round(validMetrics.recall10Capped / vn),
      trapTop1: round(validMetrics.trapTop1 / vn),
      trapBeforeVar: round(validMetrics.trapBeforeVar / vn),
      emptyRate: round(validMetrics.empty / vn),
      dedupViolations: validMetrics.dedupViolations,
      qualityFailures: validMetrics.qualityFailures,
      sourceFailures: validMetrics.sourceFailures,
      impossibleN: impossibleMetrics.n,
      falseCriteriaRate: impossibleMetrics.n ? round(impossibleMetrics.falseCriteria / impossibleMetrics.n) : 0,
      fakeStrongMultiRate: impossibleMetrics.n ? round(impossibleMetrics.fakeStrongOrMulti / impossibleMetrics.n) : 0,
      oosN: oosMetrics.n,
      oosNonEmptyRate: oosMetrics.n ? round(oosMetrics.nonEmpty / oosMetrics.n) : 0,
      oosStrongFpRate: oosMetrics.n ? round(oosMetrics.strongFalsePositive / oosMetrics.n) : 0,
      latencyMs: {
        p50: round(percentile(latencies, 0.5), 2),
        p95: round(percentile(latencies, 0.95), 2),
        max: round(Math.max(...latencies), 2)
      },
      httpStats
    },
    byFamily: familySummary,
    perCase
  };
}

module.exports = {
  evaluateSystem
};
