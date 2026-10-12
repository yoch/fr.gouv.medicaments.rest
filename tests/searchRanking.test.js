const { FrozenMiniSearch } = require('@yoch/frozenminisearch');
const {
  miniSearchOptions,
  createMatchPriorityClassifier,
  matchQualityFromPriority,
  isStrongMatchQuality,
  normalizeSearchText,
  queryTerms
} = require('../src/utils/searchRanking');

const computeMatchPriority = (primaryValue, query, options) =>
  createMatchPriorityClassifier(query)(primaryValue, options);

describe('searchRanking', () => {
  describe('queryTerms', () => {
    it('découpe et normalise la requête', () => {
      expect(queryTerms('  SULTRIAN   100 ')).toEqual(['sultrian', '100']);
    });

    it('découpe la ponctuation comme MiniSearch', () => {
      expect(queryTerms('B-12 100/400')).toEqual(['b', '12', '100', '400']);
    });
  });

  describe('createMatchPriorityClassifier', () => {
    it('réutilise la même requête compilée pour plusieurs candidats', () => {
      const classify = createMatchPriorityClassifier('doliprane 500');
      expect(classify('DOLIPRANE 500 mg, gélule')).toBe(1);
      expect(classify('DOLIPRANE 500 mg, gélule')).toBe(1);
      expect(classify('doliprane 500')).toBe(2);
      expect(classify('DOLIPRANE 1000 mg')).toBe(0);
    });

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

    it('exact sur code CIP13 même si le libellé ne matche pas', () => {
      expect(
        computeMatchPriority(
          'plaquette thermoformée',
          '3400935955838',
          { idValue: '60234100', codeValues: ['3400935955838', '3595583'] }
        )
      ).toBe(2);
    });

    it('ne classe pas les codes en prefix', () => {
      expect(
        computeMatchPriority(
          'plaquette thermoformée',
          '340093',
          { idValue: '60234100', codeValues: ['3400935955838', '3595583'] }
        )
      ).toBe(0);
      expect(
        computeMatchPriority('AUTRE NOM', '6023', { idValue: '60234100' })
      ).toBe(0);
    });

    it('ignore accents et casse, y compris en forme décomposée', () => {
      expect(computeMatchPriority('ÉFFERALGAN', 'efferalgan')).toBe(2);
      expect(computeMatchPriority('E\u0301FFERALGAN 500', 'Efferalgan')).toBe(1);
      expect(computeMatchPriority('acide acétylsalicylique', 'ACETYLSALICYLIQUE')).toBe(1);
    });

    it('délimite les mots entiers après repli', () => {
      expect(computeMatchPriority('noir cafe\u0301', 'cafe')).toBe(1);
      expect(computeMatchPriority('noir caféine', 'cafe')).toBe(0);
      expect(computeMatchPriority('cafeine noire', 'cafe')).toBe(1);
    });

    it('retombe sur la normalisation complète quand le repli dépend du contexte', () => {
      expect(computeMatchPriority('ΑΣ', 'ας')).toBe(2);
      expect(computeMatchPriority('한글 sirop', '한글')).toBe(1);
      expect(computeMatchPriority('dose 𝟏 mg', 'dose')).toBe(1);
    });

    it('classe comme la normalisation complète sur des libellés aléatoires', () => {
      const reference = (query) => {
        const normalizedQuery = normalizeSearchText(query);
        const terms = queryTerms(query);
        const matchers = terms.map((term) =>
          new RegExp(`(?:^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`));
        return (primaryValue, { idValue = '', codeValues = [] } = {}) => {
          if (!terms.length) return 0;
          const value = normalizeSearchText(primaryValue);
          const id = normalizeSearchText(idValue);
          if (value === normalizedQuery || id === normalizedQuery) return 2;
          if (codeValues.some((code) => normalizeSearchText(code) === normalizedQuery)) return 2;
          if (value.startsWith(normalizedQuery)) return 1;
          const haystack = value || id;
          if (!haystack || !terms.every((term) => haystack.includes(term))) return 0;
          if (matchers.every((matcher) => matcher.test(haystack))) return 1;
          return haystack.startsWith(terms[0]) ? 1 : 0;
        };
      };
      const alphabet = ['a', 'b', 'e', 'A', 'É', 'é', 'e\u0301', '\u0301', ' ', '-', ',', '1', '0', 'Σ', 'ς', '한', 'œ', 'İ', '\u00a0'];
      let seed = 42;
      const random = (n) => {
        seed = (seed * 48271) % 2147483647;
        return seed % n;
      };
      const randomText = (max) => {
        let text = '';
        for (let length = random(max + 1); length > 0; length--) text += alphabet[random(alphabet.length)];
        return text;
      };
      for (let round = 0; round < 300; round++) {
        const query = randomText(4);
        const expected = reference(query);
        const actual = createMatchPriorityClassifier(query);
        for (let candidate = 0; candidate < 30; candidate++) {
          const value = randomText(8);
          const options = { idValue: randomText(3), codeValues: [randomText(3)] };
          expect([query, value, actual(value, options)]).toEqual([query, value, expected(value, options)]);
        }
      }
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
          { id: 3, denomination: 'EFFERALGAN 1000 mg, comprimé' },
          { id: 4, denomination: 'DOSE 1g' }
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
