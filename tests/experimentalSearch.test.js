'use strict';

const request = require('supertest');
const express = require('express');

const bdpmState = require('../src/services/bdpm/state');
const vetState = require('../src/services/vet/state');
const medicamentRoutes = require('../src/routes/medicaments');
const { executeHybridSearchPage } = require('../src/services/searchOrchestrator');
const { executeExperimentalSearchPage, evaluateEntityCriteria } = require('../src/search/experimentalSearch');
const { parseStructuredQuery } = require('../src/search/structuredQueryParser');
const {
  getTaxonomyVocab,
  getConceptStore,
  hasConceptStoreCached,
  resetConceptStoreCache
} = require('../src/search/conceptStore');
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

function seedSyntheticCorpora() {
  bdpmState.reset();
  vetState.reset();
  resetConceptStoreCache();
  for (const k of Object.keys(bdpmState.corpus)) clearCorpus(bdpmState.corpus[k]);
  for (const k of Object.keys(vetState.corpus)) clearCorpus(vetState.corpus[k]);

  const specialites = [
    makeRow({ cis: '60234100', denomination: 'DOLIPRANE 1000 mg, comprimé', forme_pharma: 'comprimé', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'OPELLA' }),
    makeRow({ cis: '60234101', denomination: 'DOLIPRANE 1000 mg, comprimé effervescent sécable', forme_pharma: 'comprimé effervescent(e)', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'OPELLA' }),
    makeRow({ cis: '60234102', denomination: 'DOLIPRANE 500 mg, gélule', forme_pharma: 'gélule', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'OPELLA' }),
    makeRow({ cis: '60904643', denomination: 'CODOLIPRANE 500 mg/30 mg, comprimé', forme_pharma: 'comprimé', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'OPELLA' }),
    makeRow({ cis: '66053338', denomination: 'AUGMENTIN 1 g/125 mg ADULTES, poudre pour suspension buvable en sachet-dose', forme_pharma: 'poudre pour suspension buvable', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'GSK' }),
    makeRow({ cis: '61111111', denomination: 'AMOXICILLINE BIOGARAN 1 g, comprimé dispersible', forme_pharma: 'comprimé dispersible', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'BIOGARAN' }),
    makeRow({ cis: '61111112', denomination: 'AMOXICILLINE SANDOZ 500 mg/5 ml, poudre pour suspension buvable', forme_pharma: 'poudre pour suspension buvable', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'SANDOZ' }),
    makeRow({ cis: '69999999', denomination: 'IBUPROFENE ARROW 400 mg, comprimé pelliculé', forme_pharma: 'comprimé pelliculé', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'ARROW' }),
    makeRow({ cis: '62222222', denomination: 'MAG 2 100 mg, comprimé', forme_pharma: 'comprimé', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'COOPER' }),
    makeRow({ cis: '63333333', denomination: 'HEXAMIDINE 0,1 POUR CENT, collyre en solution', forme_pharma: 'collyre en solution', voies_admin: 'ophtalmique', commercialisation: 'Commercialisée', titulaire: 'BIOCODEX' }),
    makeRow({ cis: '64444444', denomination: 'METHOTREXATE BELLON 2,5 mg, comprimé', forme_pharma: 'comprimé', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'SANOFI' }),
    makeRow({ cis: '64444445', denomination: 'METOJECT 10 mg/0,4 ml, solution injectable', forme_pharma: 'solution injectable', voies_admin: 'sous-cutanée', commercialisation: 'Commercialisée', titulaire: 'MEDAC' }),
    makeRow({ cis: '65555555', denomination: 'CERULYSE 5 POUR CENT, solution pour instillation auriculaire', forme_pharma: 'solution pour instillation auriculaire', voies_admin: 'auriculaire', commercialisation: 'Commercialisée', titulaire: 'CHAUVIN' }),
    makeRow({ cis: '66666666', denomination: 'ESOMEPRAZOLE ZENTIVA 40 mg, gélule gastro-résistante', forme_pharma: 'gélule gastro-résistante', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'ZENTIVA' }),
    makeRow({ cis: '67777771', denomination: 'TAGAMET 200 mg, comprimé', forme_pharma: 'comprimé', voies_admin: 'orale', commercialisation: 'Non commercialisée', titulaire: 'GSK' }),
    makeRow({ cis: '67777772', denomination: 'CIMETIDINE EG 200 mg, comprimé', forme_pharma: 'comprimé', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'EG' })
  ];

  const presentations = [
    makeRow({ cis: '60234100', cip7: '3595583', cip13: '3400935955838', libelle: 'plaquette(s) PVC-Aluminium de 8 comprimé(s)', indications: '' }),
    makeRow({ cis: '65555555', cip7: '3019991', cip13: '3400930199916', libelle: '1 flacon(s) en verre jaune(brun) de 10 ml avec compte-gouttes', indications: '' })
  ];

  const compositions = [
    makeRow({ cis: '60234100', designation_element: 'comprimé', code_substance: '02202', denomination_substance: 'PARACÉTAMOL', dosage: '1000 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '60234102', designation_element: 'gélule', code_substance: '02202', denomination_substance: 'PARACÉTAMOL', dosage: '500 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '60904643', designation_element: 'comprimé', code_substance: '02202', denomination_substance: 'PARACÉTAMOL', dosage: '500 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '60904643', designation_element: 'comprimé', code_substance: '74765', denomination_substance: 'PHOSPHATE DE CODÉINE', dosage: '30 mg', nature_composant: 'SA', numero_ordre: '2' }),
    makeRow({ cis: '66053338', designation_element: 'poudre', code_substance: '05248', denomination_substance: 'AMOXICILLINE ANHYDRE', dosage: '1000 mg', nature_composant: 'FT', numero_ordre: '1' }),
    makeRow({ cis: '66053338', designation_element: 'poudre', code_substance: '28165', denomination_substance: 'AMOXICILLINE TRIHYDRATÉE', dosage: '', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '66053338', designation_element: 'poudre', code_substance: '29442', denomination_substance: 'CLAVULANATE DE POTASSIUM', dosage: '', nature_composant: 'SA', numero_ordre: '2' }),
    makeRow({ cis: '66053338', designation_element: 'poudre', code_substance: '93286', denomination_substance: 'ACIDE CLAVULANIQUE', dosage: '125,00 mg', nature_composant: 'FT', numero_ordre: '2' }),
    makeRow({ cis: '61111111', designation_element: 'comprimé', code_substance: '05248', denomination_substance: 'AMOXICILLINE ANHYDRE', dosage: '1000 mg', nature_composant: 'FT', numero_ordre: '1' }),
    makeRow({ cis: '61111111', designation_element: 'comprimé', code_substance: '28165', denomination_substance: 'AMOXICILLINE TRIHYDRATÉE', dosage: '', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '61111112', designation_element: 'poudre', code_substance: '28165', denomination_substance: 'AMOXICILLINE TRIHYDRATÉE', dosage: '500 mg/5 ml', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '69999999', designation_element: 'comprimé', code_substance: '01234', denomination_substance: 'IBUPROFÈNE', dosage: '400 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '64444444', designation_element: 'comprimé', code_substance: '03333', denomination_substance: 'MÉTHOTREXATE', dosage: '2,5 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '66666666', designation_element: 'gélule', code_substance: '17407', denomination_substance: 'ÉSOMÉPRAZOLE', dosage: '40 mg', nature_composant: 'FT', numero_ordre: '1' }),
    makeRow({ cis: '66666666', designation_element: 'gélule', code_substance: '61112', denomination_substance: 'ÉSOMÉPRAZOLE MAGNÉSIQUE TRIHYDRATÉ', dosage: '44,5 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '67777771', designation_element: 'comprimé', code_substance: '04444', denomination_substance: 'CIMÉTIDINE', dosage: '200 mg', nature_composant: 'SA', numero_ordre: '1' }),
    makeRow({ cis: '67777772', designation_element: 'comprimé', code_substance: '04444', denomination_substance: 'CIMÉTIDINE', dosage: '200 mg', nature_composant: 'SA', numero_ordre: '1' })
  ];

  const generiques = [
    makeRow({ id_groupe: '900', libelle_groupe: 'CIMÉTIDINE 200 mg - TAGAMET 200 mg', cis: '67777771', type_generique: '0', numero_ordre: '1' }),
    makeRow({ id_groupe: '900', libelle_groupe: 'CIMÉTIDINE 200 mg - TAGAMET 200 mg', cis: '67777772', type_generique: '1', numero_ordre: '2' })
  ];

  const mitm = [
    makeRow({ cis: '64444444', code_atc: 'L01BA01', denomination: 'METHOTREXATE BELLON 2,5 mg', lien_fi: '' })
  ];

  bdpmState.corpus.specialites.push(...specialites);
  bdpmState.corpus.presentations.push(...presentations);
  bdpmState.corpus.compositions.push(...compositions);
  bdpmState.corpus.generiques.push(...generiques);
  bdpmState.corpus.mitm.push(...mitm);

  for (const type of ['specialites', 'presentations', 'compositions', 'generiques', 'mitm']) {
    const spec = BDPM_INDEX_SPECS[type];
    bdpmState.searchIndexes[type] = buildFrozenIndexFromRows(
      bdpmState.corpus[type],
      (row, i) => buildIndexDocument(row, i, spec.fields),
      miniSearchIndexConfig(spec.fields, spec.boost)
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

  // Corpus vétérinaire synthétique (méloxicam humain vs METACAM chien)
  const vetMeds = [
    makeRow({ num: '0000101', nom: 'METACAM 1,5 MG/ML SUSPENSION BUVABLE POUR CHIENS', forme_pharmaceutique: 'Suspension buvable', statut_amm: 'Autorisation active', codes_atcvet: ['QM01AC06'], especes: ['Chien'] })
  ];
  const vetComps = [
    makeRow({ num: '0000101', substance: 'Méloxicam', quantite: '1.5', unite: 'mg/ml' })
  ];
  bdpmState.corpus.specialites.push(
    makeRow({ cis: '68888888', denomination: 'MELOXICAM TEVA 15 mg, comprimé', forme_pharma: 'comprimé', voies_admin: 'orale', commercialisation: 'Commercialisée', titulaire: 'TEVA' })
  );
  // Re-index bdpm specialites after adding MELOXICAM TEVA
  {
    const spec = BDPM_INDEX_SPECS.specialites;
    bdpmState.searchIndexes.specialites = buildFrozenIndexFromRows(
      bdpmState.corpus.specialites,
      (row, i) => buildIndexDocument(row, i, spec.fields),
      miniSearchIndexConfig(spec.fields, spec.boost)
    );
    bdpmState.cisIndexes.specialitesByCis = buildKeyIndex(bdpmState.corpus.specialites, 'cis', { unique: true });
  }

  vetState.corpus.medicaments.push(...vetMeds);
  vetState.corpus.compositions.push(...vetComps);
  for (const type of ['medicaments', 'compositions']) {
    const spec = VET_INDEX_SPECS[type];
    vetState.searchIndexes[type] = buildFrozenIndexFromRows(
      vetState.corpus[type],
      (row, i) => buildIndexDocument(row, i, spec.fields),
      miniSearchIndexConfig(spec.fields, spec.boost)
    );
  }
  vetState.numIndexes = {
    medicamentsByNum: buildKeyIndex(vetState.corpus.medicaments, 'num', { unique: true }),
    compositionsByNum: buildKeyIndex(vetState.corpus.compositions, 'num'),
    presentationsByNum: new Map()
  };
}

describe('structuredQueryParser & experimentalSearch (B1/B2)', () => {
  beforeAll(() => {
    seedSyntheticCorpora();
  });

  afterAll(() => {
    bdpmState.reset();
    vetState.reset();
    resetConceptStoreCache();
    for (const k of Object.keys(bdpmState.corpus)) clearCorpus(bdpmState.corpus[k]);
    for (const k of Object.keys(vetState.corpus)) clearCorpus(vetState.corpus[k]);
  });

  describe('parseStructuredQuery invariants', () => {
    it('préserve les chiffres de marque sans unité (MAG 2 100 mg, VITAMINE D3)', () => {
      const mag = parseStructuredQuery('MAG 2 100 mg');
      expect(mag.nameQuery).toBe('mag 2');
      expect(mag.effectiveCriteria.dosage).toBe('100 mg');

      const vit = parseStructuredQuery('VITAMINE D3 100 000 UI');
      expect(vit.nameQuery).toBe('vitamine d3');
      expect(vit.effectiveCriteria.dosage).toBe('100000 ui');
    });

    it('détache les dosages collés sans toucher aux concentrations non unitaires', () => {
      const esom = parseStructuredQuery('esoméprazole40mg');
      expect(esom.nameQuery).toBe('esomeprazole');
      expect(esom.effectiveCriteria.dosage).toBe('40 mg');

      const conc = parseStructuredQuery('metoject 10 mg/0,4 ml');
      expect(conc.effectiveCriteria.dosage).toBe('10 mg/0.4 ml');
      expect(conc.nameQuery).toBe('metoject');
    });

    it('route les codes numériques et ATC sans altération', () => {
      const cis = parseStructuredQuery('60234100');
      expect(cis.kind).toBe('exact_code');
      expect(cis.code).toEqual({ kind: 'numeric_code', code: '60234100' });

      const atc = parseStructuredQuery('L01BA01');
      expect(atc.kind).toBe('exact_code');
      expect(atc.code).toEqual({ kind: 'atc_code', code: 'L01BA01' });
    });

    it('donne la priorité aux paramètres explicites et signale les conflits', () => {
      const parsed = parseStructuredQuery('Doliprane 1 g comprimé', {
        dosage: '500 mg',
        forme: 'gélule'
      }, getConceptStore().taxonomy);
      expect(parsed.effectiveCriteria.dosage).toBe('500 mg');
      expect(parsed.effectiveCriteria.forme).toBe('gélule');
      expect(parsed.conflicts).toHaveLength(2);
    });

    it('n active les alias galéniques qu en mode B2 (useAliases=true)', () => {
      const b1 = parseStructuredQuery('méthotrexate per os', {}, null, { useAliases: false });
      expect(b1.effectiveCriteria.voie).toBeNull();
      expect(b1.nameQuery).toBe('methotrexate per os');

      const b2 = parseStructuredQuery('méthotrexate per os', {}, null, { useAliases: true });
      expect(b2.effectiveCriteria.voie).toBe('orale');
      expect(b2.nameQuery).toBe('methotrexate');

      const oosClinical = parseStructuredQuery('quel sirop contre toux seche', {}, null, { useAliases: true });
      expect(oosClinical.nameQuery).toContain('quel');
      expect(oosClinical.nameQuery).toContain('contre');

      const weight = parseStructuredQuery('douleur adulte 70 kg', {}, null, { useAliases: true });
      expect(weight.effectiveCriteria.dosage).toBeNull();
      expect(weight.nameQuery).toContain('70');
      expect(weight.nameQuery).toContain('kg');

      const concKg = parseStructuredQuery('amoxicilline 12,5 mg/kg', {}, null, { useAliases: true });
      expect(concKg.effectiveCriteria.dosage).toBe('12.5 mg/kg');
    });

    it('détecte négations, multi-exclusions, poids patient et propriétés RCP (A1)', () => {
      const n1 = executeExperimentalSearchPage('sans acide acétylsalicylique', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(n1.total).toBe(0);
      expect(n1.search.abstained).toBe(true);
      expect(n1.search.safety.negation.excluded).toEqual(['acide acetylsalicylique']);

      const n2 = executeExperimentalSearchPage('sans paracétamol ni ibuprofène', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(n2.total).toBe(0);
      expect(n2.search.abstained).toBe(true);
      expect(n2.search.safety.negation.excluded).toEqual(['paracetamol', 'ibuprofene']);

      const n3 = executeExperimentalSearchPage('pas de paracétamol', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(n3.total).toBe(0);
      expect(n3.search.abstained).toBe(true);
      expect(n3.search.safety.negation.excluded).toEqual(['paracetamol']);

      const w = executeExperimentalSearchPage('douleur adulte 70 kg', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(w.search.parsed.dosage).toBeNull();
      expect(w.search.parsed.patient_weight).toBe('70 kg');
      expect(w.search.parsed.pediatric_inferred).toBe(false);

      const gPos = executeExperimentalSearchPage('médicaments contre-indiqués pendant la grossesse', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(gPos.total).toBe(0);
      expect(gPos.search.abstained).toBe(true);
      expect(gPos.search.safety.clinical_property.polarity).toBe('contraindication');

      const gNeg = executeExperimentalSearchPage('non contre-indiqué pendant la grossesse', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(gNeg.total).toBe(0);
      expect(gNeg.search.abstained).toBe(true);
      expect(gNeg.search.safety.clinical_property.polarity).toBe('negated_contraindication');

      const mix = executeExperimentalSearchPage('sans conservateur ni paraben', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(mix.total).toBe(0);
      expect(mix.search.abstained).toBe(true);
      expect(mix.search.parsed.verbatim_qualifiers).toEqual(['sans conservateur']);
      expect(mix.search.safety.negation.excluded).toEqual(['paraben']);

      const okQual = executeExperimentalSearchPage('sans sucre', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(okQual.search.abstained).toBe(false);
      expect(okQual.search.parsed.verbatim_qualifiers).toEqual(['sans sucre']);
    });
  });

  describe('executeExperimentalSearchPage (B1 structured vs B2 concepts)', () => {
    it('retrouve Doliprane 1 g comprimé, esoméprazole 40mg, Hexamidine collyre dès B1', () => {
      const doli = executeExperimentalSearchPage('Doliprane 1 g comprimé', 'auto', 1, 5, {}, { mode: 'structured' });
      expect(doli.results[0].cis).toBe('60234100');
      expect(doli.results[0].criteria_match).toEqual({ dosage: true, forme: true, voie: false });

      const esom = executeExperimentalSearchPage('esoméprazole 40mg', 'auto', 1, 5, {}, { mode: 'structured' });
      expect(esom.results[0].cis).toBe('66666666');

      const hex = executeExperimentalSearchPage('Hexamidine collyre', 'auto', 1, 5, {}, { mode: 'structured' });
      expect(hex.results[0].cis).toBe('63333333');
    });

    it('gère per os, spray, multi-substances SA/FT, générique et vet chien en mode concepts (B2)', () => {
      const mtx = executeExperimentalSearchPage('méthotrexate per os', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(mtx.results[0].cis).toBe('64444444');

      const cerulyse = executeExperimentalSearchPage('Cerulyse spray', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(cerulyse.results[0].cis).toBe('65555555');

      const augmentin = executeExperimentalSearchPage('amoxicilline acide clavulanique 1 g', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(augmentin.results[0].cis).toBe('66053338');

      const genTagamet = executeExperimentalSearchPage('générique tagamet', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(genTagamet.results[0].cis).toBe('67777772');

      const vetMelox = executeExperimentalSearchPage('meloxicam chien', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(vetMelox.results[0].type).toBe('medicament_veterinaire');
      expect(vetMelox.results[0].num).toBe('0000101');
    });

    it('préfère la mono-substance à dosage identique sur paracetamol 500 mg (B2)', () => {
      const res = executeExperimentalSearchPage('paracetamol 500 mg', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(res.results[0].cis).toBe('60234102');
    });

    it('ne retourne jamais de faux positif exact sur code inexistant ni de faux dosage sur impossible', () => {
      const missingCis = executeExperimentalSearchPage('99999999', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(missingCis.total).toBe(0);

      const impossibleDose = executeExperimentalSearchPage('doliprane 5000 mg', 'auto', 1, 5, {}, { mode: 'concepts' });
      if (impossibleDose.results.length > 0) {
        expect(impossibleDose.results[0].criteria_match.dosage).toBe(false);
      }
    });
  });

  describe('HTTP route opt-in /api/medicaments/search', () => {
    const app = express();
    app.use('/api/medicaments', medicamentRoutes);

    it('laisse le comportement par défaut (B0) intact et active mode=structured|concepts sur opt-in', async () => {
      const b0ViaHttp = await request(app).get('/api/medicaments/search?q=Doliprane%201%20g%20comprim%C3%A9');
      expect(b0ViaHttp.statusCode).toBe(200);
      expect(b0ViaHttp.body.search.mode).toBeUndefined();
      const b0Direct = executeHybridSearchPage('Doliprane 1 g comprimé', undefined, 1, 50, {});
      expect(b0ViaHttp.body.pagination.total).toBe(b0Direct.total);

      const b2ViaHttp = await request(app).get('/api/medicaments/search?q=Cerulyse%20spray&mode=concepts');
      expect(b2ViaHttp.statusCode).toBe(200);
      expect(b2ViaHttp.body.search.mode).toBe('concepts');
      expect(b2ViaHttp.body.data[0].cis).toBe('65555555');

      const badMode = await request(app).get('/api/medicaments/search?q=doliprane&mode=unknown');
      expect(badMode.statusCode).toBe(400);
    });

    it('§1 : applique la précédence stricte de forme=comprimé sur "amoxicilline sirop" sans fuite d’altFormeTokens', async () => {
      const parsed = parseStructuredQuery('amoxicilline sirop', { forme: 'comprimé' }, getTaxonomyVocab(), { useAliases: true });
      expect(parsed.effectiveCriteria.forme).toBe('comprimé');
      expect(parsed.effectiveCriteria.altFormeTokens).toEqual([]);
      expect(parsed.conflicts).toEqual([{ field: 'forme', explicit: 'comprimé', parsed: 'sirop' }]);

      const resp = await request(app).get('/api/medicaments/search?q=amoxicilline%20sirop&forme=comprim%C3%A9&mode=concepts');
      expect(resp.statusCode).toBe(200);
      expect(resp.body.data[0].cis).toBe('61111111');
      expect(resp.body.data[0].criteria_match).toEqual({ dosage: false, forme: true, voie: false });
      expect(resp.body.data[0].criteria_status).toEqual({
        dosage: 'not_requested',
        forme: 'matched',
        voie: 'not_requested'
      });

      const susp = resp.body.data.find((d) => d.cis === '61111112');
      expect(susp).toBeDefined();
      expect(susp.criteria_match.forme).toBe(false);
      expect(susp.criteria_status.forme).toBe('contradicted');
    });

    it('§1 : distingue correspondance exacte vs expansion de rappel (spray/collyre/partial) et vérifie evaluateEntityCriteria', async () => {
      const resp = await request(app).get('/api/medicaments/search?q=Cerulyse%20spray&mode=concepts&detail=summary');
      expect(resp.statusCode).toBe(200);
      expect(resp.body.data[0].cis).toBe('65555555');
      expect(resp.body.data[0].criteria_match.forme).toBe(false);
      expect(resp.body.data[0].criteria_status.forme).toBe('expanded');

      const ophtParsed = parseStructuredQuery('collyre yeux', {}, getTaxonomyVocab(), { useAliases: true });
      const ophtNoVoie = evaluateEntityCriteria(
        { denomDosages: [], compoDosages: [], normForme: 'collyre en solution', normVoie: '', normPresText: '', normDenom: 'collyre' },
        ophtParsed,
        { useAliases: true }
      );
      expect(ophtNoVoie.criteria_match.voie).toBe(false);
      expect(ophtNoVoie.criteria_status.voie).toBe('expanded');
    });

    it('§1 : rejette/marque unsupported sur voie="non orale" et étend le garde-fou grossesse/compatibilité via HTTP', async () => {
      const parsedNeg = parseStructuredQuery('amoxicilline', { voie: 'non orale' }, getTaxonomyVocab(), { useAliases: true });
      const directEval = evaluateEntityCriteria(
        { denomDosages: [], compoDosages: [], normForme: 'comprime', normVoie: 'orale', normPresText: '', normDenom: 'amoxicilline' },
        parsedNeg,
        { useAliases: true }
      );
      expect(directEval.criteria_match.voie).toBe(false);
      expect(directEval.criteria_status.voie).toBe('unsupported');

      for (const m of ['structured', 'concepts']) {
        const resNegVoie = await request(app).get(`/api/medicaments/search?q=amoxicilline&voie=non%20orale&mode=${m}`);
        expect(resNegVoie.statusCode).toBe(200);
        expect(resNegVoie.body.pagination.total).toBe(0);
        expect(resNegVoie.body.data).toEqual([]);
        expect(resNegVoie.body.search.abstained).toBe(true);
        expect(resNegVoie.body.search.safety.supported).toBe(false);
        expect(resNegVoie.body.search.safety.unsupported_criteria).toHaveLength(1);
        expect(resNegVoie.body.search.safety.unsupported_criteria[0].field).toBe('voie');
      }

      for (const query of ['ibuprofene compatible grossesse', 'ibuprofene enceinte', 'paracetamol allaitement']) {
        const resClin = await request(app).get(`/api/medicaments/search?q=${encodeURIComponent(query)}&mode=concepts`);
        expect(resClin.statusCode).toBe(200);
        expect(resClin.body.pagination.total).toBe(0);
        expect(resClin.body.search.abstained).toBe(true);
        expect(resClin.body.search.safety.clinical_property.detected).toBe(true);
      }
    });

    it('§5 : ne matérialise pas ConceptStore sur mode=structured ni sur requêtes rejetées / codes numériques, mais invalide après rechargement', () => {
      resetConceptStoreCache();
      expect(hasConceptStoreCached()).toBe(false);

      const b1 = executeExperimentalSearchPage('Doliprane 1 g comprimé', 'auto', 1, 5, {}, { mode: 'structured' });
      expect(b1.results[0].cis).toBe('60234100');
      expect(b1.results[0].criteria_status.dosage).toBe('matched');
      expect(hasConceptStoreCached()).toBe(false);

      const rejected = executeExperimentalSearchPage('ibuprofene enceinte', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(rejected.search.abstained).toBe(true);
      expect(hasConceptStoreCached()).toBe(false);

      const numCode = executeExperimentalSearchPage('60234100', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(numCode.results[0].cis).toBe('60234100');
      expect(hasConceptStoreCached()).toBe(false);

      const gen = executeExperimentalSearchPage('générique tagamet', 'auto', 1, 5, {}, { mode: 'concepts' });
      expect(gen.results[0].cis).toBe('67777772');
      expect(hasConceptStoreCached()).toBe(true);

      const store1 = getConceptStore();
      bdpmState.cisIndexes = { ...bdpmState.cisIndexes };
      const store2 = getConceptStore();
      expect(store2).not.toBe(store1);
    });
  });
});
