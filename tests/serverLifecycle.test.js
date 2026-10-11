'use strict';

describe('cycle de vie du serveur', () => {
  let running;
  let downloadBdpm;
  let downloadVet;
  let loadBdpm;
  let loadVet;

  beforeEach(() => {
    jest.resetModules();
    downloadBdpm = jest.fn().mockResolvedValue({ changed: false });
    downloadVet = jest.fn().mockResolvedValue({ changed: false });
    loadBdpm = jest.fn().mockResolvedValue(undefined);
    loadVet = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../src/services/dataDownloader', () => ({ downloadDataIfNeeded: downloadBdpm }));
    jest.doMock('../src/services/vetDataDownloader', () => ({ downloadVetDataIfNeeded: downloadVet }));
    jest.doMock('../src/services/dataLoader', () => ({ loadData: loadBdpm }));
    jest.doMock('../src/services/vetDataLoader', () => ({ loadVetData: loadVet }));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    if (running) await running.stop();
    running = null;
    jest.restoreAllMocks();
    for (const module of ['config', 'services/dataDownloader', 'services/vetDataDownloader', 'services/dataLoader', 'services/vetDataLoader']) {
      jest.dontMock(`../src/${module}`);
    }
    jest.resetModules();
  });

  function configure(overrides = {}) {
    jest.doMock('../src/config', () => ({
      ...jest.requireActual('../src/config'), port: 0, enableRateLimit: false,
      vetLoadDeferred: false, vetLoadDelayMs: 0, ...overrides
    }));
  }

  test('partage le démarrage et un rafraîchissement bloqué puis libère les timers et le serveur', async () => {
    configure();
    const timers = jest.spyOn(global, 'setTimeout');
    const { startServer } = require('../src/server');
    const first = startServer();
    expect(startServer()).toBe(first);
    running = await first;
    expect(await startServer()).toBe(running);
    expect(loadBdpm).toHaveBeenCalledTimes(1);
    let release;
    downloadBdpm.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const refreshing = running.refreshBdpm();
    expect(running.refreshBdpm()).toBe(refreshing);
    await Promise.resolve();
    expect(downloadBdpm).toHaveBeenCalledTimes(2);
    release({ changed: false });
    await refreshing;
    await running.stop();
    expect(running.server.listening).toBe(false);
    expect(timers.mock.results.filter(result => result.type === 'return').every(result => result.value._destroyed)).toBe(true);
    await running.refreshBdpm();
    expect(downloadBdpm).toHaveBeenCalledTimes(2);
    // Un arrêt permet un nouveau démarrage propre dans le même processus.
    const previous = running;
    running = await startServer();
    expect(loadBdpm).toHaveBeenCalledTimes(2);
    const activeTimers = timers.mock.results.filter(result => result.type === 'return' && !result.value._destroyed);
    expect(activeTimers.length).toBeGreaterThan(0);
    await previous.stop();
    expect(activeTimers.every(result => !result.value._destroyed)).toBe(true);
  });

  test('annule le chargement différé et les rafraîchissements qui attendent ce chargement', async () => {
    configure({ vetLoadDeferred: true, vetLoadDelayMs: 60000 });
    running = await require('../src/server').startServer();
    const refresh = running.refreshVet();
    await running.stop();
    await refresh;
    expect(downloadVet).not.toHaveBeenCalled();
    expect(loadVet).not.toHaveBeenCalled();
  });

  test('attend le chargement initial vétérinaire avant un rafraîchissement', async () => {
    configure({ vetLoadDeferred: true });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    downloadVet.mockImplementationOnce(() => gate);
    running = await require('../src/server').startServer();
    const refresh = running.refreshVet();
    expect(running.refreshVet()).toBe(refresh);
    await Promise.resolve();
    expect(downloadVet).toHaveBeenCalledTimes(1);
    release({ changed: false });
    await refresh;
    expect(downloadVet).toHaveBeenCalledTimes(2);
    expect(loadVet).toHaveBeenCalledTimes(1);
  });

  test('ferme le MemoryStore du rate limiter quand le serveur HTTP est fermé', async () => {
    configure({ enableRateLimit: true });
    const limiter = require('express-rate-limit');
    const shutdown = jest.spyOn(limiter.MemoryStore.prototype, 'shutdown');
    const app = require('../src/app').createApp();
    const init = jest.spyOn(limiter.MemoryStore.prototype, 'init');
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const second = app.listen(0, '127.0.0.1');
    await new Promise(resolve => second.once('listening', resolve));
    await new Promise(resolve => server.close(resolve));
    expect(shutdown).not.toHaveBeenCalled();
    await new Promise(resolve => second.close(resolve));
    expect(shutdown).toHaveBeenCalledTimes(1);
    app.locals.dispose();
    expect(shutdown).toHaveBeenCalledTimes(1);
    const restarted = app.listen(0, '127.0.0.1');
    await new Promise(resolve => restarted.once('listening', resolve));
    expect(init).toHaveBeenCalledTimes(1);
    await new Promise(resolve => restarted.close(resolve));
  });
});
