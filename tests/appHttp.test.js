'use strict';

const request = require('supertest');
const { describeSlow } = require('./helpers/slowTests');

describeSlow('Application HTTP', () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
    jest.resetModules();
  });

  function createFreshApp(overrides = {}) {
    jest.resetModules();
    process.env = { ...env, ...overrides };
    return require('../src/app').createApp();
  }

  it('expose /health, /config et /api-docs.json', async () => {
    const app = createFreshApp();

    const health = await request(app).get('/health');
    expect(health.statusCode).toBe(200);
    expect(health.body.status).toBe('ok');
    expect(health.body.memory.rss_mb).toEqual(expect.any(Number));

    const runtimeConfig = await request(app).get('/config');
    expect(runtimeConfig.statusCode).toBe(200);
    expect(runtimeConfig.body.version).toMatch(/^\d+\.\d+\.\d+$/);

    const swagger = await request(app).get('/api-docs.json');
    expect(swagger.statusCode).toBe(200);
    expect(swagger.body.openapi).toBe('3.0.0');
    expect(swagger.body.info.version).toBe(runtimeConfig.body.version);
  });

  it('retourne les erreurs HTTP publiques attendues', async () => {
    const app = createFreshApp({ LOAD_HAS_AVIS: 'false' });

    const searchWithoutQuery = await request(app).get('/api/medicaments/search');
    expect(searchWithoutQuery.statusCode).toBe(400);
    expect(searchWithoutQuery.body.error).toMatch(/q/);

    const missingVet = await request(app).get('/api/veterinaires/medicaments/0000000');
    expect(missingVet.statusCode).toBe(404);

    const disabledHas = await request(app).get('/api/medicaments/avis-smr');
    expect(disabledHas.statusCode).toBe(410);
  });

  it('normalise la pagination invalide', async () => {
    const app = createFreshApp();

    const res = await request(app).get('/api/medicaments/specialites?page=-10&limit=999999');
    expect(res.statusCode).toBe(200);
    expect(res.body.pagination.page).toBe(1);
    expect(res.body.pagination.limit).toBe(1000);
  });
});
