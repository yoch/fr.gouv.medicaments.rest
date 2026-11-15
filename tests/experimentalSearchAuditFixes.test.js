'use strict';

/**
 * Régressions issues de l'audit de la PR #8 (modes opt-in structured / concepts).
 * Chaque bloc reproduit un défaut constaté sur le pipeline expérimental.
 */

const bdpmState = require('../src/services/bdpm/state');
const vetState = require('../src/services/vet/state');
const { executeHybridSearchPage } = require('../src/services/searchOrchestrator');
const {
  executeExperimentalSearchPage,
  matchFormeCriterion
} = require('../src/search/experimentalSearch');
const { parseStructuredQuery } = require('../src/search/structuredQueryParser');
const { analyzeQuerySafetyAndIntent, inspectCriterionConstraint } = require('../src/search/queryIntentGuard');
const conceptStore = require('../src/search/conceptStore');
const { BDPM_INDEX_SPECS, VET_INDEX_SPECS } = require('../src/search/indexSpecs');
const { miniSearchIndexConfig } = require('../src/utils/miniSearchIndexConfig');
const { buildFrozenIndexFromRows } = require('../src/utils/frozenMiniSearch');
const { clearCorpus, buildKeyIndex, buildIndexDocument } = require('../src/utils/corpusStore');

function makeRow(obj) {
  return Object.assign(Object.create({
    toJSON() {
      return { ...this };
    }
  }), obj);
}

function spec(cis, denomination, forme, voie = 'orale') {
  return makeRow({ cis, denomination, forme_pharma: forme, voies_admin: voie, commercialisation: 'Commercialisée', titulaire: 'LAB' });
}

function indexBdpm() {
  for (const type of ['specialites', 'presentations', 'compositions', 'generiques', 'mitm']) {
    const s = BDPM_INDEX_SPECS[type];
    bdpmState.searchIndexes[type] = buildFrozenIndexFromRows(
      bdpmState.corpus[type],
      (row, i) => buildIndexDocument(row, i, s.fields),
      miniSearchIndexConfig(s.fields, s.boost)
    );
  }
  bdpmState.cisIndexes = {
    specialitesByCis: buildKeyIndex(bdpmState.corpus.specialites, 'cis', { unique: true }),
    presentationsByCis: buildKeyIndex(bdpmState.corpus.presentations, 'cis'),
    compositionsByCis: buildKeyIndex(bdpmState.corpus.compositions, 'cis'),
    avisSmrByCis: new Map(),
    avisAsmrByCis: new Map(),
    conditionsByCis: new Map(),
    generiquesByCis: buildKeyIndex(bdpmState.corpus.generiques, 'cis'),
    generiquesByGroupe: buildKeyIndex(bdpmState.corpus.generiques, 'id_groupe'),
    rupturesByCis: new Map()
  };
}

function indexVet() {
  for (const type of ['medicaments', 'compositions']) {
    const s = VET_INDEX_SPECS[type];
    vetState.searchIndexes[type] = buildFrozenIndexFromRows(
      vetState.corpus[type],
      (row, i) => buildIndexDocument(row, i, s.fields),
      miniSearchIndexConfig(s.fields, s.boost)
    );
  }
  vetState.numIndexes = {
    medicamentsByNum: buildKeyIndex(vetState.corpus.medicaments, 'num', { unique: true }),
    compositionsByNum: buildKeyIndex(vetState.corpus.compositions, 'num'),
    presentationsByNum: new Map()
  };
}

