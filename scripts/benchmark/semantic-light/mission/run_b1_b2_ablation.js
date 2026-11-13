'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const request = require('supertest');

const { loadData } = require('../../../../src/services/dataLoader');
const { loadVetData } = require('../../../../src/services/vetDataLoader');
const { executeHybridSearchPage } = require('../../../../src/services/searchOrchestrator');
const { buildConceptStore, resetConceptStoreCache } = require('../../../../src/search/conceptStore');
const { executeExperimentalSearchPage } = require('../../../../src/search/experimentalSearch');
const { parseStructuredQuery } = require('../../../../src/search/structuredQueryParser');
const medicamentRoutes = require('../../../../src/routes/medicaments');
const { evaluateSystem } = require('./eval_harness');

function memMb() {
  const m = process.memoryUsage();
  return {
    rssMb: Math.round((m.rss / 1048576) * 10) / 10,
    heapUsedMb: Math.round((m.heapUsed / 1048576) * 10) / 10,
    externalMb: Math.round((m.external / 1048576) * 10) / 10
  };
}

function summarize(res) {
  return {
    summary: res.summary,
    byFamily: res.byFamily
  };
}

async function main() {
  const memBeforeLoad = memMb();
  await loadData();
  await loadVetData();
  const memAfterLoad = memMb();

  resetConceptStoreCache();
  const t0 = process.hrtime.bigint();
  const store = require('../../../../src/search/conceptStore').getConceptStore();
  const conceptBuildMs = Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 100) / 100;
  const memAfterConcept = memMb();

  const evalSuite = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'eval_suite_v3.json'), 'utf8')
  );

  const app = express();
  app.use(express.json());
  app.use('/api/medicaments', medicamentRoutes);

  const systems = {
    B0_baseline: {
      fn: (tc, page = 1, limit = 10) => executeHybridSearchPage(tc.q, tc.source || 'auto', page, limit, {}),
      http: (tc) => request(app).get(`/api/medicaments/search?q=${encodeURIComponent(tc.q)}&source=${encodeURIComponent(tc.source || 'auto')}&limit=10`)
    },
    B1_structured: {
      fn: (tc, page = 1, limit = 10) => executeExperimentalSearchPage(tc.q, tc.source || 'auto', page, limit, {}, { mode: 'structured' }),
      http: (tc) => request(app).get(`/api/medicaments/search?q=${encodeURIComponent(tc.q)}&source=${encodeURIComponent(tc.source || 'auto')}&limit=10&mode=structured`)
    },
    B2_concepts: {
      fn: (tc, page = 1, limit = 10) => executeExperimentalSearchPage(tc.q, tc.source || 'auto', page, limit, {}, { mode: 'concepts' }),
      http: (tc) => request(app).get(`/api/medicaments/search?q=${encodeURIComponent(tc.q)}&source=${encodeURIComponent(tc.source || 'auto')}&limit=10&mode=concepts`)
    }
  };

  // Warmup JIT
  for (const sys of Object.values(systems)) {
    for (let i = 0; i < 5; i++) sys.fn(evalSuite.cases[0], 1, 10);
  }

  // IMPORTANT : itération uniquement sur le split DEV (jamais heldout avant gel final)
  const devResults = {};
  for (const [name, sys] of Object.entries(systems)) {
    const devAll = await evaluateSystem(name, evalSuite, sys.fn, {
      split: 'dev',
      measureHttp: true,
      httpRouteFn: sys.http
    });
    const devCurated = await evaluateSystem(name, evalSuite, sys.fn, { split: 'dev', provenance: 'curated' });
    const devGen = await evaluateSystem(name, evalSuite, sys.fn, { split: 'dev', provenance: 'corpus_generated' });
    devResults[name] = {
      all: devAll,
      curated: devCurated.summary,
      corpus_generated: devGen.summary
    };
  }

  // Pagination & dedup checks across B0/B1/B2
  const pagChecks = [];
  for (const q of ['paracetamol', 'amoxicilline', 'doliprane']) {
    for (const modeName of ['B1_structured', 'B2_concepts']) {
      const fn = systems[modeName].fn;
      const full = fn({ q, source: 'auto' }, 1, 50);
      const p1 = fn({ q, source: 'auto' }, 1, 5);
      const p2 = fn({ q, source: 'auto' }, 2, 5);
      const combinedIds = [...p1.results, ...p2.results].map((r) => r.cis || r.num);
      const fullIds = full.results.slice(0, 10).map((r) => r.cis || r.num);
      pagChecks.push({
        mode: modeName,
        q,
        total: full.total,
        dedupUnique: new Set(combinedIds).size === combinedIds.length,
        pageMatchesFullSlice: JSON.stringify(combinedIds) === JSON.stringify(fullIds)
      });
    }
  }

  const telemetry = {
    memory: {
      beforeLoad: memBeforeLoad,
      afterLoad: memAfterLoad,
      afterConceptStore: memAfterConcept,
      conceptBuildMs
    },
    conceptStats: store.stats,
    pagChecks
  };

  console.log('=== TELEMETRY ===');
  console.log(JSON.stringify(telemetry, null, 2));

  console.log('\n=== DEV ABLATION COMPARISON (B0 -> B1 -> B2) ===');
  for (const [name, res] of Object.entries(devResults)) {
    console.log(`\n--- ${name} ---`);
    console.log(JSON.stringify({
      summary: res.all.summary,
      curated: res.curated,
      corpus_generated: res.corpus_generated,
      byFamily: res.all.byFamily
    }, null, 2));
  }

  console.log('\n=== B2 DEV RESIDUAL FAILURES (diagnostic uniquement sur dev) ===');
  const b2Cases = devResults.B2_concepts.all.perCase;
  const devCaseMap = new Map(evalSuite.cases.filter((c) => c.split === 'dev').map((c) => [c.id, c]));
  for (const row of b2Cases) {
    if ((row.kind === 'valid' && row.var1 === 0) || row.badCriteria || row.fakeStrong || row.strong || row.trapTop1) {
      const tc = devCaseMap.get(row.id);
      const parsed = parseStructuredQuery(tc.q, {}, store.taxonomy, { useAliases: true });
      console.log(JSON.stringify({
        ...row,
        parsedName: parsed.nameQuery,
        parsedDosage: parsed.effectiveCriteria.dosage,
        parsedForme: parsed.effectiveCriteria.forme,
        parsedVoie: parsed.effectiveCriteria.voie,
        parsedSpecies: parsed.extracted.species,
        notes: tc.notes
      }));
    }
  }

  fs.writeFileSync(
    path.join(__dirname, 'b1_b2_dev_results.json'),
    `${JSON.stringify({
      telemetry,
      summaryComparison: Object.fromEntries(
        Object.entries(devResults).map(([k, v]) => [k, {
          ...summarize(v.all),
          curated: v.curated,
          corpus_generated: v.corpus_generated
        }])
      ),
      b2PerCaseDev: devResults.B2_concepts.all.perCase
    }, null, 2)}\n`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
