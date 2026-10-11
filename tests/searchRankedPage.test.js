'use strict';

const { FrozenMiniSearch } = require('@yoch/frozenminisearch');
const { miniSearchOptions } = require('../src/utils/searchRanking');
const { rankSearchResults, searchRankedPage } = require('../src/utils/corpusSearch');
const { parseListPaging } = require('../src/utils/corpusPaging');

const rows = Array.from({ length: 1400 }, (_, id) => ({
  id,
  cis: String(60000000 + id % 30),
  cip13: String(3400000000000 + id),
  denomination: id % 11 === 0 ? 'ALPHA' : id % 3 === 0 ? 'ALPHE' : `ALPHA ${id % 7} mg, comprimé`,
  titulaire: id % 3 === 0 ? 'alpha' : 'laboratoire',
}));
const spec = { primaryField: 'denomination', idField: 'cis', codeFields: ['cis', 'cip13'] };
const index = FrozenMiniSearch.fromDocuments(rows, {
  fields: ['cis', 'cip13', 'denomination', 'titulaire'],
  ...miniSearchOptions,
});

describe('searchRankedPage', () => {
  test.each(['alpha', 'alphe', 'alpha 1', '60000000', '3400000000001', 'introuvable', 'comprime'])
  ('preserves full quality/score ranking and exact totals for %s', (query) => {
    const full = rankSearchResults(rows, index.search(query), query, spec);
    for (const [page, limit] of [[1, 1], [1, 10], [2, 20], [4, 50], [1, 350], [400, 5], [-2, 999999]]) {
      const { offset, safeLimit } = parseListPaging(page, limit);
      const actual = searchRankedPage(rows, index, query, spec, page, limit);
      expect(actual.total).toBe(full.length);
      expect(actual.ranked).toEqual(full.slice(offset, offset + safeLimit));
    }
  });

  test('bounds repeated-page engine selection within its quality tier', () => {
    const search = jest.spyOn(index, 'search');
    try {
      const full = rankSearchResults(rows, index.search('alpha'), 'alpha', spec);
      searchRankedPage(rows, index, 'alpha', spec, 1, 1);
      search.mockClear();
      const result = searchRankedPage(rows, index, 'alpha', spec, 2, 10);
      expect(result.ranked).toEqual(full.slice(10, 20));
      expect(search).toHaveBeenCalledTimes(1);
      expect(search.mock.calls[0][1].limit).toBe(20);
    } finally {
      search.mockRestore();
    }
  });

  test('keeps full ranking for a page spanning quality tiers', () => {
    const full = rankSearchResults(rows, index.search('alpha'), 'alpha', spec);
    const exact = full.filter(hit => hit.priority === 2).length;
    searchRankedPage(rows, index, 'alpha', spec, 1, 1);
    const search = jest.spyOn(index, 'search');
    try {
      const actual = searchRankedPage(rows, index, 'alpha', spec, 1, exact + 2);
      expect(actual.ranked).toEqual(full.slice(0, exact + 2));
      expect(search).toHaveBeenCalledWith('alpha');
    } finally {
      search.mockRestore();
    }
  });

  test.each([1, 0])('selects priority %i with an offset relative to its tier', (priority) => {
    const full = rankSearchResults(rows, index.search('alpha'), 'alpha', spec);
    const offset = full.findIndex(hit => hit.priority === priority);
    expect(offset).toBeGreaterThan(0);
    searchRankedPage(rows, index, 'alpha', spec, 1, 1);
    const search = jest.spyOn(index, 'search');
    try {
      const actual = searchRankedPage(rows, index, 'alpha', spec, offset + 1, 1);
      expect(actual.ranked).toEqual(full.slice(offset, offset + 1));
      expect(search.mock.calls[0][1].limit).toBe(1);
      const filter = search.mock.calls[0][1].filter;
      expect(filter({ id: full[offset].rowIndex })).toBe(true);
      expect(filter({ id: full[0].rowIndex })).toBe(false);
    } finally {
      search.mockRestore();
    }
  });

  test('returns exact totals for an exhausted cached query without scoring again', () => {
    const first = searchRankedPage(rows, index, 'alpha', spec, 1, 10);
    const search = jest.spyOn(index, 'search');
    try {
      expect(searchRankedPage(rows, index, 'alpha', spec, first.total + 1, 1))
        .toEqual({ total: first.total, ranked: [] });
      expect(search).not.toHaveBeenCalled();
    } finally {
      search.mockRestore();
    }
  });

  test('does not truncate a higher-quality hit below the raw BM25 top-k', () => {
    const smallRows = [
      { id: 0, denomination: 'ALPHA', titulaire: 'laboratoire' },
      { id: 1, denomination: 'ALPHA comprimé', titulaire: 'laboratoire' },
      { id: 2, denomination: 'AUTRE NOM', titulaire: 'alpha' },
    ];
    const small = FrozenMiniSearch.fromDocuments(smallRows, {
      fields: ['denomination', 'titulaire'],
      ...miniSearchOptions,
    });
    expect(small.search('alpha', { limit: 1 })[0].id).toBe(2);
    searchRankedPage(smallRows, small, 'alpha', spec, 1, 1);
    const result = searchRankedPage(smallRows, small, 'alpha', spec, 1, 1);
    expect(result.ranked[0].rowIndex).toBe(0);
    expect(result.total).toBe(3);
  });

  test('does not rerun a query whose complete result set fits within the requested prefix', () => {
    const search = jest.spyOn(index, 'search');
    try {
      const result = searchRankedPage(rows, index, 'alpha', spec, 2, 1000);
      expect(result.total).toBeGreaterThan(0);
      expect(search).toHaveBeenCalledTimes(1);
    } finally {
      search.mockRestore();
    }
  });

  test('keeps the first request in one scoring pass even for a short page', () => {
    const search = jest.spyOn(index, 'search');
    try {
      const result = searchRankedPage(rows, index, '60000000', spec, 1, 1);
      expect(result.total).toBeGreaterThan(1);
      expect(result.ranked).toHaveLength(1);
      expect(search).toHaveBeenCalledTimes(1);
    } finally {
      search.mockRestore();
    }
  });

  test('replaces the cache after a different query and rebuilds it for a new index', () => {
    searchRankedPage(rows, index, 'alpha', spec, 1, 1);
    searchRankedPage(rows, index, 'alphe', spec, 1, 1);
    const search = jest.spyOn(index, 'search');
    try {
      searchRankedPage(rows, index, 'alpha', spec, 1, 1);
      expect(search).toHaveBeenCalledWith('alpha');
    } finally {
      search.mockRestore();
    }
    const replacement = FrozenMiniSearch.fromDocuments(rows.slice(0, 4), {
      fields: ['cis', 'cip13', 'denomination', 'titulaire'], ...miniSearchOptions,
    });
    const expected = rankSearchResults(rows, replacement.search('alpha'), 'alpha', spec);
    const actual = searchRankedPage(rows, replacement, 'alpha', spec, 1, 1);
    expect(actual.total).toBe(expected.length);
    expect(actual.ranked).toEqual(expected.slice(0, 1));
  });

  test.each([[undefined, index, 'alpha'], [rows, undefined, 'alpha'], [rows, index, '']])
  ('returns an empty page when the corpus, index or query is absent', (corpus, engine, query) => {
    expect(searchRankedPage(corpus, engine, query, spec, 1, 10)).toEqual({ total: 0, ranked: [] });
  });
});
