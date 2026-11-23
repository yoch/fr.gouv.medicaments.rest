#!/usr/bin/env node
'use strict';

/**
 * Rejoue la suite curée (vérité connue par construction) sur un checkout propre et figé
 * de fr.gouv.medicaments.rest, pour B0 (legacy), B1 (structured) et B2 (concepts).
 * Notation déterministe, sans LLM ni réseau.
 *
 * Contrôles du correcteur, exécutés à chaque passage :
 *   - ORACLE renvoie les variantes attendues : doit obtenir variantTop1 = 1 ;
 *   - NULL ne renvoie rien : doit obtenir variantTop1 = 0 et aucune réussite sur les cas valides.
 * Chaque identifiant attendu (variante, identité, piège) doit exister dans le corpus chargé.
 *
 *   node run.cjs --repo PATH --expected-sha SHA --data-dir PATH --out results.json
 *        [--suite eval_suite_v3.json] [--split all|dev|heldout]
 *   node run.cjs --compare before.json after.json
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { scoreCase, summarize, resultId } = require('./scoring');

function args(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) throw new Error(`Unexpected argument ${t}`);
    const name = t.slice(2);
    if (name === 'compare') { a.compare = [argv[++i], argv[++i]]; continue; }
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${t}`);
    a[name] = argv[++i];
  }
  return a;
}
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const git = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function compare(beforePath, afterPath) {
  const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(fs.readFileSync(afterPath, 'utf8'));
  if (before.suite_sha256 !== after.suite_sha256) throw new Error('Different suites: not comparable');
  if (before.snapshot_id !== after.snapshot_id) throw new Error('Different corpus snapshots: not comparable');
  const report = { before: before.code_sha, after: after.code_sha, systems: {} };
  for (const system of Object.keys(after.systems)) {
    if (!before.systems[system]) continue;
    const b = new Map(before.systems[system].perCase.map((c) => [c.id, c]));
    const changed = [];
    for (const c of after.systems[system].perCase) {
      const p = b.get(c.id);
      if (!p || JSON.stringify(p.top10) === JSON.stringify(c.top10)) continue;
      const delta = {};
      for (const k of ['variantTop1', 'identityTop1', 'ndcg10', 'trapTop1', 'failed', 'strong']) {
        if (p.score[k] !== c.score[k]) delta[k] = [p.score[k], c.score[k]];
      }
      changed.push({ id: c.id, family: c.family, split: c.split, q: c.q, delta });
    }
    report.systems[system] = {
      summary_before: before.systems[system].summary,
      summary_after: after.systems[system].summary,
      changed_cases: changed
    };
  }
  console.log(JSON.stringify(report, null, 2));
}

async function main() {
  const a = args(process.argv.slice(2));
  if (a.compare) return compare(...a.compare);
  for (const k of ['repo', 'expected-sha', 'data-dir', 'out']) if (!a[k]) throw new Error(`--${k} required`);
  if (!/^[a-f0-9]{40}$/.test(a['expected-sha'])) throw new Error('Use a full exact commit SHA');
  const repo = fs.realpathSync(a.repo);
  const head = git(repo, 'rev-parse', 'HEAD');
  if (head !== a['expected-sha']) throw new Error(`SHA mismatch: ${head} != ${a['expected-sha']}`);
  if (git(repo, 'status', '--porcelain', '--untracked-files=no')) throw new Error('Tracked worktree modifications');
  const out = path.resolve(a.out);
  if (fs.existsSync(out)) throw new Error('Output exists: choose another filename');
  const suitePath = path.resolve(a.suite || path.join(__dirname, 'eval_suite_v3.json'));
  const suiteRaw = fs.readFileSync(suitePath);
  const suite = JSON.parse(suiteRaw);
  const split = a.split || 'all';
  const cases = suite.cases.filter((c) => split === 'all' || c.split === split);
  if (!cases.length) throw new Error('Empty case selection');

  const dataDir = fs.realpathSync(a['data-dir']);
  process.env.DATA_DIR = dataDir;
  process.env.LOAD_HAS_AVIS = 'false';
  global.fetch = async () => { throw new Error('NETWORK_DISABLED'); };
  for (const m of ['node:http', 'node:https']) {
    const mod = require(m);
    mod.request = () => { throw new Error('NETWORK_DISABLED'); };
    mod.get = () => { throw new Error('NETWORK_DISABLED'); };
  }
  const req = createRequire(path.join(repo, 'package.json'));
  const { loadData, getSpecialiteByCis } = req('./src/services/dataLoader');
  const { loadVetData, getMedicamentByNum } = req('./src/services/vetDataLoader');
  const { executeHybridSearchPage } = req('./src/services/searchOrchestrator');
  let executeExperimentalSearchPage = null;
  try { ({ executeExperimentalSearchPage } = req('./src/search/experimentalSearch')); } catch { /* B0-only checkout */ }
  await loadData();
  await loadVetData();

  // Chaque identifiant attendu doit exister dans le corpus chargé
  // Num ANMV : 7 chiffres ; CIS BDPM : 8 chiffres
  const exists = (id) => Boolean(/^\d{7}$/.test(id) ? getMedicamentByNum(id) : getSpecialiteByCis(id));
  const missing = [];
  for (const c of cases) {
    for (const [field, ids] of [['expectedVariantIds', c.expectedVariantIds], ['expectedIdentityIds', c.expectedIdentityIds], ['trapIds', c.trapIds]]) {
      for (const id of ids || []) if (!exists(String(id))) missing.push({ id: c.id, field, missing_id: String(id) });
    }
  }

  const criteria = (c) => ({ dosage: c.dosage || null, forme: c.forme || null, voie: c.voie || null });
  const systems = {
    B0: (c) => executeHybridSearchPage(c.q, c.source || 'auto', 1, 10, criteria(c)),
    ...(executeExperimentalSearchPage ? {
      B1: (c) => executeExperimentalSearchPage(c.q, c.source || 'auto', 1, 10, criteria(c), { mode: 'structured' }),
      B2: (c) => executeExperimentalSearchPage(c.q, c.source || 'auto', 1, 10, criteria(c), { mode: 'concepts' })
    } : {}),
    // Contrôles du correcteur
    ORACLE: (c) => ({
      total: (c.expectedVariantIds || []).length,
      results: (c.expectedVariantIds || []).map((id) => (c.isVet ? { type: 'medicament_veterinaire', num: id } : { type: 'medicament', cis: id }))
        .map((r) => ({ ...r, match_quality: c.expectQualityAt1 || 'exact' })),
      search: { referentiels: { queried: c.expectSourceWithResults || [], with_results: c.expectSourceWithResults || [] } }
    }),
    NULL: () => ({ total: 0, results: [], search: {} })
  };

  const report = {
    schema_version: 'curated-suite-run/1', code_sha: head, suite: path.basename(suitePath), suite_sha256: sha(suiteRaw),
    snapshot_id: 'sha256:' + sha(JSON.stringify(fs.readdirSync(dataDir).sort().map((n) => {
      const p = path.join(dataDir, n);
      return fs.statSync(p).isFile() ? [n, sha(fs.readFileSync(p))] : [n, 'dir'];
    }))),
    split, cases: cases.length, missing_expected_ids: missing, systems: {}
  };
  for (const [name, fn] of Object.entries(systems)) {
    const perCase = [];
    for (const c of cases) {
      const outcome = await fn(c);
      const score = scoreCase(c, outcome);
      perCase.push({ id: c.id, family: c.family, split: c.split, provenance: c.provenance, q: c.q,
        top10: (outcome.results || []).slice(0, 10).map(resultId), score });
    }
    const scored = perCase.map((p) => p.score);
    report.systems[name] = {
      summary: summarize(scored),
      by_split: Object.fromEntries(['dev', 'heldout'].map((s) => [s, summarize(perCase.filter((p) => p.split === s).map((p) => p.score))])),
      by_provenance: Object.fromEntries(['curated', 'corpus_generated'].map((s) => [s, summarize(perCase.filter((p) => p.provenance === s).map((p) => p.score))])),
      perCase
    };
  }

  // Le correcteur doit distinguer l'oracle du système vide, sinon le banc est cassé
  const o = report.systems.ORACLE.summary;
  const n = report.systems.NULL.summary;
  report.harness_checks = {
    oracle_variantTop1: o.variantTop1, null_variantTop1: n.variantTop1, null_hit10: n.hit10Var,
    ok: o.variantTop1 === 1 && n.variantTop1 === 0 && n.hit10Var === 0 && missing.length === 0
  };
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  const brief = Object.fromEntries(Object.entries(report.systems).map(([k, v]) => [k, {
    variantTop1: v.summary.variantTop1, identityTop1: v.summary.identityTop1, ndcg10: v.summary.ndcg10,
    trapTop1: v.summary.trapTop1, impossibleFailures: v.summary.impossibleFailures, oosStrongFalsePositives: v.summary.oosStrongFalsePositives
  }]));
  console.log(JSON.stringify({ code_sha: head, cases: cases.length, missing_expected_ids: missing.length, harness_checks: report.harness_checks, systems: brief }, null, 2));
  if (!report.harness_checks.ok) process.exitCode = 3;
}

main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exitCode = 1; });
