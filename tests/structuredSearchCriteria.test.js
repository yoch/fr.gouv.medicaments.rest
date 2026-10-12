'use strict';

const {
  parseDosageTokens,
  dosageTokensMatch,
  textOverlapScore,
  scoreStructuredCriteria,
  rerankWithStructuredCriteria
} = require('../src/utils/structuredSearchCriteria');

describe('structuredSearchCriteria', () => {
  describe('parseDosageTokens', () => {
    it('ne confond pas les nombres de gélules ou de gouttes avec des grammes', () => {
      expect(parseDosageTokens('10 gélules, 20 gouttes')).toEqual([]);
      expect(parseDosageTokens('25 μg')).toEqual([{ amount: 25, unit: 'ug' }]);
    });
    it('parse 1 gramme en g', () => {
      expect(parseDosageTokens('1 gramme')).toEqual([{ amount: 1, unit: 'g' }]);
    });

    it('parse 40mg et 0,25 mg', () => {
      expect(parseDosageTokens('40mg')).toEqual([{ amount: 40, unit: 'mg' }]);
      expect(parseDosageTokens('0,25 mg')).toEqual([{ amount: 0.25, unit: 'mg' }]);
    });

    it('parse 1000 mg', () => {
      expect(parseDosageTokens('1000 mg')).toEqual([{ amount: 1000, unit: 'mg' }]);
    });

    it('garde le volume d’une concentration sans en faire un dosage indépendant', () => {
      expect(parseDosageTokens('40 mg/5 ml')).toEqual([
        { amount: 40, unit: 'mg', per: { amount: 5, unit: 'ml' } }
      ]);
      expect(parseDosageTokens('40 mg/0 ml')).toEqual([]);
    });
  });

  describe('dosageTokensMatch', () => {
    it.each([
      ['1000 UI', '1000 IU', true], ['0,5 l', '500 ml', true],
      ['5 %', '5 %', true], ['5 mg', '5 ml', false],
      ['0,1 µg', '1 µg', false], ['25 µg', '0,025 mg', true],
      ['40 mg/ml', '40 mg/5 ml', false], ['40 mg/ml', '200 mg/5 ml', true],
      ['1 mg/ml', '1 g/l', true], ['40 mg', '40 mg/ml', false],
      ['5 ml', '40 mg/5 ml', false]
    ])('compare %s à %s sans confondre les unités', (a, b, matches) => {
      expect(dosageTokensMatch(parseDosageTokens(a), parseDosageTokens(b))).toBe(matches);
    });
    it('1 gramme matche 1000 mg', () => {
      expect(
        dosageTokensMatch(parseDosageTokens('1 gramme'), parseDosageTokens('1000 mg'))
      ).toBe(true);
    });
  });

  describe('scoreStructuredCriteria', () => {
    it('garde une priorité transitive à qualité différente, même si deux boosts sont égaux', () => {
      const hits = [
        { denomination: 'A 1000 mg', match_quality: 'fuzzy' },
        { denomination: 'B 1000 mg', match_quality: 'prefix' },
        { denomination: 'C 500 mg', match_quality: 'fuzzy' }
      ];
      for (const order of [hits, [hits[2], hits[0], hits[1]], [...hits].reverse()]) {
        expect(rerankWithStructuredCriteria(order, { dosage: '1000 mg' }).map(x => x.denomination))
          .toEqual(['B 1000 mg', 'A 1000 mg', 'C 500 mg']);
      }
    });
    const hit = {
      denomination: 'DOLIPRANE 1000 mg, comprimé',
      forme_pharma: 'comprimé',
      voies_admin: 'orale'
    };

    it('boost dosage + forme sans filtrer', () => {
      const { boost, criteria_match } = scoreStructuredCriteria(hit, {
        dosage: '1 gramme',
        forme: 'comprimé'
      });
      expect(boost).toBeGreaterThan(0);
      expect(criteria_match.dosage).toBe(true);
      expect(criteria_match.forme).toBe(true);
    });

    it('évalue le dosage sur la dénomination, pas sur la composition', () => {
      const sansDosageEnNom = {
        denomination: 'MÉDICAMENT SANS DOSAGE',
        compositions: [{ denomination_substance: 'PARACETAMOL', dosage: '1000 mg' }]
      };
      const { criteria_match } = scoreStructuredCriteria(sansDosageEnNom, {
        dosage: '1 gramme'
      });
      expect(criteria_match.dosage).toBe(false);
    });

    it('score aussi les médicaments vétérinaires via nom et forme_pharmaceutique', () => {
      const vetHit = {
        nom: 'VETMED 100 mg',
        forme_pharmaceutique: 'Comprimé'
      };
      const { criteria_match } = scoreStructuredCriteria(vetHit, {
        dosage: '100 mg',
        forme: 'comprimé'
      });
      expect(criteria_match.dosage).toBe(true);
      expect(criteria_match.forme).toBe(true);
    });

    it('réordonne à l’intérieur d’un même niveau de match_quality', () => {
      const autre = {
        denomination: 'AUTRE 500 mg, comprimé',
        forme_pharma: 'comprimé',
        voies_admin: 'orale',
        match_quality: 'prefix'
      };
      const doliprane = { ...hit, match_quality: 'prefix' };
      const ranked = rerankWithStructuredCriteria([autre, doliprane], {
        dosage: '1 gramme',
        forme: 'comprimé'
      });
      expect(ranked[0].denomination).toContain('DOLIPRANE');
      expect(ranked[0].criteria_boost).toBeGreaterThan(ranked[1].criteria_boost);
    });

    it('ne remonte jamais un match faible au-dessus d’un match fort (anti-bruit)', () => {
      const exactSansCritere = {
        denomination: 'AUTRE 500 mg',
        forme_pharma: 'gélule',
        voies_admin: 'orale',
        match_quality: 'exact'
      };
      const prefixAvecCritere = { ...hit, match_quality: 'prefix' };
      const ranked = rerankWithStructuredCriteria(
        [prefixAvecCritere, exactSansCritere],
        { dosage: '1 gramme', forme: 'comprimé' }
      );
      expect(ranked[0].match_quality).toBe('exact');
      expect(ranked[0].denomination).toContain('AUTRE');
      expect(ranked).toHaveLength(2);
    });
  });

  describe('textOverlapScore', () => {
    it('matche orodispersible dans forme longue', () => {
      expect(
        textOverlapScore('comprimé orodispersible', 'comprimé orodispersible sécable')
      ).toBeGreaterThanOrEqual(0.5);
    });
  });
});