function seed() {
  bdpmState.reset();
  vetState.reset();
  conceptStore.resetConceptStoreCache();
  for (const k of Object.keys(bdpmState.corpus)) clearCorpus(bdpmState.corpus[k]);
  for (const k of Object.keys(vetState.corpus)) clearCorpus(vetState.corpus[k]);

  bdpmState.corpus.specialites.push(
    spec('60234100', 'DOLIPRANE 1000 mg, comprimé', 'comprimé'),
    spec('60234102', 'DOLIPRANE 500 mg, gélule', 'gélule'),
    spec('69999999', 'IBUPROFENE ARROW 400 mg, comprimé pelliculé', 'comprimé pelliculé'),
    spec('69999998', 'IBUPROFENE EXEMPLE 400 mg, comprimé', 'comprimé'),
    spec('66666666', 'ESOMEPRAZOLE ZENTIVA 40 mg, gélule gastro-résistante', 'gélule gastro-résistante'),
    // Ancre « acide folique » hors CIS_GENER + groupes génériques sans rapport partageant le mot « acide »
    spec('61000001', 'ACIDE FOLIQUE CCD 5 mg, comprimé', 'comprimé'),
    spec('61000002', 'ACIDE VALPROIQUE TEVA 500 mg, comprimé', 'comprimé'),
    spec('61000003', 'ACIDE VALPROIQUE MYLAN 500 mg, comprimé', 'comprimé'),
    spec('61000004', 'ACIDE ALENDRONIQUE ARROW 70 mg, comprimé', 'comprimé'),
    spec('61000005', 'FOSAMAX 70 mg, comprimé', 'comprimé'),
    // Groupe générique dont le libellé contient « xacine » seulement à l'intérieur d'un mot
    spec('62000001', 'OFLOCET 200 mg, comprimé', 'comprimé'),
    spec('62000002', 'OFLOXACINE SANDOZ 200 mg, comprimé', 'comprimé'),
    // Homéopathie : la souche ne doit pas perdre sa dilution
    spec('63000001', 'ARNICA MONTANA BOIRON 9 CH, granules', 'granules'),
    spec('63000002', 'ARNICA MONTANA BOIRON 5 CH, granules', 'granules'),
    // Qualificatifs verbatim enchaînés « sans X ni Y »
    spec('64000001', 'PECTOSIROP SANS SUCRE NI CONSERVATEUR, sirop', 'sirop'),
    spec('64000002', 'PECTOSIROP, sirop', 'sirop'),
    // Terme approchant à la fois BDPM et ANMV (aucun match fort)
    spec('65000001', 'ZORBAMINE 10 mg, comprimé', 'comprimé'),
    spec('68888888', 'MELOXICAM TEVA 15 mg, comprimé', 'comprimé'),
    // Mot d'espèce présent dans une dénomination humaine
    spec('66100001', "ALYOSTAL VENIN D'ABEILLE 110 microgrammes, poudre pour solution injectable", 'poudre pour solution injectable', 'sous-cutanée'),
    spec('66100002', 'ALYOSTAL VENIN DE GUEPE 110 microgrammes, poudre pour solution injectable', 'poudre pour solution injectable', 'sous-cutanée'),
    // Association contenant la substance demandée, membre d'un groupe générique
    spec('62100001', 'RHUMAFEBRAL, comprimé', 'comprimé'),
    spec('62100002', 'RHUMAFEBRAL GENERIQUE EG, comprimé', 'comprimé')
  );
  bdpmState.corpus.compositions.push(
    makeRow({ cis: '61000001', designation_element: 'comprimé', code_substance: '1', denomination_substance: 'ACIDE FOLIQUE', dosage: '5 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '61000002', designation_element: 'comprimé', code_substance: '2', denomination_substance: 'VALPROATE DE SODIUM', dosage: '500 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '61000003', designation_element: 'comprimé', code_substance: '2', denomination_substance: 'VALPROATE DE SODIUM', dosage: '500 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '61000004', designation_element: 'comprimé', code_substance: '3', denomination_substance: 'ACIDE ALENDRONIQUE', dosage: '70 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '61000005', designation_element: 'comprimé', code_substance: '3', denomination_substance: 'ACIDE ALENDRONIQUE', dosage: '70 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '62100001', designation_element: 'comprimé', code_substance: '4', denomination_substance: 'ACIDE FOLIQUE', dosage: '1 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '62100001', designation_element: 'comprimé', code_substance: '5', denomination_substance: 'CAFEINE', dosage: '50 mg', nature_composant: 'SA', numero_ordre: '2' })
  );
  bdpmState.corpus.generiques.push(
    makeRow({ id_groupe: '100', libelle_groupe: 'VALPROATE DE SODIUM 500 mg - DEPAKINE 500 mg', cis: '61000002', type_generique: '1', numero_ordre: '1' }),
    makeRow({ id_groupe: '100', libelle_groupe: 'VALPROATE DE SODIUM 500 mg - DEPAKINE 500 mg', cis: '61000003', type_generique: '1', numero_ordre: '2' }),
    makeRow({ id_groupe: '200', libelle_groupe: 'ACIDE ALENDRONIQUE 70 mg - FOSAMAX 70 mg', cis: '61000005', type_generique: '0', numero_ordre: '1' }),
    makeRow({ id_groupe: '200', libelle_groupe: 'ACIDE ALENDRONIQUE 70 mg - FOSAMAX 70 mg', cis: '61000004', type_generique: '1', numero_ordre: '2' }),
    makeRow({ id_groupe: '300', libelle_groupe: 'OFLOXACINE 200 mg - OFLOCET 200 mg', cis: '62000001', type_generique: '0', numero_ordre: '1' }),
    makeRow({ id_groupe: '300', libelle_groupe: 'OFLOXACINE 200 mg - OFLOCET 200 mg', cis: '62000002', type_generique: '1', numero_ordre: '2' }),
    makeRow({ id_groupe: '400', libelle_groupe: 'ACIDE FOLIQUE + CAFEINE - RHUMAFEBRAL', cis: '62100001', type_generique: '0', numero_ordre: '1' }),
    makeRow({ id_groupe: '400', libelle_groupe: 'ACIDE FOLIQUE + CAFEINE - RHUMAFEBRAL', cis: '62100002', type_generique: '1', numero_ordre: '2' }),
    makeRow({ id_groupe: '400', libelle_groupe: 'ACIDE FOLIQUE + CAFEINE - RHUMAFEBRAL', cis: '62199999', type_generique: '1', numero_ordre: '3' })
  );
  indexBdpm();

  vetState.corpus.medicaments.push(
    makeRow({ num: '0000101', nom: 'METACAM 1,5 MG/ML SUSPENSION BUVABLE POUR CHIENS', forme_pharmaceutique: 'Suspension buvable', statut_amm: 'Autorisation active', codes_atcvet: ['QM01AC06'], especes: ['Chien'] }),
    makeRow({ num: '0000202', nom: 'ZORBAMIXE 50 MG COMPRIMES POUR CHATS', forme_pharmaceutique: 'Comprimé', statut_amm: 'Autorisation active', codes_atcvet: [], especes: ['Chat'] }),
    makeRow({ num: '0000303', nom: 'ALYOSTAX GEL POUR ABEILLES', forme_pharmaceutique: 'Gel', statut_amm: 'Autorisation active', codes_atcvet: [], especes: ['Abeilles'] })
  );
  vetState.corpus.compositions.push(
    makeRow({ num: '0000101', substance: 'Méloxicam', quantite: '1.5', unite: 'mg/ml' })
  );
  indexVet();
}

