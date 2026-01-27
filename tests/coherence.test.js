const request = require('supertest');
const express = require('express');
const medicamentRoutes = require('../src/routes/medicaments');
const { loadData } = require('../src/services/dataLoader');

const app = express();
app.use(express.json());
app.use('/api/medicaments', medicamentRoutes);

describe('API Coherence Tests', () => {
    beforeAll(async () => {
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
        await loadData();
    }, 30000);

    const CLAMOXYL_CIS = '61155773';
    const PARACETAMOL_COMPO_NAME = 'PARACÉTAMOL';

    describe('Relationship: Specialite -> Groupe Generique', () => {
        it('should return generic group info for a known genericable drug', async () => {
            const res = await request(app).get(`/api/medicaments/specialites/${CLAMOXYL_CIS}`);
            expect(res.statusCode).toBe(200);
            expect(res.body.generiques).toBeDefined();
            expect(res.body.generiques).not.toBeNull();
            expect(res.body.generiques.id_groupe).toBe('145');
            expect(res.body.generiques.items.length).toBeGreaterThan(0);
        });
    });

    describe('Relationship: Groupe Generique -> Specialites', () => {
        it('should list all drugs in a group, and they should be accessible', async () => {
            const groupRes = await request(app).get('/api/medicaments/groupes-generiques?q=CLAMOXYL 125 mg/5 ml');
            expect(groupRes.statusCode).toBe(200);
            const drugsInGroup = groupRes.body.data.filter(item => item.id_groupe === '145');
            expect(drugsInGroup.length).toBeGreaterThan(1); // Should have at least princeps + 1 generic

            for (const item of drugsInGroup.slice(0, 3)) {
                const drugRes = await request(app).get(`/api/medicaments/specialites/${item.cis}`);
                expect(drugRes.statusCode).toBe(200);
                expect(drugRes.body.cis).toBe(item.cis);
            }
        });
    });


    describe('Precautions Coherence: Tramadol', () => {
        it('should have prescription restrictions for all Tramadol-containing drugs', async () => {
            // Get drugs containing Tramadol
            const composRes = await request(app).get('/api/medicaments/compositions?q=tramadol&limit=10');
            expect(composRes.body.data.length).toBeGreaterThan(0);

            const tramadolCIS = [...new Set(composRes.body.data.map(c => c.cis))];

            for (const cis of tramadolCIS.slice(0, 5)) {
                const drugRes = await request(app).get(`/api/medicaments/specialites/${cis}`);
                expect(drugRes.statusCode).toBe(200);

                const conditions = drugRes.body.conditions.map(c => c.condition);

                // All Tramadol drugs should have these precautions
                expect(conditions).toContain('prescription limitée à 12 semaines');
                expect(conditions).toContain('liste I');
                expect(conditions).toContain('prescription en toutes lettres sur ordonnance sécurisée');
            }
        });
    });

    describe('Generic Group Coherence', () => {
        it('should return full group info with all sibling drugs when a drug is in a generic group', async () => {
            const res = await request(app).get(`/api/medicaments/specialites/${CLAMOXYL_CIS}`);
            expect(res.statusCode).toBe(200);
            expect(res.body.generiques).toBeDefined();
            expect(res.body.generiques).not.toBeNull();

            const groupe = res.body.generiques;
            expect(groupe.id_groupe).toBe('145');
            expect(groupe.libelle_groupe).toContain('AMOXICILLINE');
            expect(groupe.items).toBeDefined();
            expect(groupe.items.length).toBeGreaterThan(1);

            // Verify the current drug is in the group
            expect(groupe.items.some(item => item.cis === CLAMOXYL_CIS)).toBe(true);
        });

        it('should return null for generiques when drug is not in any group', async () => {
            // DOLIPRANE is not in generic groups
            const res = await request(app).get('/api/medicaments/specialites/60234100');
            expect(res.statusCode).toBe(200);
            expect(res.body.generiques).toBeNull();
        });
    });
});
