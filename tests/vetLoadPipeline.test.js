'use strict';

const path = require('path');

describe('pipeline ANMV fixture', () => {
  const env = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...env,
      VET_DATA_DIR: path.join(__dirname, 'fixtures/veterinaires'),
      VET_PRODUCTS_FILE: 'amm-vet-fixture.xml',
      VET_DICT_FILE: 'amm-vet-d-fixture.xml'
    };
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('mappe SULTRIAN 100 sans décaler les champs vétérinaires', async () => {
    const {
      loadVetData,
      getMedicamentByNum,
      getMedicamentSearchRecordByNum,
      getRelatedByNum
    } = require('../src/services/vetDataLoader');

    await loadVetData();

    expect(getMedicamentByNum('0452300')).toEqual({
      num: '0452300',
      nom: 'SULTRIAN 100',
      num_amm: 'FR/V/9222645 4/1980',
      date_amm: '01/12/1980',
      titulaire: '1659',
      forme_pharmaceutique: 'Comprimé',
      statut_amm: 'AMM illimitée',
      codes_atcvet: ['QJ01EW11'],
      especes: ['Chat', 'Chien'],
      maj_rcp: '2025-11-07',
      lien_rcp: 'http://www.ircp.anmv.anses.fr/rcp.aspx?NomMedicament=SULTRIAN+100'
    });

    expect(getRelatedByNum('compositions', '0452300')).toEqual(
      expect.arrayContaining([
        { num: '0452300', substance: 'Sulfaméthoxazole', quantite: '100', unite: 'mg' },
        { num: '0452300', substance: 'Triméthoprime', quantite: '20', unite: 'mg' }
      ])
    );
    expect(getRelatedByNum('presentations', '0452300')[0]).toMatchObject({
      num: '0452300',
      libelle: 'Boîte de 1 plaquette de 16 comprimés',
      gtin: '03660176013166'
    });
    expect(getRelatedByNum('temps_attente', '0452300')).toEqual([]);
    expect(getMedicamentSearchRecordByNum('0452300')).toEqual({
      denomination: 'SULTRIAN 100',
      forme_pharmaceutique: 'Comprimé',
      voies_admin: ''
    });
  });
});
