'use strict';

/**
 * Notation déterministe de la suite curée (vérité connue par construction).
 *
 * Reprise, sans la partie HTTP, de `scripts/benchmark/semantic-light/mission/eval_harness.js`
 * (branche `experiment/semantic-light-search`, commit 231fb47) : mêmes métriques, mêmes règles,
 * pour que les scores restent comparables à ceux de la suite d'origine.
 *
 * `searchFn(case)` retourne `{ total, results, search }`, chaque résultat portant
 * `{ type, cis | num, match_quality, criteria_match? }`.
 */

function dcgAtK(relevances, k) {
  let sum = 0;
  for (let i = 0; i < Math.min(k, relevances.length); i++) {
    const rel = relevances[i];
    if (rel > 0) sum += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }
  return sum;
}

function round(v, digits = 3) {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

const STRONG = new Set(['exact', 'prefix', 'semantic_strong']);

function resultId(r) {
  return r.type === 'medicament_veterinaire' ? String(r.num) : String(r.cis);
}

function scoreCase(tc, out) {
  const results = out.results || [];
  const ids = results.map(resultId);
  const dedupViolations = ids.length - new Set(ids).size;

  if (tc.oos) {
    const strong = results.some((r) => STRONG.has(r.match_quality));
    return { kind: 'oos', nonEmpty: results.length > 0, strong, failed: strong, dedupViolations };
  }

  if (tc.impossible) {
    let badCriteria = false;
    if (tc.forbidCriteriaSatisfied && results.length > 0) {
      badCriteria = results.slice(0, 5).some((r) => {
        const cm = r.criteria_match || {};
        return tc.forbidCriteriaSatisfied.every((k) => cm[k] === true);
      });
    }
    let fakeStrong = false;
    if (tc.multiSubstanceExpected && results.some((r) =>
      (r.criteria_match && r.criteria_match.all_substances === true) || r.match_quality === 'exact' || r.match_quality === 'prefix')) {
      fakeStrong = true;
    }
    if (/^\d+$/.test(tc.q.trim()) && results.some((r) => STRONG.has(r.match_quality))) fakeStrong = true;
    return { kind: 'impossible', badCriteria, fakeStrong, failed: badCriteria || fakeStrong, dedupViolations };
  }

  const idSet = new Set(tc.expectedIdentityIds || []);
  const varSet = new Set(tc.expectedVariantIds || []);
  const trapSet = new Set(tc.trapIds || []);
  const firstVarIdx = ids.slice(0, 10).findIndex((id) => varSet.has(id));

  // nDCG@10 gradué : 2 = bonne variante, 1 = bonne identité, 0 = sans rapport
  const rels = ids.slice(0, 10).map((id) => (varSet.has(id) ? 2 : idSet.has(id) ? 1 : 0));
  const ideal = [];
  for (let i = 0; i < Math.min(10, varSet.size); i++) ideal.push(2);
  const idOnlyCount = Math.max(0, idSet.size - varSet.size);
  for (let i = 0; ideal.length < 10 && i < idOnlyCount; i++) ideal.push(1);
  const idcg = dcgAtK(ideal, 10);
  const firstTrapIdx = ids.slice(0, 5).findIndex((id) => trapSet.has(id));

  let qualityFailed = null;
  if (tc.expectQualityAt1) qualityFailed = !results[0] || results[0].match_quality !== tc.expectQualityAt1;
  let sourceFailed = null;
  if (tc.expectSourceWithResults || tc.expectSourceNotQueried) {
    const meta = out.search || {};
    const queried = (meta.referentiels && meta.referentiels.queried) || [];
    const withRes = (meta.referentiels && meta.referentiels.with_results) || [];
    sourceFailed = (tc.expectSourceWithResults || []).some((s) => !withRes.includes(s)) ||
      (tc.expectSourceNotQueried || []).some((s) => queried.includes(s));
  }

  return {
    kind: 'valid',
    empty: ids.length === 0,
    identityTop1: ids.length > 0 && idSet.has(ids[0]) ? 1 : 0,
    variantTop1: ids.length > 0 && varSet.has(ids[0]) ? 1 : 0,
    hit5Var: ids.slice(0, 5).some((id) => varSet.has(id)) ? 1 : 0,
    hit10Var: ids.slice(0, 10).some((id) => varSet.has(id)) ? 1 : 0,
    mrr10: firstVarIdx >= 0 ? 1 / (firstVarIdx + 1) : 0,
    ndcg10: idcg > 0 ? dcgAtK(rels, 10) / idcg : 0,
    recall10Capped: varSet.size > 0 ? ids.slice(0, 10).filter((id) => varSet.has(id)).length / Math.min(10, varSet.size) : 0,
    trapTop1: ids.length > 0 && trapSet.has(ids[0]) ? 1 : 0,
    trapBeforeVar: firstTrapIdx >= 0 && (firstVarIdx < 0 || firstTrapIdx < firstVarIdx) ? 1 : 0,
    qualityFailed,
    sourceFailed,
    dedupViolations
  };
}

const VALID_METRICS = ['identityTop1', 'variantTop1', 'hit5Var', 'hit10Var', 'mrr10', 'ndcg10', 'recall10Capped', 'trapTop1', 'trapBeforeVar'];

function summarize(scored) {
  const valid = scored.filter((s) => s.kind === 'valid');
  const impossible = scored.filter((s) => s.kind === 'impossible');
  const oos = scored.filter((s) => s.kind === 'oos');
  const mean = (rows, k) => (rows.length ? round(rows.reduce((a, r) => a + r[k], 0) / rows.length) : null);
  const summary = { n: scored.length, validN: valid.length };
  for (const k of VALID_METRICS) summary[k] = mean(valid, k);
  summary.emptyRate = valid.length ? round(valid.filter((r) => r.empty).length / valid.length) : null;
  summary.qualityFailures = valid.filter((r) => r.qualityFailed === true).length;
  summary.sourceFailures = valid.filter((r) => r.sourceFailed === true).length;
  summary.dedupViolations = scored.reduce((a, r) => a + r.dedupViolations, 0);
  summary.impossibleN = impossible.length;
  summary.impossibleFailures = impossible.filter((r) => r.failed).length;
  summary.oosN = oos.length;
  summary.oosStrongFalsePositives = oos.filter((r) => r.strong).length;
  return summary;
}

module.exports = { scoreCase, summarize, resultId, VALID_METRICS };
