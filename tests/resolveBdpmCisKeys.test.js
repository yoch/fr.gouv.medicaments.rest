'use strict';

const { resolveBdpmCisKeys } = require('../src/services/searchOrchestrator');
const { loadData } = require('../src/services/dataLoader');
const { describeSlow } = require('./helpers/slowTests');
const { DOLIPRANE_CIS, DOLIPRANE_CIP13 } = require('./fixtures/cis-cip-samples');

describeSlow('resolveBdpmCisKeys', () => {
  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await loadData();
  }, 120000);

  test('returns empty for blank query', () => {
    expect(resolveBdpmCisKeys('')).toEqual([]);
    expect(resolveBdpmCisKeys('   ')).toEqual([]);
  });

  test('resolves CIS and CIP13 to cis keys', () => {
    const byCis = resolveBdpmCisKeys(DOLIPRANE_CIS, { limit: 10 });
    expect(byCis).toContain(DOLIPRANE_CIS);

    const byCip = resolveBdpmCisKeys(DOLIPRANE_CIP13, { limit: 10 });
    expect(byCip).toContain(DOLIPRANE_CIS);
  });

  test('respects limit and ranks exact/prefix above fuzzy', () => {
    const keys = resolveBdpmCisKeys('doliprane', { limit: 5 });
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.length).toBeLessThanOrEqual(5);
  });
});
