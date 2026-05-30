const path = require('path');

const fixtureDir = path.join(__dirname, 'fixtures/veterinaires');
process.env.VET_DATA_DIR = fixtureDir;
process.env.VET_PRODUCTS_FILE = 'amm-vet-fixture.xml';
process.env.VET_DICT_FILE = 'amm-vet-d-fixture.xml';

const request = require('supertest');
const express = require('express');
const medicamentRoutes = require('../src/routes/medicaments');
const veterinaireRoutes = require('../src/routes/veterinaires');
const { loadData } = require('../src/services/dataLoader');
const { loadVetData } = require('../src/services/vetDataLoader');
const { describeSlow } = require('./helpers/slowTests');

const app = express();
app.use(express.json());
app.use('/api/medicaments', medicamentRoutes);
app.use('/api/veterinaires', veterinaireRoutes);

describeSlow('API Vétérinaires ANMV', () => {
  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    await loadData();
    await loadVetData();
  }, 60000);

  describe('GET /api/veterinaires/medicaments', () => {
    it('trouve SULTRIAN par nom', async () => {
      const res = await request(app).get('/api/veterinaires/medicaments?q=sultrian&limit=5');
      expect(res.statusCode).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0].nom).toMatch(/SULTRIAN/i);
      expect(res.body.data[0].match_quality).toBeDefined();
    });
  });

  describe('GET /api/veterinaires/medicaments/:num', () => {
    it('retourne le détail SULTRIAN 100', async () => {
      const res = await request(app).get('/api/veterinaires/medicaments/0452300');
      expect(res.statusCode).toBe(200);
      expect(res.body.nom).toBe('SULTRIAN 100');
      expect(res.body.compositions.length).toBeGreaterThanOrEqual(2);
      expect(res.body.presentations.length).toBeGreaterThan(0);
      expect(res.body.especes).toEqual(expect.arrayContaining(['Chat', 'Chien']));
      expect(res.body.lien_rcp).toBe(
        'http://www.ircp.anmv.anses.fr/rcp.aspx?NomMedicament=SULTRIAN+100'
      );
      expect(res.body.maj_rcp).toBe('2025-11-07');
    });

    it('retourne 404 pour num inconnu', async () => {
      const res = await request(app).get('/api/veterinaires/medicaments/0000000');
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/veterinaires/compositions', () => {
    it('trouve par substance', async () => {
      const res = await request(app).get('/api/veterinaires/compositions?q=trimethoprime&limit=5');
      expect(res.statusCode).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0].substance).toMatch(/TRIMÉTHOPRIME/i);
    });
  });

  describe('Recherche hybride /api/medicaments/search', () => {
    it('source=veterinary retourne SULTRIAN avec agrégats', async () => {
      const res = await request(app).get('/api/medicaments/search?q=sultrian&source=veterinary&limit=5');
      expect(res.statusCode).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0].type).toBe('medicament_veterinaire');
      expect(res.body.data[0].nom).toMatch(/SULTRIAN/i);
      expect(res.body.data[0].presentations).toBeDefined();
      expect(res.body.data[0].compositions).toBeDefined();
      expect(res.body.search.source).toBe('veterinary');
      expect(res.body.search.referentiels.with_results).toContain('anmv');
    });

    it('source=human ne retourne pas SULTRIAN', async () => {
      const res = await request(app).get('/api/medicaments/search?q=sultrian&source=human&limit=5');
      expect(res.statusCode).toBe(200);
      expect(res.body.data.length).toBe(0);
      expect(res.body.search.source).toBe('human');
    });

    it('source=auto bascule sur ANMV si BDPM vide', async () => {
      const res = await request(app).get('/api/medicaments/search?q=sultrian&source=auto&limit=5');
      expect(res.statusCode).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0].type).toBe('medicament_veterinaire');
      expect(res.body.search.referentiels.with_results).toEqual(['anmv']);
    });

    it('source=auto bascule sur ANMV pour SULTRIAN 100 (absent BDPM)', async () => {
      const res = await request(app).get('/api/medicaments/search?q=SULTRIAN%20100&source=auto&limit=5');
      expect(res.statusCode).toBe(200);
      expect(res.body.pagination.total).toBeLessThan(10);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0].type).toBe('medicament_veterinaire');
      expect(res.body.data[0].nom).toBe('SULTRIAN 100');
      expect(res.body.data[0].match_quality).toBe('exact');
      expect(res.body.search.referentiels.with_results).toEqual(['anmv']);
      expect(res.body.search.referentiels.queried).toEqual(expect.arrayContaining(['bdpm', 'anmv']));
    });

    it('SULTRIAN 100 ne matche pas les spécialités BDPM (régression OR + 100)', async () => {
      const res = await request(app).get('/api/medicaments/specialites?q=SULTRIAN%20100&limit=5');
      expect(res.statusCode).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.pagination.total).toBe(0);
    });

    it('sans source explicite conserve search minimal si BDPM répond', async () => {
      const res = await request(app).get('/api/medicaments/search?q=paracetamol&limit=1');
      expect(res.statusCode).toBe(200);
      expect(res.body.search).toEqual({ query: 'paracetamol' });
      expect(res.body.data[0].type).toBe('medicament');
    });
  });
});
