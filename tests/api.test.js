const request = require('supertest');
const express = require('express');
const medicamentRoutes = require('../src/routes/medicaments');
const { loadData } = require('../src/services/dataLoader');
const { describeSlow } = require('./helpers/slowTests');
const { DOLIPRANE_CIS, DOLIPRANE_CIP13, DOLIPRANE_CIP7 } = require('./fixtures/cis-cip-samples');
const { isPlausibleCip13 } = require('./helpers/bdpmPresentation');

const app = express();
app.use(express.json());
app.use('/api/medicaments', medicamentRoutes);

describeSlow('API Medicaments', () => {
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
    }, 120000);

    describe('GET /api/medicaments/specialites', () => {
        it('should return a list of specialites', async () => {
            const res = await request(app).get('/api/medicaments/specialites?limit=5');
            expect(res.statusCode).toEqual(200);
            expect(res.body.data).toBeInstanceOf(Array);
            expect(res.body.data.length).toBe(5);
            expect(res.body.pagination).toBeDefined();
            expect(res.body.data[0].url_bdpm).toBe(
                `https://base-donnees-publique.medicaments.gouv.fr/medicament/${res.body.data[0].cis}/extrait`
            );
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
            expect(res.body.data[0].match_quality).toBe('fuzzy');
        });

        it('should mark prefix search on denomination', async () => {
            const res = await request(app).get('/api/medicaments/specialites?q=doli&limit=1');
            expect(res.statusCode).toEqual(200);
            expect(res.body.data[0].match_quality).toBe('prefix');
        });

        it('should perform exact numerical match (CIS)', async () => {
            const res = await request(app).get('/api/medicaments/specialites?q=60234100&limit=1');
            expect(res.statusCode).toEqual(200);
            expect(res.body.data[0].cis).toBe('60234100');
            expect(res.body.data[0].match_quality).toBe('exact');
        });

        it('should not match human specialites on SULTRIAN 100 alone', async () => {
            const res = await request(app).get('/api/medicaments/specialites?q=SULTRIAN%20100&limit=5');
            expect(res.statusCode).toEqual(200);
            expect(res.body.pagination.total).toBe(0);
        });
    });

    describe('GET /api/medicaments/specialites/:cis', () => {
        it('should return details for a specific CIS', async () => {
            // Use a known CIS, e.g. from the previous search or hardcoded if stable
            // 60234100 is DOLIPRANE 1000 mg
            const res = await request(app).get('/api/medicaments/specialites/60234100');
            expect(res.statusCode).toEqual(200);
            expect(res.body.cis).toBe('60234100');
            expect(res.body.url_bdpm).toBe(
                'https://base-donnees-publique.medicaments.gouv.fr/medicament/60234100/extrait'
            );
            expect(res.body.presentations).toBeDefined();
            expect(res.body.compositions).toBeDefined();
        });

        it('expose des présentations avec CIP13 valide (non régression schéma)', async () => {
            const res = await request(app).get(`/api/medicaments/specialites/${DOLIPRANE_CIS}`);
            expect(res.statusCode).toEqual(200);
            const pres = res.body.presentations.find((p) => p.cip7 === DOLIPRANE_CIP7);
            expect(pres).toBeDefined();
            expect(isPlausibleCip13(pres.cip13)).toBe(true);
            expect(pres.cip13).toBe(DOLIPRANE_CIP13);
            expect(pres.taux_remboursement).toMatch(/%$/);
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

        it('should expose search query and match_quality on global search', async () => {
            const res = await request(app).get('/api/medicaments/search?q=paracetamol&limit=5');
            expect(res.statusCode).toEqual(200);
            expect(res.body.search).toEqual({ query: 'paracetamol' });
            expect(res.body.data[0].match_quality).toBeDefined();
        });

        it('detail=summary returns substances and omits full compositions', async () => {
            const res = await request(app).get(
                '/api/medicaments/search?q=doliprane&limit=1&detail=summary'
            );
            expect(res.statusCode).toEqual(200);
            const item = res.body.data[0];
            expect(item.substances).toBeInstanceOf(Array);
            expect(item.substances.length).toBeGreaterThan(0);
            expect(item.compositions).toBeUndefined();
            expect(item.type_amm).toBeUndefined();
            expect(item.presentations_count).toBeGreaterThan(0);
            if (item.presentations.length > 0) {
                expect(item.presentations[0].libelle).toBeDefined();
                expect(item.presentations[0].cis).toBeUndefined();
            }
        });

        it('detail=full preserves compositions (retrocompat)', async () => {
            const res = await request(app).get(
                '/api/medicaments/search?q=doliprane&limit=1&detail=full'
            );
            expect(res.statusCode).toEqual(200);
            expect(res.body.data[0].compositions).toBeInstanceOf(Array);
            expect(res.body.data[0].compositions.length).toBeGreaterThan(0);
        });

        it('format=markdown returns text/markdown body', async () => {
            const res = await request(app).get(
                '/api/medicaments/search?q=doliprane&limit=2&format=markdown&detail=summary'
            );
            expect(res.statusCode).toEqual(200);
            expect(res.headers['content-type']).toMatch(/text\/markdown/);
            expect(res.text).toContain('# BDPM — recherche « doliprane »');
            expect(res.text).toContain('CIS');
            expect(res.text).toContain('Substances:');
            expect(res.text).toContain('- Présentations (');
            expect(res.text).toMatch(/\n  - /);
        });

        it('CIS search exposes match_via', async () => {
            const res = await request(app).get(
                '/api/medicaments/search?q=60234100&limit=1&detail=summary'
            );
            expect(res.statusCode).toEqual(200);
            expect(res.body.data[0].match_quality).toBe('exact');
            expect(res.body.data[0].match_via).toBe('cis');
        });

        it('prefix brand search exposes match_via denomination', async () => {
            const res = await request(app).get(
                '/api/medicaments/search?q=doliprane&limit=1&detail=summary'
            );
            expect(res.statusCode).toEqual(200);
            expect(res.body.data[0].match_quality).toBe('prefix');
            expect(res.body.data[0].match_via).toBe('denomination');
        });

        it('substance query can match via composition', async () => {
            const res = await request(app).get(
                '/api/medicaments/search?q=paracetamol&limit=20&detail=summary'
            );
            expect(res.statusCode).toEqual(200);
            const viaComposition = res.body.data.filter((d) => d.match_via === 'composition');
            expect(viaComposition.length).toBeGreaterThan(0);
            expect(viaComposition[0].substances?.length).toBeGreaterThan(0);
        });

        it('pagine la recherche globale sans changer total ni ordre', async () => {
            const all = await request(app).get(
                '/api/medicaments/search?q=paracetamol&source=human&limit=4&detail=summary'
            );
            const page1 = await request(app).get(
                '/api/medicaments/search?q=paracetamol&source=human&limit=2&page=1&detail=summary'
            );
            const page2 = await request(app).get(
                '/api/medicaments/search?q=paracetamol&source=human&limit=2&page=2&detail=summary'
            );

            expect(page1.statusCode).toBe(200);
            expect(page2.statusCode).toBe(200);
            expect(page1.body.pagination.total).toBe(all.body.pagination.total);
            expect(page2.body.pagination.total).toBe(all.body.pagination.total);

            const firstFour = all.body.data.map((item) => item.cis);
            expect([...page1.body.data, ...page2.body.data].map((item) => item.cis)).toEqual(firstFour);
        });

        describe('critères structurés dosage/forme/voie (scoring non destructif)', () => {
            it('dosage+forme remonte le bon variant en tête et expose criteria_match', async () => {
                const res = await request(app).get(
                    '/api/medicaments/search?q=doliprane&limit=5&detail=summary&dosage=1%20gramme&forme=comprim%C3%A9'
                );
                expect(res.statusCode).toBe(200);
                const top = res.body.data[0];
                expect(top.denomination).toMatch(/1000 mg/i);
                expect(top.denomination).toMatch(/comprim/i);
                expect(top.criteria_match).toEqual({ dosage: true, forme: true, voie: false });
                expect(res.body.search.criteria).toEqual({ dosage: '1 gramme', forme: 'comprimé' });
            });

            it('ne filtre pas : le total est identique avec ou sans critères', async () => {
                const base = await request(app).get(
                    '/api/medicaments/search?q=doliprane&limit=5&detail=summary'
                );
                const withCriteria = await request(app).get(
                    '/api/medicaments/search?q=doliprane&limit=5&detail=summary&dosage=1%20gramme&forme=comprim%C3%A9'
                );
                expect(withCriteria.body.pagination.total).toBe(base.body.pagination.total);
            });

            it("préserve l'ordre initial si aucun critère ne matche", async () => {
                const base = await request(app).get(
                    '/api/medicaments/search?q=doliprane&limit=5&detail=summary'
                );
                const withCriteria = await request(app).get(
                    '/api/medicaments/search?q=doliprane&limit=5&detail=summary&dosage=123%20mg&forme=xyzforme'
                );
                expect(withCriteria.statusCode).toBe(200);
                expect(withCriteria.body.data.map((item) => item.cis))
                    .toEqual(base.body.data.map((item) => item.cis));
            });

            it('ne remonte pas un match plus faible : les exact restent en tête (forme=suppositoire)', async () => {
                const res = await request(app).get(
                    '/api/medicaments/search?q=paracetamol&limit=6&detail=summary&forme=suppositoire'
                );
                expect(res.statusCode).toBe(200);
                expect(res.body.data[0].match_quality).toBe('exact');
                const forme = res.body.data[0].forme_pharma || '';
                expect(forme.toLowerCase()).toContain('suppositoire');
            });

            it('format=markdown affiche la ligne Critères', async () => {
                const res = await request(app).get(
                    '/api/medicaments/search?q=doliprane&limit=3&format=markdown&dosage=1%20g&forme=comprim%C3%A9'
                );
                expect(res.statusCode).toBe(200);
                expect(res.text).toMatch(/- Critères: .*✓/);
            });
        });
    });

    describe('GET /api/medicaments/presentations', () => {
        it('retrouve une présentation par CIP13 indexé', async () => {
            const res = await request(app).get(
                `/api/medicaments/presentations?q=${DOLIPRANE_CIP13}&limit=1`
            );
            expect(res.statusCode).toEqual(200);
            expect(res.body.data.length).toBe(1);
            expect(res.body.data[0].cip13).toBe(DOLIPRANE_CIP13);
            expect(isPlausibleCip13(res.body.data[0].cip13)).toBe(true);
        });

        it('pagine les recherches de liste avec total stable', async () => {
            const all = await request(app).get('/api/medicaments/presentations?q=doliprane&limit=4');
            const page1 = await request(app).get('/api/medicaments/presentations?q=doliprane&limit=2&page=1');
            const page2 = await request(app).get('/api/medicaments/presentations?q=doliprane&limit=2&page=2');

            expect(page1.statusCode).toBe(200);
            expect(page2.statusCode).toBe(200);
            expect(page1.body.pagination.total).toBe(all.body.pagination.total);
            expect(page2.body.pagination.total).toBe(all.body.pagination.total);
            expect([...page1.body.data, ...page2.body.data].map((item) => item.cip13)).toEqual(
                all.body.data.map((item) => item.cip13)
            );
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

    describe('GET /api/medicaments/disponibilite/alerts', () => {
        it('returns MVP-shaped alerts and detail by id', async () => {
            const list = await request(app).get('/api/medicaments/disponibilite/alerts?limit=5');
            expect(list.statusCode).toEqual(200);
            expect(list.body).toHaveProperty('generated_at');
            expect(list.body).toHaveProperty('alerts');
            expect(Array.isArray(list.body.alerts)).toBe(true);
            if (list.body.alerts.length === 0) return;

            const alert = list.body.alerts[0];
            expect(alert).toHaveProperty('id');
            expect(alert).toHaveProperty('status');
            expect(alert).toHaveProperty('cis');
            expect(alert).not.toHaveProperty('medical_domain');

            const detail = await request(app).get(
                `/api/medicaments/disponibilite/alerts/${encodeURIComponent(alert.id)}`
            );
            expect(detail.statusCode).toEqual(200);
            expect(detail.body.alert_id).toBe(alert.id);
            expect(detail.body.source).toBe('bdpm');
            expect(detail.body).toHaveProperty('ruptures');
            expect(Array.isArray(detail.body.ruptures)).toBe(true);

            if (alert.lien_ansm || alert.detail_url) {
                const byLien = await request(app).get(
                    `/api/medicaments/disponibilite?lien_ansm=${encodeURIComponent(alert.detail_url)}&limit=5`
                );
                expect(byLien.statusCode).toEqual(200);
                expect(byLien.body.data.length).toBeGreaterThan(0);
            }

            const specialite = await request(app).get(`/api/medicaments/specialites/${alert.cis}`);
            if (specialite.statusCode === 200) {
                expect(specialite.body).toHaveProperty('ruptures');
                expect(Array.isArray(specialite.body.ruptures)).toBe(true);
            }
        });

        it('returns 404 for unknown alert id', async () => {
            const res = await request(app).get(
                '/api/medicaments/disponibilite/alerts/000000000000'
            );
            expect(res.statusCode).toEqual(404);
        });
    });

});
