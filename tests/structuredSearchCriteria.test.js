'use strict';

const {
  parseDosageTokens,
  matchDosageTokens,
  textOverlapScore,
  scoreStructuredCriteria,
  rerankWithStructuredCriteria
} = require('../src/utils/structuredSearchCriteria');

describe('structuredSearchCriteria', () => {
  describe('parseDosageTokens', () => {
    it.each([
      ['1 gramme', [{ amount: 1000, unit: 'mg' }]],
      ['40mg', [{ amount: 40, unit: 'mg' }]],
      ['0,25 mg', [{ amount: 0.25, unit: 'mg' }]],
      ['25 μg', [{ amount: 0.025, unit: 'mg' }]],
      ['100 microgrammes/dose', [{ amount: 0.1, unit: 'mg' }]],
      ['10 gélules, 20 gouttes', []],
      ['250 mg/5 ml', [{ amount: 250, unit: 'mg' }, { amount: 5, unit: 'ml' }]],
      ['40 mg/ml', [{ amount: 40, unit: 'mg/ml' }]],
      ['20 mg/1 ml', [{ amount: 20, unit: 'mg' }, { amount: 1, unit: 'ml' }]],
      ['10 mg/10 ml', [{ amount: 10, unit: 'mg' }, { amount: 10, unit: 'ml' }]],
      ['9 g/l', [{ amount: 9, unit: 'mg/ml' }]],
      ['100 unités/mL', [{ amount: 100, unit: 'ui/ml' }]],
      ['UVEDOSE 100 000 UI', [{ amount: 100000, unit: 'ui' }]],
      ['A 313 50 000 U.I., capsule molle', [{ amount: 50000, unit: 'ui' }]],
      ['5 POUR CENT, crème', [{ amount: 5, unit: '%' }]],
      ['500 mg/62,5 mg', [{ amount: 500, unit: 'mg' }, { amount: 62.5, unit: 'mg' }]]
    ])('lit %s', (text, tokens) => {
      expect(parseDosageTokens(text)).toEqual(tokens);
    });

    it('ne colle pas un chiffre du nom au dosage', () => {
      expect(parseDosageTokens('CACIT VITAMINE D3 500 mg/1000 U.I.')).toEqual([
        { amount: 500, unit: 'mg' }, { amount: 1000, unit: 'ui' }
      ]);
      expect(parseDosageTokens('MAG 2 100 mg')).toEqual([{ amount: 100, unit: 'mg' }]);
    });
  });

  describe('matchDosageTokens', () => {
    it.each([
      ['1 gramme', '1000 mg', 1, 0],
      ['1000 UI', '1000 IU', 1, 0],
      ['0,5 l', '500 ml', 1, 0],
      ['25 µg', '0,025 mg', 1, 0],
      ['0,1 µg', '1 µg', 0, 1],
      ['5 mg', '5 ml', 0, 1],
      ['5 %', '5 POUR CENT', 1, 0],
      ['50 000 UI', '100 000 UI', 0, 1],
      ['250 mg', '250 mg/5 ml', 1, 1],
      ['250 mg/5 ml', '250 mg/5 ml', 2, 0],
      ['40 mg/ml', '40 mg/5 ml', 0, 2],
      ['20 mg', '20 mg/1 ml', 1, 1],
      ['40 mg', '40 mg/ml', 0, 1],
      ['1 mg/ml', '1 g/l', 1, 0],
      ['500 mg/62,5 mg', '500 mg', 1, 0],
      ['500 mg/500 mg', '500 mg', 1, 0]
    ])('%s dans %s : %i retrouvée(s), %i en trop', (requested, candidate, matched, extra) => {
      expect(matchDosageTokens(parseDosageTokens(requested), parseDosageTokens(candidate)))
        .toEqual({ matched, extra });
    });
  });

  describe('scoreStructuredCriteria', () => {
    it('boost proportionnel ; criteria_match.dosage seulement si tout est retrouvé', () => {
      const partial = scoreStructuredCriteria({ denomination: 'AMOX 250 mg, gélule' }, { dosage: '250 mg/5 ml' });
      expect(partial).toMatchObject({ boost: 1, criteria_match: { dosage: false }, dosage_extra: 0 });
      const full = scoreStructuredCriteria({ denomination: 'AMOX 250 mg/5 ml, suspension' }, { dosage: '250 mg/5 ml' });
      expect(full).toMatchObject({ boost: 2, criteria_match: { dosage: true }, dosage_extra: 0 });
      const none = scoreStructuredCriteria({ denomination: 'AMOX 500 mg' }, { dosage: '250 mg' });
      expect(none).toMatchObject({ boost: 0, dosage_extra: null });
    });

    it('à boost égal, préfère le candidat sans quantité non demandée', () => {
      const hits = [
        { denomination: 'IMETH 10 mg/0,4 ml, seringue', match_quality: 'exact' },
        { denomination: 'IMETH 10 mg, comprimé', match_quality: 'exact' },
        { denomination: 'IMETH 2,5 mg, comprimé', match_quality: 'exact' }
      ];
      const ranked = rerankWithStructuredCriteria(hits, { dosage: '10 mg' });
      expect(ranked.map(x => x.denomination)).toEqual([
        'IMETH 10 mg, comprimé', 'IMETH 10 mg/0,4 ml, seringue', 'IMETH 2,5 mg, comprimé'
      ]);
      expect(ranked[0]).not.toHaveProperty('_dosageExtra');
    });

    it('une concentration écrite avec son volume passe devant une quantité simple', () => {
      const hits = [
        { denomination: 'AMOX 250 mg, gélule', match_quality: 'exact' },
        { denomination: 'AMOX 250 mg/5 ml, suspension', match_quality: 'exact' }
      ];
      expect(rerankWithStructuredCriteria(hits, { dosage: '250 mg/5 ml' })[0].denomination)
        .toContain('suspension');
    });

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
