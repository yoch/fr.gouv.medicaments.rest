const { FrozenMiniSearch } = require('@yoch/frozenminisearch');
const { miniSearchIndexConfig } = require('../src/utils/miniSearchIndexConfig');

test('les poids configurés favorisent réellement la dénomination dans les scores', () => {
  const fields = ['denomination', 'titulaire'];
  const docs = [
    { id: 0, denomination: 'autre', titulaire: 'alpha' },
    { id: 1, denomination: 'alpha', titulaire: 'autre' }
  ];
  const boosted = FrozenMiniSearch.fromDocuments(docs, miniSearchIndexConfig(fields, { denomination: 3, titulaire: 1 }));
  const plain = FrozenMiniSearch.fromDocuments(docs, miniSearchIndexConfig(fields));
  const hits = boosted.search('alpha');
  expect(hits[0].id).toBe(1);
  expect(hits[0].score).toBeCloseTo(hits[1].score * 3);
  expect(plain.search('alpha')[0].score).toBeCloseTo(plain.search('alpha')[1].score);
});
