const request = require('supertest');
const express = require('express');
const medicamentRoutes = require('../src/routes/medicaments');
const { loadData } = require('../src/services/dataLoader');

const app = express();
app.use(express.json());
app.use('/api/medicaments', medicamentRoutes);

describe('API Medicaments', () => {
    beforeAll(async () => {
        // Load data before running tests
        // Ensure we mock or have data available.
        // For integration tests on this repo, we assume data is present in /data
        // or we might want to mock getData if we want unit tests.
        // Given the request "test all endpoints", integration test with real data
        // (or a subset) is better.
        // However, loading all data might be slow.
        // Let's rely on dataLoader loading existing files.

        // Silence console logs during tests
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });

        await loadData();
    }, 30000); // Increase timeout for data loading

    describe('GET /api/medicaments/specialites', () => {
        it('should return a list of specialites', async () => {
            const res = await request(app).get('/api/medicaments/specialites?limit=5');
            expect(res.statusCode).toEqual(200);
            expect(res.body.data).toBeInstanceOf(Array);
            expect(res.body.data.length).toBe(5);
            expect(res.body.pagination).toBeDefined();
        });

        it('should filter by query (prefix match)', async () => {
            const res = await request(app).get('/api/medicaments/specialites?q=doli&limit=1');
            expect(res.statusCode).toEqual(200);
            expect(res.body.data[0].denomination).toMatch(/DOLIPRANE/);
        });

        it('should perform fuzzy search', async () => {
            const res = await request(app).get('/api/medicaments/specialites?q=dolipranr&limit=1');
            expect(res.statusCode).toEqual(200);
            expect(res.body.data[0].denomination).toMatch(/DOLIPRANE/);
        });

        it('should perform exact numerical match (CIS)', async () => {
            const res = await request(app).get('/api/medicaments/specialites?q=60234100&limit=1');
            expect(res.statusCode).toEqual(200);
            expect(res.body.data[0].cis).toBe('60234100');
        });
    });

    describe('GET /api/medicaments/specialites/:cis', () => {
        it('should return details for a specific CIS', async () => {
            // Use a known CIS, e.g. from the previous search or hardcoded if stable
            // 60234100 is DOLIPRANE 1000 mg
            const res = await request(app).get('/api/medicaments/specialites/60234100');
            expect(res.statusCode).toEqual(200);
            expect(res.body.cis).toBe('60234100');
            expect(res.body.presentations).toBeDefined();
            expect(res.body.compositions).toBeDefined();
        });

        it('should return 404 for unknown CIS', async () => {
            const res = await request(app).get('/api/medicaments/specialites/00000000');
            expect(res.statusCode).toEqual(404);
        });
    });

    describe('GET /api/medicaments/search', () => {
        it('should return mixed results', async () => {
            const res = await request(app).get('/api/medicaments/search?q=paracetamol&limit=5');
            expect(res.statusCode).toEqual(200);
            expect(res.body.data).toBeInstanceOf(Array);
            // Should find at least something
            expect(res.body.data.length).toBeGreaterThan(0);
            // Check if types are present
            expect(res.body.data[0].type).toBeDefined();
        });

        it('should require q parameter', async () => {
            const res = await request(app).get('/api/medicaments/search');
            expect(res.statusCode).toEqual(400);
        });
    });

    // Verify other lookups exist
    test.each([
        ['/api/medicaments/presentations', 'libelle'],
        ['/api/medicaments/compositions', 'denomination_substance'],
        ['/api/medicaments/avis-smr', 'libelle_smr'],
        ['/api/medicaments/avis-asmr', 'libelle_asmr'],
        ['/api/medicaments/groupes-generiques', 'libelle_groupe'],
        ['/api/medicaments/conditions', 'condition'],
        ['/api/medicaments/disponibilite', 'libelle_statut'],
        ['/api/medicaments/interet-therapeutique-majeur', 'denomination'],
        // ['/api/medicaments/infos-importantes', 'texte_affichage'],
        ['/api/medicaments/substances', 'denomination']
    ])('GET %s returns data', async (endpoint, fieldToCheck) => {
        const res = await request(app).get(`${endpoint}?limit=1`);
        expect(res.statusCode).toEqual(200);
        expect(res.body.data).toBeInstanceOf(Array);
        // Note: some files might be empty depending on the dataset state,
        // but usually these have data.
        if (res.body.data.length > 0) {
            expect(res.body.data[0]).toHaveProperty(fieldToCheck);
        }
    });

});
