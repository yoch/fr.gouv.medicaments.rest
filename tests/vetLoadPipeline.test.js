'use strict';

const fs = require('fs');
const os = require('os');
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

  it('ferme le descripteur de header même si readSync échoue', async () => {
    const originalOpen = fs.openSync;
    const originalRead = fs.readSync;
    let headerFd;
    jest.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      const fd = originalOpen(file, ...args);
      if (String(file).endsWith('amm-vet-fixture.xml')) headerFd = fd;
      return fd;
    });
    jest.spyOn(fs, 'readSync').mockImplementation((fd, ...args) => {
      if (fd === headerFd) throw new Error('header read failed');
      return originalRead(fd, ...args);
    });
    const close = jest.spyOn(fs, 'closeSync');
    await require('../src/services/vetDataLoader').loadVetData();
    expect(headerFd).toEqual(expect.any(Number));
    expect(close).toHaveBeenCalledWith(headerFd);
    expect(() => fs.fstatSync(headerFd)).toThrow();
  });

  async function withProductsXml(productLines, run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vet-products-'));
    try {
      fs.copyFileSync(
        path.join(__dirname, 'fixtures/veterinaires/amm-vet-d-fixture.xml'),
        path.join(dir, 'amm-vet-d-fixture.xml')
      );
      fs.writeFileSync(
        path.join(dir, 'products.xml'),
        ['<medicinal-product-group>', ...productLines, '</medicinal-product-group>'].join('\n')
      );
      process.env.VET_DATA_DIR = dir;
      process.env.VET_PRODUCTS_FILE = 'products.xml';
      await run(require('../src/services/vetDataLoader'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('expose les temps d’attente de 0 et ignore les voies sans qte-ta', async () => {
    await withProductsXml([
      '<medicinal-product><num>0999999</num><nom>TEST TA</nom>',
      '<voie-administration>',
      '<voie-admin><term-va>9704</term-va><term-esp>5</term-esp><term-denr>14</term-denr><qte-ta>0</qte-ta><term-unite>22</term-unite></voie-admin>',
      '<voie-admin><term-va>9704</term-va><term-esp>5</term-esp><term-denr>15</term-denr><qte-ta>14</qte-ta><term-unite>21</term-unite></voie-admin>',
      '<voie-admin><term-va>9704</term-va><term-esp>5</term-esp></voie-admin>',
      '</voie-administration>',
      '</medicinal-product>'
    ], async ({ loadVetData, getRelatedByNum }) => {
      await loadVetData();
      expect(getRelatedByNum('temps_attente', '0999999').map((e) => e.quantite)).toEqual(['0', '14']);
    });
  });

  it('ignore un produit au XML invalide sans interrompre le chargement', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await withProductsXml([
      '<medicinal-product><num>0999998</num><nom>A & B</nom></medicinal-product>',
      '<medicinal-product><num>0999999</num><nom>VALIDE</nom></medicinal-product>'
    ], async ({ loadVetData, getMedicamentByNum }) => {
      await loadVetData();
      expect(getMedicamentByNum('0999998')).toBeUndefined();
      expect(getMedicamentByNum('0999999')).toMatchObject({ nom: 'VALIDE' });
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 produit(s) vétérinaire(s) au XML invalide ignoré(s) : 0999998'));
  });

  it('remplace le pool à chaque génération et partage les appels simultanés', async () => {
    await withProductsXml([], async ({ loadVetData, getMedicamentByNum }) => {
      const { internPoolSize } = require('../src/utils/stringPool');
      for (let cycle = 0; cycle < 3; cycle++) {
        fs.writeFileSync(path.join(process.env.VET_DATA_DIR, 'products.xml'),
          `<root><medicinal-product><num>1</num><nom>TEST</nom><maj-rcp>DATE_${cycle}</maj-rcp><modele-destine-vente><mod-vte><lib-mod>LIBELLE_${cycle}</lib-mod></mod-vte></modele-destine-vente></medicinal-product></root>`);
        const first = loadVetData();
        expect(loadVetData()).toBe(first);
        await first;
        expect(internPoolSize()).toBe(2);
        expect(getMedicamentByNum('1').maj_rcp).toBe(`DATE_${cycle}`);
      }
    });
  });

  it('rejette un dictionnaire sans tokens qui dépasse la limite et ferme son flux', async () => {
    await withProductsXml([], async ({ loadVetData }) => {
      fs.writeFileSync(path.join(process.env.VET_DATA_DIR, 'amm-vet-d-fixture.xml'), 'x'.repeat(4 * 1024 * 1024 + 1));
      const original = fs.createReadStream;
      let reader;
      jest.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
        reader = original(...args);
        return reader;
      });
      await expect(loadVetData()).rejects.toThrow('token incomplet supérieur');
      expect(reader.destroyed).toBe(true);
      expect(require('../src/utils/stringPool').internPoolSize()).toBe(0);
    });
  });
});