const keysOf = (res) => res.results.map((r) => r.cis || r.num);

describe('audit PR #8 — corrections du pipeline expérimental', () => {
  beforeAll(() => {
    seed();
  });

  afterAll(() => {
    bdpmState.reset();
    vetState.reset();
    conceptStore.resetConceptStoreCache();
  });

  describe('#1 matchFormeCriterion : recouvrement partiel avec qualificatif contradictoire', () => {
    it('contredit "comprimé effervescent" face à "comprimé pelliculé"', () => {
      expect(matchFormeCriterion('comprimé effervescent', 'comprimé pelliculé').status).toBe('contradicted');
    });

    it('garde "expanded" quand le candidat est seulement moins spécifique', () => {
      expect(matchFormeCriterion('comprimé effervescent', 'comprimé').status).toBe('expanded');
      expect(matchFormeCriterion('solution buvable', 'suspension buvable').status).toBe('expanded');
    });

    it('ne remonte pas le comprimé pelliculé au-dessus du comprimé simple en mode concepts', () => {
      const res = executeExperimentalSearchPage('ibuprofene', 'human', 1, 10, { forme: 'comprimé effervescent' }, { mode: 'concepts' });
      const pellicule = res.results.find((r) => r.cis === '69999999');
      expect(pellicule.criteria_status.forme).toBe('contradicted');
      expect(keysOf(res).indexOf('69999998')).toBeLessThan(keysOf(res).indexOf('69999999'));
    });
  });

  describe('#2 expandGenericGroupMatches : pas d’expansion par mot générique ni par sous-chaîne', () => {
    it('"générique acide folique" n’importe pas les groupes valproïque / alendronique', () => {
      const res = executeExperimentalSearchPage('générique acide folique', 'human', 1, 50, {}, { mode: 'concepts' });
      const keys = keysOf(res);
      expect(keys).toContain('61000001');
      for (const unrelated of ['61000002', '61000003', '61000004', '61000005']) {
        expect(keys).not.toContain(unrelated);
      }
    });

    it('le repli sur libelle_groupe compare des mots entiers', () => {
      const res = executeExperimentalSearchPage('générique xacine', 'human', 1, 50, {}, { mode: 'concepts' });
      expect(keysOf(res)).not.toContain('62000001');
      expect(keysOf(res)).not.toContain('62000002');
    });

    it('n’amorce pas l’expansion depuis une association trouvée via sa composition', () => {
      const res = executeExperimentalSearchPage('générique acide folique', 'human', 1, 50, {}, { mode: 'concepts' });
      expect(res.results.filter((r) => r.match_via === 'generique')).toEqual([]);
    });

    it('n’ajoute pas de CIS de groupe absent du référentiel chargé', () => {
      const res = executeExperimentalSearchPage('générique rhumafebral', 'human', 1, 50, {}, { mode: 'concepts' });
      expect(keysOf(res)).toEqual(expect.arrayContaining(['62100001', '62100002']));
      expect(keysOf(res)).not.toContain('62199999');
    });

    it('tolère une faute de frappe sur une marque d’un seul mot (générique oflocat)', () => {
      const res = executeExperimentalSearchPage('générique oflocat', 'human', 1, 50, {}, { mode: 'concepts' });
      expect(keysOf(res)).toEqual(expect.arrayContaining(['62000001', '62000002']));
    });

    it('conserve l’expansion légitime par marque (générique oflocet)', () => {
      const res = executeExperimentalSearchPage('générique oflocet', 'human', 1, 50, {}, { mode: 'concepts' });
      expect(keysOf(res)).toEqual(expect.arrayContaining(['62000001', '62000002']));
    });
  });

  describe('#3 conflits explicite / extrait comparés sur les valeurs', () => {
    const tax = () => conceptStore.getTaxonomyVocab();

    it('n’annonce pas de conflit pour un même dosage écrit différemment', () => {
      expect(parseStructuredQuery('doliprane 500mg', { dosage: '500mg' }, tax()).conflicts).toEqual([]);
      expect(parseStructuredQuery('doliprane 1000 mg', { dosage: '1 g' }, tax()).conflicts).toEqual([]);
      expect(parseStructuredQuery('doliprane 1,5 g', { dosage: '1,5 g' }, tax()).conflicts).toEqual([]);
      expect(parseStructuredQuery('lidocaine 10 mg/ml', { dosage: '10 mg/1 ml' }, tax()).conflicts).toEqual([]);
      expect(parseStructuredQuery('lidocaine 10 mg/ml', { dosage: '10 mg/5 ml' }, tax()).conflicts).toHaveLength(1);
    });

    it('n’annonce pas de conflit pour une même forme / voie au pluriel ou sous alias', () => {
      expect(parseStructuredQuery('doliprane comprimé', { forme: 'comprimés' }, tax()).conflicts).toEqual([]);
      expect(parseStructuredQuery('doliprane cpr', { forme: 'comprimé' }, tax(), { useAliases: true }).conflicts).toEqual([]);
      expect(parseStructuredQuery('doliprane per os', { voie: 'voie orale' }, tax(), { useAliases: true }).conflicts).toEqual([]);
    });

    it('signale toujours un vrai conflit', () => {
      const parsed = parseStructuredQuery('doliprane 500 mg comprimé', { dosage: '1000 mg', forme: 'gélule' }, tax());
      expect(parsed.conflicts.map((c) => c.field).sort()).toEqual(['dosage', 'forme']);
    });
  });

  describe('#4 espèce animale en mode structured', () => {
    it('interroge l’ANMV quand une espèce est extraite (source=auto)', () => {
      const res = executeExperimentalSearchPage('meloxicam chien', 'auto', 1, 5, {}, { mode: 'structured' });
      expect(res.search.referentiels.queried).toContain('anmv');
      expect(res.results[0].type).toBe('medicament_veterinaire');
      expect(res.results[0].num).toBe('0000101');
    });

    it('garde la BDPM quand l’ANMV ne répond que par un match approché', () => {
      for (const mode of ['structured', 'concepts']) {
        // « alyostal » ≈ ALYOSTAX (ANMV, fuzzy) ; ALYOSTAL VENIN D'ABEILLE (BDPM, fort)
        const res = executeExperimentalSearchPage('alyostal abeille', 'auto', 1, 5, {}, { mode });
        expect(res.search.parsed.species).toEqual(['abeille']);
        expect(res.results[0].cis).toBe('66100001');
        // l'ANMV écartée n'est pas annoncée parmi les référentiels ayant répondu
        expect(res.search.referentiels.queried).toEqual(['anmv', 'bdpm']);
        expect(res.search.referentiels.with_results).toEqual(['bdpm']);
      }
    });

    it('réintègre le mot d’espèce au nom pour le repli BDPM (venin d’abeille ≠ venin de guêpe)', () => {
      for (const mode of ['structured', 'concepts']) {
        const res = executeExperimentalSearchPage('venin abeille', 'auto', 1, 5, {}, { mode });
        expect(keysOf(res)).toEqual(['66100001']);
        expect(res.results[0].criteria_status.species).toBeUndefined();
      }
    });
  });

  describe('#5 unités non interprétables laissées dans la requête', () => {
    it('ne retire pas "9 ch" du nom et ne le transforme pas en critère', () => {
      const parsed = parseStructuredQuery('arnica 9 ch', {}, conceptStore.getTaxonomyVocab());
      expect(parsed.nameQuery).toBe('arnica 9 ch');
      expect(parsed.effectiveCriteria.dosage).toBeNull();
    });

    it('ne retire pas une concentration dont le numérateur est non interprétable', () => {
      const parsed = parseStructuredQuery('potassium 5 mmol/10 ml', {}, conceptStore.getTaxonomyVocab());
      expect(parsed.effectiveCriteria.dosage).toBeNull();
      expect(parsed.nameQuery).toContain('mmol');
      for (const q of ['x 5 mmol / 10 ml', 'potassium/2 mmol/10 ml']) {
        expect(parseStructuredQuery(q).effectiveCriteria.dosage).toBeNull();
      }
    });

    it('extrait toujours les dosages interprétables (mg, g, ml, ui, %)', () => {
      expect(parseStructuredQuery('doliprane 1 g').effectiveCriteria.dosage).toBe('1 g');
      expect(parseStructuredQuery('lidocaine 2 %').effectiveCriteria.dosage).toBe('2 %');
    });

    it('n’annonce pas de critère "unsupported" pour une dilution homéopathique', () => {
      const res = executeExperimentalSearchPage('arnica 9 ch', 'human', 1, 10, {}, { mode: 'structured' });
      expect(res.search.parsed.dosage).toBeNull();
      for (const r of res.results) expect(r.criteria_status.dosage).toBe('not_requested');
    });
  });

  describe('#6 source=auto sans match fort : même fallback que legacy', () => {
    it('remplace les résultats BDPM faibles par les résultats ANMV', () => {
      const legacy = executeHybridSearchPage('zorbamize', 'auto', 1, 50);
      const legacyKeys = legacy.results.map((r) => r.cis || r.num).sort();
      expect(legacyKeys.length).toBeGreaterThan(0);
      for (const mode of ['structured', 'concepts']) {
        const exp = executeExperimentalSearchPage('zorbamize', 'auto', 1, 50, {}, { mode });
        expect(keysOf(exp).sort()).toEqual(legacyKeys);
        expect(exp.total).toBe(legacy.total);
      }
    });
  });

  describe('#7 « sans X ni Y » sur qualificatifs verbatim', () => {
    it('ne s’abstient pas sur une chaîne de qualificatifs littéraux', () => {
      const q = 'pectosirop sans sucre ni conservateur';
      const safety = analyzeQuerySafetyAndIntent(q, parseStructuredQuery(q));
      expect(safety.supported).toBe(true);
      expect(safety.verbatimQualifiers).toEqual(['sans sucre', 'sans conservateur']);
    });

    it('extrait les deux qualificatifs même quand ils forment toute la requête restante', () => {
      const parsed = parseStructuredQuery('sirop sans sucre ni conservateur', {}, null, { useAliases: true });
      expect(parsed.extracted.qualifiers).toEqual(['sans sucre', 'sans conservateur']);
      expect(parsed.nameQuery).not.toMatch(/\bni\b/);
    });

    it('s’abstient toujours sur « ni » hors chaîne verbatim', () => {
      expect(analyzeQuerySafetyAndIntent('pectosirop sans sucre ni paracetamol', null).supported).toBe(false);
      expect(analyzeQuerySafetyAndIntent('pectosirop sans codeine ni sucre', null).supported).toBe(false);
    });

    it('accepte la même chaîne dans un critère explicite', () => {
      expect(inspectCriterionConstraint('sirop sans sucre ni conservateur')).toBeNull();
      expect(inspectCriterionConstraint('sirop sans sucre ni codeine')).not.toBeNull();
    });

    it('retrouve la spécialité correspondante de bout en bout (structured et concepts)', () => {
      for (const mode of ['structured', 'concepts']) {
        const res = executeExperimentalSearchPage('pectosirop sans sucre ni conservateur', 'human', 1, 10, {}, { mode });
        expect(res.search.abstained).toBe(false);
        expect(keysOf(res)).toEqual(['64000001']);
      }
    });
  });

  describe('#8 préchauffage ConceptStore : invalidation par côté et robustesse', () => {
    it('ne reconstruit que le côté rechargé et réutilise l’autre', () => {
      conceptStore.resetConceptStoreCache();
      conceptStore.warmExperimentalSearch('concepts');
      const before = conceptStore.getConceptStore();

      conceptStore.onCorpusCleared('bdpm');
      indexBdpm(); // nouvelle génération d’index BDPM
      conceptStore.onCorpusLoaded('concepts');

      expect(conceptStore.hasConceptStoreCached()).toBe(true);
      const after = conceptStore.getConceptStore();
      expect(after).not.toBe(before);
      expect(after.bdpmByCis).not.toBe(before.bdpmByCis);
      expect(after.vetByNum).toBe(before.vetByNum);
    });

    it('n’échoue pas le chargement si la construction du ConceptStore lève une exception', () => {
      const boom = makeRow({ cis: '69990000', forme_pharma: 'comprimé', voies_admin: 'orale' });
      Object.defineProperty(boom, 'denomination', { get() { throw new Error('boom'); } });
      bdpmState.corpus.specialites.push(boom);
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        conceptStore.onCorpusCleared('bdpm');
        bdpmState.cisIndexes = { ...bdpmState.cisIndexes };
        expect(() => conceptStore.onCorpusLoaded('concepts')).not.toThrow();
        expect(errSpy).toHaveBeenCalled();
      } finally {
        errSpy.mockRestore();
        bdpmState.corpus.specialites.pop();
        conceptStore.resetConceptStoreCache();
        indexBdpm();
      }
    });
  });
});
