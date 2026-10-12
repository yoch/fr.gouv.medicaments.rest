#!/usr/bin/env node
'use strict';

// Audit local des corpus déjà téléchargés, sans accès à la production.
const assert = require('node:assert/strict');
const { loadData } = require('../../src/services/dataLoader');
const { loadVetData } = require('../../src/services/vetDataLoader');
const { executeHybridSearch, executeHybridSearchPage } = require('../../src/services/searchOrchestrator');
const { MATCH_QUALITY_RANK: ranks } = require('../../src/utils/searchRanking');

async function main() {
  await loadData();
  await loadVetData();
  let cases = 0;
  const queries = [
    'aspirine', 'doliprane', 'amoxicilline', 'méthotrexate', 'sultrian',
    '60234100', '3400935955838', 'a', 'zzzzinexistant', ''
  ];
  for (const query of queries) {
    for (const source of ['auto', 'human', 'veterinary', 'mixed']) {
      for (const criteria of [{}, { dosage: '500 mg', forme: 'comprimé' }]) {
        const full = executeHybridSearch(query, source, criteria).results;
        for (let i = 1; i < full.length; i++) {
          assert.ok(ranks[full[i - 1].match_quality] >= ranks[full[i].match_quality], `${query}/${source}: inversion de qualité`);
        }
        // Le boost est interne au tri ; le chemin paginé ne l'hydrate pas.
        const expected = full.map(({ criteria_boost, ...hit }) => hit);
        for (const page of [1, 2]) {
          const paged = executeHybridSearchPage(query, source, page, 7, criteria);
          assert.equal(paged.total, full.length);
          assert.deepEqual(paged.results, expected.slice((page - 1) * 7, page * 7));
        }
        if (source === 'human' && Object.keys(criteria).length === 0 && ['aspirine', 'doliprane', 'amoxicilline'].includes(query)) {
          console.log(JSON.stringify({ query, total: full.length, first: full.slice(0, 3).map(hit => ({ name: hit.denomination, quality: hit.match_quality })) }));
        }
        cases++;
      }
    }
  }
  console.log(JSON.stringify({ status: 'passed', cases, queries: queries.length, pagesPerCase: 2 }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
