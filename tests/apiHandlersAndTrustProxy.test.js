'use strict';

const request = require('supertest');

describe('apiHandlers et TRUST_PROXY', () => {
  const savedEnv = { ...process.env };
  const apps = [];

  afterEach(() => {
    while (apps.length > 0) {
      const app = apps.pop();
      app.locals?.dispose?.();
    }
    jest.dontMock('../src/utils/ansmUrl.mts');
    process.env = { ...savedEnv };
    jest.resetModules();
  });

  test('TRUST_PROXY pilote app.set("trust proxy", 1) et le rate-limit par IP proxyée', async () => {
    jest.resetModules();
    const defaultConfig = require('../src/config.mts').default;
    expect(defaultConfig.trustProxy).toBe(false);

    process.env.TRUST_PROXY = 'true';
    process.env.ENABLE_RATE_LIMIT = 'true';
    process.env.RATE_LIMIT_MAX = '2';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    jest.resetModules();

    const proxiedConfig = require('../src/config.mts').default;
    expect(proxiedConfig.trustProxy).toBe(true);

    const app = require('../src/app.mts').createApp();
    apps.push(app);
    expect(app.get('trust proxy')).toBe(1);

    const r1 = await request(app).get('/config').set('X-Forwarded-For', '203.0.113.10');
    expect(r1.status).toBe(200);
    expect(r1.headers['ratelimit-limit']).toBe('2');
    expect(r1.headers['ratelimit-remaining']).toBe('1');

    const r2 = await request(app).get('/config').set('X-Forwarded-For', '203.0.113.10');
    expect(r2.status).toBe(200);
    expect(r2.headers['ratelimit-remaining']).toBe('0');

    const r3 = await request(app).get('/config').set('X-Forwarded-For', '203.0.113.10');
    expect(r3.status).toBe(429);

    const rOther = await request(app).get('/config').set('X-Forwarded-For', '198.51.100.20');
    expect(rOther.status).toBe(200);
    expect(rOther.headers['ratelimit-remaining']).toBe('1');
  });

  test('apiHandlers et validateSearchQueryParams exposent les erreurs et chemins attendus', () => {
    jest.resetModules();
    const handlers = require('../src/handlers/apiHandlers.mts');
    const { validateSearchQueryParams } = require('../src/utils/validateSearchQuery.mts');

    expect(handlers.resolvePublicIndexHtmlPath()).toMatch(/public[/\\]index\.html$/);

    const health = handlers.buildHealthPayload();
    expect(health.status).toBe('ok');
    expect(health).toHaveProperty('memory');
    expect(health).toHaveProperty('reload_strategy');

    expect(handlers.executeMedicamentSearchRoute({ q: '' }).status).toBe(400);
    expect(handlers.getSpecialiteDetailResult('00000000').status).toBe(404);
    expect(handlers.getVeterinaireDetailResult('0000000').status).toBe(404);
    expect(handlers.getDisponibiliteAlertDetailResult('000000000000').status).toBe(404);
    expect(handlers.getDisponibiliteAlertsResult({}).status).toBe(200);
    expect(handlers.getDisponibiliteListResult({}).status).toBe(200);

    jest.resetModules();
    jest.doMock('../src/utils/ansmUrl.mts', () => ({ normalizeAnsmUrl: () => '' }));
    const handlersInvalidLien = require('../src/handlers/apiHandlers.mts');
    expect(handlersInvalidLien.getDisponibiliteAlertsResult({ lien_ansm: 'https://ansm.sante.fr/x' }).status).toBe(400);
    expect(handlersInvalidLien.getDisponibiliteListResult({ lien_ansm: 'https://ansm.sante.fr/x' }).status).toBe(400);
    jest.dontMock('../src/utils/ansmUrl.mts');

    expect(
      validateSearchQueryParams((name) =>
        name === 'q' ? { value: ['a', 'b'], isMultiple: true } : { value: undefined }
      )
    ).toMatch(/chaîne unique/);
    expect(
      validateSearchQueryParams((name) =>
        name === 'q' ? { value: 'a'.repeat(512) } : { value: undefined }
      )
    ).toBeNull();
    expect(
      validateSearchQueryParams((name) =>
        name === 'q' ? { value: 'a'.repeat(513) } : { value: undefined }
      )
    ).toContain('512');
  });
});
