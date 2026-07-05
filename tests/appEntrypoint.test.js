'use strict';

describe('app et entrée publique', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  function spyListen() {
    const http = require('http');
    return jest.spyOn(http.Server.prototype, 'listen');
  }

  it('src/app expose createApp sans démarrer de serveur', () => {
    const listenSpy = spyListen();

    const { createApp } = require('../src/app');

    expect(typeof createApp).toBe('function');
    expect(listenSpy).not.toHaveBeenCalled();
  });

  it('src/index est side-effect-free et expose les façades publiques', () => {
    const listenSpy = spyListen();

    const api = require('../src');

    expect(listenSpy).not.toHaveBeenCalled();
    expect(typeof api.createApp).toBe('function');
    expect(typeof api.executeHybridSearch).toBe('function');
    expect(typeof api.bdpm.loadData).toBe('function');
    expect(typeof api.vet.loadVetData).toBe('function');
    expect(api.bdpm).not.toHaveProperty('state');
    expect(api.vet).not.toHaveProperty('state');
  });

  it('src/server ne démarre pas quand il est importé', () => {
    const listenSpy = spyListen();

    const server = require('../src/server');

    expect(listenSpy).not.toHaveBeenCalled();
    expect(typeof server.startServer).toBe('function');
  });
});
