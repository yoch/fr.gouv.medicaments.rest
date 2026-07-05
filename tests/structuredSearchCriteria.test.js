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
  });

  describe('dosageTokensMatch', () => {
    it('1 gramme matche 1000 mg', () => {
      expect(
        dosageTokensMatch(parseDosageTokens('1 gramme'), parseDosageTokens('1000 mg'))
      ).toBe(true);
    });
  });

  describe('scoreStructuredCriteria', () => {
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
