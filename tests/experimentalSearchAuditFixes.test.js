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
    // Association dont la dénomination ne cite pas les substances (trouvée par l'étape concepts)
    spec('60904643', 'CODOLIPRANE 500 mg/30 mg, comprimé', 'comprimé'),
    spec('60904644', 'PARACETAMOL/CODEINE ARROW 500 mg/30 mg, comprimé', 'comprimé'),
    spec('64200001', "SERUM D'ANGUILLE BOIRON, granules", 'granules'),
    // Lettre présente seulement dans la composition (« FACTEUR X »)
    spec('64400001', 'OCTAPLEX 500 UI, poudre et solvant pour solution injectable', 'poudre et solvant pour solution injectable', 'intraveineuse'),
    // Article élidé dans la dénomination
    spec('64500001', "HUILE D'OLIVE COOPER, solution", 'solution'),
    spec('64600001', 'MONOPROD S 10 mg, comprimé', 'comprimé'),
    spec('64600002', 'AAPROD S 10 mg/5 mg, comprimé', 'comprimé'),
    // Dénomination sans le nom de la substance ; dosage horaire laissé dans la requête
    spec('64300001', 'NICOPATCH 21 mg/24 heures, dispositif transdermique', 'dispositif transdermique', 'transdermique'),
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
    makeRow({ cis: '64600001', designation_element: 'comprimé', code_substance: '11', denomination_substance: 'ZOLMETRINE', dosage: '10 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '64600002', designation_element: 'comprimé', code_substance: '11', denomination_substance: 'ZOLMETRINE', dosage: '10 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '64600002', designation_element: 'comprimé', code_substance: '12', denomination_substance: 'CAFEINE', dosage: '5 mg', nature_composant: 'SA', numero_ordre: '2' }),
    makeRow({ cis: '64400001', designation_element: 'poudre', code_substance: '9', denomination_substance: 'FACTEUR IX DE COAGULATION HUMAIN', dosage: '500 UI', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '64400001', designation_element: 'poudre', code_substance: '10', denomination_substance: 'FACTEUR X DE COAGULATION HUMAIN', dosage: '500 UI', nature_composant: 'SA', numero_ordre: '2' }),
    makeRow({ cis: '64300001', designation_element: 'dispositif', code_substance: '8', denomination_substance: 'NICOTINE', dosage: '52,5 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '60904643', designation_element: 'comprimé', code_substance: '6', denomination_substance: 'PARACÉTAMOL', dosage: '500 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '60904643', designation_element: 'comprimé', code_substance: '7', denomination_substance: 'PHOSPHATE DE CODÉINE HÉMIHYDRATÉ', dosage: '30 mg', nature_composant: 'SA', numero_ordre: '2' }),
    makeRow({ cis: '60904644', designation_element: 'comprimé', code_substance: '6', denomination_substance: 'PARACÉTAMOL', dosage: '500 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '60904644', designation_element: 'comprimé', code_substance: '7', denomination_substance: 'PHOSPHATE DE CODÉINE HÉMIHYDRATÉ', dosage: '30 mg', nature_composant: 'SA', numero_ordre: '2' }),
    makeRow({ cis: '62100001', designation_element: 'comprimé', code_substance: '4', denomination_substance: 'ACIDE FOLIQUE', dosage: '1 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '62100001', designation_element: 'comprimé', code_substance: '5', denomination_substance: 'CAFEINE', dosage: '50 mg', nature_composant: 'SA', numero_ordre: '2' })
  );
  bdpmState.corpus.generiques.push(
    makeRow({ id_groupe: '100', libelle_groupe: 'VALPROATE DE SODIUM 500 mg - DEPAKINE 500 mg, poudre pour solution buvable', cis: '61000002', type_generique: '1', numero_ordre: '1' }),
    makeRow({ id_groupe: '100', libelle_groupe: 'VALPROATE DE SODIUM 500 mg - DEPAKINE 500 mg, poudre pour solution buvable', cis: '61000003', type_generique: '1', numero_ordre: '2' }),
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
    makeRow({ num: '0000303', nom: 'ALYOSTAX GEL POUR ABEILLES', forme_pharmaceutique: 'Gel', statut_amm: 'Autorisation active', codes_atcvet: [], especes: ['Abeilles'] }),
    makeRow({ num: '0000404', nom: 'SERUM TRIVALENT EQUIN', forme_pharmaceutique: 'Solution injectable', statut_amm: 'Autorisation active', codes_atcvet: [], especes: ['Chevaux'] }),
    makeRow({ num: '0000505', nom: 'ANGUIVET BAIN POUR ANGUILLES', forme_pharmaceutique: 'Solution', statut_amm: 'Autorisation active', codes_atcvet: [], especes: ['Anguilles'] })
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
      // un mot de voie demandé n'est pas un qualificatif de forme manquant
      expect(matchFormeCriterion('gel oral', 'gel buvable').status).toBe('expanded');
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

    it('n’annonce pas de conflit pour une association écrite avec ou sans « / »', () => {
      expect(parseStructuredQuery('codoliprane 500 mg 30 mg', { dosage: '500 mg/30 mg' }, tax()).conflicts).toEqual([]);
      // une concentration reste distincte d'une quantité nue
      expect(parseStructuredQuery('amoxicilline 12,5 mg', { dosage: '12,5 mg/kg' }, tax()).conflicts).toHaveLength(1);
      expect(parseStructuredQuery('metoject 10 mg', { dosage: '10 mg/0,4 ml' }, tax()).conflicts).toHaveLength(1);
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

    it('un match ANMV fort pour une autre espèce ne court-circuite pas la BDPM (sérum d’anguille ≠ sérum équin)', () => {
      for (const mode of ['structured', 'concepts']) {
        const res = executeExperimentalSearchPage("serum d'anguille", 'auto', 1, 5, {}, { mode });
        expect(res.search.parsed.species).toEqual(['anguille']);
        expect(res.search.referentiels.queried).toEqual(['anmv', 'bdpm']);
        expect(keysOf(res)).toEqual(['64200001']);
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

  describe('#6 source=auto sans match fort : fusion BDPM + ANMV (écart volontaire avec legacy)', () => {
    it('garde les résultats BDPM faibles à côté des résultats ANMV faibles', () => {
      // legacy remplace la BDPM par l'ANMV ; B1/B2 fusionnent et laissent les critères départager
      const legacy = executeHybridSearchPage('zorbamize', 'auto', 1, 50);
      expect(legacy.results.map((r) => r.cis || r.num)).toEqual(['0000202']);
      for (const mode of ['structured', 'concepts']) {
        const exp = executeExperimentalSearchPage('zorbamize', 'auto', 1, 50, {}, { mode });
        expect(keysOf(exp).sort()).toEqual(['0000202', '65000001']);
        expect(exp.total).toBe(2);
      }
    });
  });

  describe('#3 referentiels.with_results décrit les sources présentes dans les résultats', () => {
    it('annonce les deux référentiels quand les deux listes faibles sont fusionnées', () => {
      for (const mode of ['structured', 'concepts']) {
        const exp = executeExperimentalSearchPage('zorbamize', 'auto', 1, 50, {}, { mode });
        expect(exp.search.referentiels.queried).toEqual(['bdpm', 'anmv']);
        expect(exp.search.referentiels.with_results).toEqual(['bdpm', 'anmv']);
      }
    });

    it('n’annonce pas une source dont tous les résultats sont écartés par un qualificatif littéral', () => {
      // en concepts, l'alias retire « sans sucre » : la BDPM répond, puis le filtre écarte tout
      const res = executeExperimentalSearchPage('zorbamine sans sucre', 'human', 1, 50, {}, { mode: 'concepts' });
      expect(res.total).toBe(0);
      expect(res.search.referentiels.queried).toEqual(['bdpm']);
      expect(res.search.referentiels.with_results).toEqual([]);
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

    it('chaque qualificatif littéral du garde-fou est reconnu par le parseur, seul ou enchaîné', () => {
      const { VERBATIM_SANS_QUALIFIER_WORDS } = require('../src/search/queryIntentGuard');
      for (const w of VERBATIM_SANS_QUALIFIER_WORDS) {
        const q = `pectosirop sans sucre ni ${w}`;
        expect(analyzeQuerySafetyAndIntent(q, null).supported).toBe(true);
        const parsed = parseStructuredQuery(q, {}, null, { useAliases: true });
        expect(parsed.extracted.qualifiers).toContain(`sans ${w}`);
        expect(parsed.nameQuery).toBe('pectosirop');
      }
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

  describe('découpage identique requête / index de concepts (noms à tiret)', () => {
    it('« paracetamol-codeine » retrouve les mêmes spécialités, dans le même ordre, que « paracetamol codeine »', () => {
      const spaced = executeExperimentalSearchPage('paracetamol codeine', 'human', 1, 50, {}, { mode: 'concepts' });
      const hyphen = executeExperimentalSearchPage('paracetamol-codeine', 'human', 1, 50, {}, { mode: 'concepts' });
      expect(keysOf(spaced)).toContain('60904643'); // CODOLIPRANE, trouvé par ses compositions
      expect(keysOf(hyphen)).toEqual(keysOf(spaced));
      expect(hyphen.total).toBe(spaced.total);
    });

    it('une lettre isolée non indexée reste exigée (pas d’élargissement à « ibuprofene » seul)', () => {
      const res = executeExperimentalSearchPage('ibuprofene-x', 'human', 1, 50, {}, { mode: 'concepts' });
      expect(res.total).toBe(0);
      // « l » accolé fait partie du nom, ce n'est pas l'article élidé
      // (la recherche lexicale le rapproche en fuzzy ; l'étape concepts ne doit pas le promouvoir)
      const lIbu = executeExperimentalSearchPage('l-ibuprofene', 'human', 1, 50, {}, { mode: 'concepts' });
      expect(lIbu.results.map((r) => r.match_quality)).toEqual(lIbu.results.map(() => 'fuzzy'));
    });

    it('une lettre d’unité laissée dans la requête (« 24 h ») n’est pas exigée dans la dénomination', () => {
      const res = executeExperimentalSearchPage('nicotine 24 h', 'human', 1, 50, {}, { mode: 'concepts' });
      expect(keysOf(res)).toContain('64300001');
      // une lettre ordinaire après un nombre reste exigée
      expect(executeExperimentalSearchPage('ibuprofene 400 x', 'human', 1, 50, {}, { mode: 'concepts' }).results
        .every((r) => r.match_quality === 'fuzzy')).toBe(true);
    });

    it('#6 une lettre isolée est indexée et peut être couverte par la composition (octaplex facteur x)', () => {
      for (const q of ['octaplex facteur x', 'facteur x facteur ix']) {
        const res = executeExperimentalSearchPage(q, 'human', 1, 50, {}, { mode: 'concepts' });
        expect(keysOf(res)).toContain('64400001');
      }
    });

    it('#6 une lettre de taille ne compte pas comme substance (préférence mono-substance conservée)', () => {
      // AAPROD S (association) précède MONOPROD S par ordre alphabétique : seule la
      // préférence mono-substance place MONOPROD S en tête
      const res = executeExperimentalSearchPage('zolmetrine s', 'human', 1, 50, {}, { mode: 'concepts' });
      expect(keysOf(res).slice(0, 2)).toEqual(['64600001', '64600002']);
    });

    it('#6 l’article élidé n’est pas exigé (huile de l’olive)', () => {
      const res = executeExperimentalSearchPage("huile de l'olive", 'human', 1, 50, {}, { mode: 'concepts' });
      expect(keysOf(res)).toContain('64500001');
    });

    it('le repli libelle_groupe exige tous les mots et un mot alphabétique significatif', () => {
      for (const q of ['générique pour-on', 'générique 200-cb']) {
        const res = executeExperimentalSearchPage(q, 'human', 1, 50, {}, { mode: 'concepts' });
        expect(res.results.filter((r) => r.match_via === 'generique')).toEqual([]);
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
