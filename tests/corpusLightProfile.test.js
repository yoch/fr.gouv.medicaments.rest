'use strict';

const { Presentation, Composition } = require('../src/models/bdpm');
const { MedicamentVet } = require('../src/models/vet');
const {
  DOLIPRANE_8CP_TSV,
  DOLIPRANE_8CP_JSON,
  DOLIPRANE_CIP13
} = require('./fixtures/cis-cip-samples');
const { parsePresentationTsv, isPlausibleCip13 } = require('./helpers/bdpmPresentation');
const {
  isCorpusLightProfile,
  presentationIndexFields,
  omitStoredFieldsFor
} = require('../src/utils/corpusLightProfile');

describe('corpusLightProfile', () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
    jest.resetModules();
  });

  function reloadModules() {
    jest.resetModules();
    return {
      light: require('../src/utils/corpusLightProfile'),
      Presentation: require('../src/models/bdpm').Presentation,
      Composition: require('../src/models/bdpm').Composition,
      MedicamentVet: require('../src/models/vet').MedicamentVet,
      parsePresentationTsv: require('./helpers/bdpmPresentation').parsePresentationTsv,
      isPlausibleCip13: require('./helpers/bdpmPresentation').isPlausibleCip13
    };
  }

  it('est inactif par défaut (variable absente)', () => {
    delete process.env.CORPUS_LIGHT_PROFILE;
    const { light } = reloadModules();
    expect(light.isCorpusLightProfile()).toBe(false);
    expect(light.omitStoredFieldsFor('presentations')).toEqual([]);
  });

  it('est indépendant de LOAD_HAS_AVIS', () => {
    process.env.LOAD_HAS_AVIS = 'false';
    delete process.env.CORPUS_LIGHT_PROFILE;
    const { light: off } = reloadModules();
    expect(off.isCorpusLightProfile()).toBe(false);

    process.env.CORPUS_LIGHT_PROFILE = 'true';
    const { light: on } = reloadModules();
    expect(on.isCorpusLightProfile()).toBe(true);
  });

  it('conserve le CIP13 correct tout en omettant les champs lourds', () => {
    process.env.CORPUS_LIGHT_PROFILE = 'true';
    const { Presentation: Pres, parsePresentationTsv: parseTsv, isPlausibleCip13: okCip13 } =
      reloadModules();
    const row = parseTsv(DOLIPRANE_8CP_TSV);
    const json = Pres.fromCsv(row).toJSON();

    expect(okCip13(json.cip13)).toBe(true);
    expect(json.cip13).toBe(DOLIPRANE_CIP13);
    expect(json.indications).toBeUndefined();
    expect(json.honoraires).toBeUndefined();
    expect(json.taux_remboursement).toBe(DOLIPRANE_8CP_JSON.taux_remboursement);
  });

  it('n’indexe pas indications en profil allégé', () => {
    process.env.CORPUS_LIGHT_PROFILE = 'true';
    const { light } = reloadModules();
    expect(light.presentationIndexFields()).toEqual(['cis', 'cip7', 'cip13', 'libelle']);
  });

  it('omet reference_dosage et numero_ordre des compositions en profil allégé', () => {
    process.env.CORPUS_LIGHT_PROFILE = 'true';
    const { Composition: Comp } = reloadModules();
    const json = Comp.fromCsv({
      cis: '1',
      designation_element: 'cp',
      code_substance: '02202',
      denomination_substance: 'PARACÉTAMOL',
      dosage: '1000 mg',
      reference_dosage: 'un comprimé',
      nature_composant: 'SA',
      numero_ordre: '1'
    }).toJSON();

    expect(json.nature_composant).toBe('SA');
    expect(json.reference_dosage).toBeUndefined();
    expect(json.numero_ordre).toBeUndefined();
  });

  it('omet num_amm et date_amm des médicaments vet en profil allégé', () => {
    process.env.CORPUS_LIGHT_PROFILE = 'true';
    const { MedicamentVet: MedVet } = reloadModules();
    const json = MedVet.fromCsv({
      num: '1234567',
      nom: 'TEST',
      num_amm: 'FR/V/0123',
      date_amm: '01/01/2020',
      titulaire: 'LAB',
      forme_pharmaceutique: 'sol',
      statut_amm: 'active',
      codes_atcvet: '',
      especes: '',
      maj_rcp: ''
    }).toJSON();

    expect(json.nom).toBe('TEST');
    expect(json.num_amm).toBeUndefined();
    expect(json.date_amm).toBeUndefined();
  });
});

describe('corpusLightProfile (env par défaut des tests)', () => {
  it('expose omitStoredFieldsFor sans planter', () => {
    expect(Array.isArray(omitStoredFieldsFor('presentations'))).toBe(true);
    expect(Array.isArray(presentationIndexFields())).toBe(true);
    expect(typeof isCorpusLightProfile()).toBe('boolean');
  });
});
