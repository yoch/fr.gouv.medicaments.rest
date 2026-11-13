'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const request = require('supertest');

const { loadData } = require('../../../../src/services/dataLoader');
const { loadVetData } = require('../../../../src/services/vetDataLoader');
const { executeHybridSearchPage } = require('../../../../src/services/searchOrchestrator');
const medicamentRoutes = require('../../../../src/routes/medicaments');
const { evaluateSystem } = require('./eval_harness');

async function main() {
  await loadData();
  await loadVetData();

  const evalSuite = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'eval_suite_v3.json'), 'utf8')
  );

  const app = express();
  app.use(express.json());
  app.use('/api/medicaments', medicamentRoutes);

  const b0SearchFn = (tc, page = 1, limit = 10) =>
    executeHybridSearchPage(tc.q, tc.source || 'auto', page, limit, {});

  const b0HttpFn = (tc) =>
    request(app).get(
      `/api/medicaments/search?q=${encodeURIComponent(tc.q)}&source=${encodeURIComponent(tc.source || 'auto')}&limit=10`
    );

  // Warm up JIT / cache
  for (let i = 0; i < 5; i++) b0SearchFn(evalSuite.cases[0], 1, 10);

  const resDevAll = await evaluateSystem('B0_baseline', evalSuite, b0SearchFn, {
    split: 'dev',
    measureHttp: true,
    httpRouteFn: b0HttpFn
  });
  const resDevCurated = await evaluateSystem('B0_baseline', evalSuite, b0SearchFn, {
    split: 'dev',
    provenance: 'curated'
  });
  const resDevGen = await evaluateSystem('B0_baseline', evalSuite, b0SearchFn, {
    split: 'dev',
    provenance: 'corpus_generated'
  });
  const resHeldout = await evaluateSystem('B0_baseline', evalSuite, b0SearchFn, {
    split: 'heldout',
    measureHttp: true,
    httpRouteFn: b0HttpFn
  });

  // Explicit CIS dedup + pagination stability check across multi-presentation drugs
  const pagChecks = [];
  for (const q of ['paracetamol', 'amoxicilline', 'doliprane']) {
    const full = b0SearchFn({ q, source: 'auto' }, 1, 50);
    const p1 = b0SearchFn({ q, source: 'auto' }, 1, 5);
    const p2 = b0SearchFn({ q, source: 'auto' }, 2, 5);
    const combinedIds = [...p1.results, ...p2.results].map((r) => r.cis || r.num);
    const fullIds = full.results.slice(0, 10).map((r) => r.cis || r.num);
    pagChecks.push({
      q,
      total: full.total,
      dedupUnique: new Set(combinedIds).size === combinedIds.length,
      pageMatchesFullSlice: JSON.stringify(combinedIds) === JSON.stringify(fullIds)
    });
  }

  console.log('=== B0 DEV SUMMARY ===');
  console.log(JSON.stringify({ summary: resDevAll.summary, byFamily: resDevAll.byFamily }, null, 2));
  console.log('=== B0 DEV CURATED vs CORPUS_GENERATED ===');
  console.log(JSON.stringify({ curated: resDevCurated.summary, corpus_generated: resDevGen.summary }, null, 2));
  console.log('=== B0 HELDOUT SUMMARY (frozen reference only) ===');
  console.log(JSON.stringify({ summary: resHeldout.summary, byFamily: resHeldout.byFamily }, null, 2));
  console.log('=== B0 PAGINATION & DEDUP ===');
  console.log(JSON.stringify(pagChecks, null, 2));

  console.log('=== B0 DEV FAILURES (var1 === 0 or impossible/oos issue) ===');
  for (const row of resDevAll.perCase) {
    if ((row.kind === 'valid' && row.var1 === 0) || row.badCriteria || row.fakeStrong || row.strong) {
      console.log(JSON.stringify(row));
    }
  }

  fs.writeFileSync(
    path.join(__dirname, 'b0_results.json'),
    `${JSON.stringify({ dev: resDevAll, heldoutSummary: resHeldout.summary, heldoutByFamily: resHeldout.byFamily, pagChecks }, null, 2)}\n`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
