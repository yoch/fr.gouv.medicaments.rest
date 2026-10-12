const request = require('supertest');
const express = require('express');
const medicaments = require('../src/routes/medicaments');
const veterinaires = require('../src/routes/veterinaires');

const app = express();
app.use('/api/medicaments', medicaments);
app.use('/api/veterinaires', veterinaires);

test.each([
  '/api/medicaments/search?q=doli&q=aspirine',
  '/api/medicaments/search?q=doli&source=human&source=mixed',
  '/api/medicaments/specialites?q=doli&q=aspirine',
  '/api/medicaments/disponibilite/alerts?q=doli&q=aspirine',
  '/api/veterinaires/medicaments?q=alpha&q=beta'
])('refuse un paramètre de recherche répété avec un JSON 400 : %s', async (url) => {
  const response = await request(app).get(url);
  expect(response.status).toBe(400);
  expect(response.body.error).toMatch(/chaîne unique/);
});

test.each(['/api/medicaments/search', '/api/medicaments/specialites', '/api/veterinaires/medicaments'])
('borne les requêtes avant la recherche floue : %s', async (url) => {
  const response = await request(app).get(url).query({ q: 'a'.repeat(513) });
  expect(response.status).toBe(400);
  expect(response.body.error).toContain('512');
  const boundary = await request(app).get(url).query({ q: 'a'.repeat(512) });
  expect(boundary.status).toBe(200);
});
