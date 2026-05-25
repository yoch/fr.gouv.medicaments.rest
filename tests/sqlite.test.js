const request = require('supertest');
const express = require('express');
const medicamentRoutes = require('../src/routes/medicaments');
const { loadData } = require('../src/services/dataLoader');
const {
  buildBdpmDatabase,
  isDatabaseUsable,
  getDefaultDbPath
} = require('../src/services/bdpmDatabase');

const app = express();
app.use(express.json());
app.use('/api/medicaments', medicamentRoutes);

describe('SQLite BDPM integration', () => {
  const previousBackend = process.env.SEARCH_BACKEND;

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    buildBdpmDatabase();
    await loadData();
  }, 60000);

  afterAll(() => {
    if (previousBackend == null) delete process.env.SEARCH_BACKEND;
    else process.env.SEARCH_BACKEND = previousBackend;
  });

  it('builds a usable SQLite database', () => {
    const dbPath = getDefaultDbPath();
    expect(isDatabaseUsable(dbPath)).toBe(true);
  });

  it('supports sqlite_fts backend for fuzzy text search', async () => {
    process.env.SEARCH_BACKEND = 'sqlite_fts';
    process.env.DATA_LOAD_PROFILE = 'full';
    const res = await request(app).get('/api/medicaments/specialites?q=dolipranr&limit=1');
    expect(res.statusCode).toBe(200);
    expect(res.body.data[0].denomination).toMatch(/DOLIPRANE/i);
    expect(res.body.data[0].match_quality).toBe('fuzzy');
  });

  it('supports sqlite_fts backend for exact numeric search', async () => {
    process.env.SEARCH_BACKEND = 'sqlite_fts';
    const res = await request(app).get('/api/medicaments/specialites?q=60234100&limit=1');
    expect(res.statusCode).toBe(200);
    expect(res.body.data[0].cis).toBe('60234100');
    expect(res.body.data[0].match_quality).toBe('exact');
  });

  it('supports compare mode while returning MiniSearch payload format', async () => {
    process.env.SEARCH_BACKEND = 'compare';
    const res = await request(app).get('/api/medicaments/specialites?q=paracetamol&limit=3');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0].match_quality).toBeDefined();
  });
});
