const { FrozenMiniSearch } = require('@yoch/minisearch');
const {
  miniSearchOptions,
  computeMatchPriority,
  matchQualityFromPriority,
  isStrongMatchQuality,
  queryTerms
} = require('../src/utils/searchRanking');

describe('searchRanking', () => {
  describe('queryTerms', () => {
    it('découpe et normalise la requête', () => {
      expect(queryTerms('  SULTRIAN   100 ')).toEqual(['sultrian', '100']);
    });

    it('découpe la ponctuation comme MiniSearch', () => {
      expect(queryTerms('B-12 100/400')).toEqual(['b', '12', '100', '400']);
    });
  });

  describe('computeMatchPriority', () => {
    it('exact si libellé égal à la requête multi-termes', () => {
      expect(
        computeMatchPriority('SULTRIAN 100', 'SULTRIAN 100')
      ).toBe(2);
      expect(matchQualityFromPriority(2)).toBe('exact');
    });

    it('prefix si tous les termes sont des mots entiers mais libellé plus long', () => {
      expect(
        computeMatchPriority('DOLIPRANE 500 mg, gélule', 'doliprane')
      ).toBe(1);
    });

    it('fuzzy si terme absent du libellé', () => {
      expect(
        computeMatchPriority('DOLIPRANE 500 mg', 'dolipranr')
      ).toBe(0);
    });

    it('exact sur identifiant CIS', () => {
      expect(
        computeMatchPriority('AUTRE NOM', '60234100', { idValue: '60234100' })
      ).toBe(2);
    });
  });

  describe('isStrongMatchQuality', () => {
    it('distingue fuzzy des matches exploitables pour le fallback auto', () => {
      expect(isStrongMatchQuality('exact')).toBe(true);
      expect(isStrongMatchQuality('prefix')).toBe(true);
      expect(isStrongMatchQuality('fuzzy')).toBe(false);
    });
  });

  describe('miniSearchOptions (régression SULTRIAN 100)', () => {
    let index;

    beforeAll(() => {
      index = FrozenMiniSearch.fromDocuments(
        [
          { id: 0, denomination: 'SULTRIAN 100' },
          { id: 1, denomination: 'FENOFIBRATE TEVA 100 mg, gélule' },
          { id: 2, denomination: 'DOLIPRANE 1000 mg, comprimé' },
          { id: 3, denomination: 'EFFERALGAN 1000 mg, comprimé' }
        ],
        {
          fields: ['denomination'],
          storeFields: ['id', 'denomination'],
          ...miniSearchOptions
        }
      );
    });

    it('AND : SULTRIAN 100 ne matche que le libellé exact', () => {
      const ids = index.search('SULTRIAN 100').map((r) => r.id);
      expect(ids).toEqual([0]);
    });

    it('AND : requête 100 seule ne ramène pas 1000 mg', () => {
      const ids = index.search('100').map((r) => r.id);
      expect(ids).toEqual([0, 1]);
      expect(ids).not.toContain(2);
      expect(ids).not.toContain(3);
    });

    it('OR implicite évité : SULTRIAN 100 ≠ recherche 100 seule', () => {
      const multi = index.search('SULTRIAN 100').length;
      const solo = index.search('100').length;
      expect(multi).toBe(1);
      expect(solo).toBeGreaterThan(multi);
    });
  });
});
