jest.mock('../src/services/dataLoader', () => {
  const rows = {
    '10000001': { cis: '10000001', denomination: 'GALIUM APARINE', match_quality: 'fuzzy' },
    '90000001': { cis: '90000001', denomination: 'ASPIRINE', match_quality: 'exact' },
    '90000002': { cis: '90000002', denomination: 'ASPIRINE 1000 mg', match_quality: 'prefix' }
  };
  return {
    searchKeyMatches: type => type === 'specialites' ? Object.values(rows) : [],
    getSpecialiteByCis: cis => rows[cis],
    getSpecialiteLabelByCis: cis => rows[cis].denomination,
    getSpecialiteSearchRecordByCis: cis => rows[cis],
    getRelatedByCis: () => [],
    bdpmExtraitUrl: cis => cis,
    HYDRATE_RELATED_LIMIT: 10
  };
});
jest.mock('../src/services/vetDataLoader', () => {
  const rows = {
    '0000001': { num: '0000001', nom: 'APARINE VET', match_quality: 'fuzzy' },
    '0000002': { num: '0000002', nom: 'ASPIRINE VET', match_quality: 'prefix' }
  };
  return {
    searchVetKeyMatches: type => type === 'medicaments' ? Object.values(rows) : [],
    getMedicamentByNum: num => rows[num],
    getMedicamentLabelByNum: num => rows[num].nom,
    getMedicamentSearchRecordByNum: num => rows[num],
    getRelatedByNum: () => []
  };
});

const { executeHybridSearch, executeHybridSearchPage } = require('../src/services/searchOrchestrator');
const ranks = { exact: 3, prefix: 2, fuzzy: 1 };

test.each(['auto', 'human', 'veterinary', 'mixed'])('classe avant pagination pour source=%s', (source) => {
  for (const criteria of [{}, { dosage: '1000 mg' }]) {
    const full = executeHybridSearch('aspirine', source, criteria).results;
    const qualities = full.map(hit => ranks[hit.match_quality]);
    expect(qualities).toEqual([...qualities].sort((a, b) => b - a));
    const paged = full.map((_, i) => {
      const page = executeHybridSearchPage('aspirine', source, i + 1, 1, criteria);
      expect(page.total).toBe(full.length);
      return page.results[0];
    });
    // Le chemin paginé n'hydrate pas le boost interne, absent des réponses HTTP.
    expect(paged).toEqual(full.map(({ criteria_boost, ...hit }) => hit));
  }
});
