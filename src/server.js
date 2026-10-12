'use strict';

const config = require('./config');
const { downloadDataIfNeeded } = require('./services/dataDownloader');
const { downloadVetDataIfNeeded } = require('./services/vetDataDownloader');
const { loadData } = require('./services/dataLoader');
const { loadVetData } = require('./services/vetDataLoader');
const { createApp } = require('./app');
const { logMemoryUsage } = require('./utils/processMemory');
const { singleFlight } = require('./utils/singleFlight');
const { startPeriodicTask } = require('./utils/periodicTask');
const { setTimeout: delay } = require('node:timers/promises');

const PORT = config.port;
const BDPM_REFRESH_MS = config.bdpmCheckIntervalHours * 60 * 60 * 1000;
const VET_REFRESH_MS = config.vetCheckIntervalHours * 60 * 60 * 1000;
const VET_LOAD_DEFERRED = config.vetLoadDeferred;
const VET_LOAD_DELAY_MS = config.vetLoadDelayMs;
const MEMORY_PLATEAU_DELAYS_MS = [
  ['+30s', 30 * 1000],
  ['+2min', 2 * 60 * 1000],
  ['+5min', 5 * 60 * 1000]
];

const memoryTimers = new Set();
let runningServer = null;

function scheduleMemoryPlateauLogs(scope) {
  logMemoryUsage(`${scope}:done`);
  for (const [suffix, delayMs] of MEMORY_PLATEAU_DELAYS_MS) {
    const timer = setTimeout(() => {
      memoryTimers.delete(timer);
      logMemoryUsage(`${scope}:${suffix}`);
    }, delayMs);
    memoryTimers.add(timer);
    if (typeof timer.unref === 'function') timer.unref();
  }
}

function maybeRunPostLoadGc(scope) {
  if (!config.postLoadGc) return;
  if (config.nodeEnv === 'production') {
    console.warn('POST_LOAD_GC=true ignoré en production');
    return;
  }
  if (typeof global.gc !== 'function') {
    console.warn('POST_LOAD_GC=true mais global.gc indisponible — lancer Node avec --expose-gc');
    return;
  }
  global.gc();
  logMemoryUsage(`${scope}:post_gc`);
}

function shouldRestartOnDataChange() {
  return config.reloadStrategy === 'restart' || config.reloadStrategy === 'exit';
}

async function reloadBdpmAfterChange() {
  if (shouldRestartOnDataChange()) {
    console.log('Données BDPM mises à jour — redémarrage du processus demandé (RELOAD_STRATEGY=restart)');
    process.exit(0);
  }
  await loadData();
  scheduleMemoryPlateauLogs('bdpm_reload');
}

async function reloadVetAfterChange() {
  if (shouldRestartOnDataChange()) {
    console.log('Données vétérinaires mises à jour — redémarrage du processus demandé (RELOAD_STRATEGY=restart)');
    process.exit(0);
  }
  await loadVetData();
  scheduleMemoryPlateauLogs('vet_reload');
  maybeRunPostLoadGc('vet_reload');
}

async function delayBeforeVetLoad(signal) {
  if (VET_LOAD_DELAY_MS > 0) await delay(VET_LOAD_DELAY_MS, undefined, { signal });
}

async function loadVetDataSafe() {
  try {
    await downloadVetDataIfNeeded();
    await loadVetData();
    scheduleMemoryPlateauLogs('vet_load');
    maybeRunPostLoadGc('vet_load');
  } catch (err) {
    console.warn('⚠ Données vétérinaires indisponibles (le serveur continue sans):', err.message);
  }
}

const startServer = singleFlight(startServerOnce);

async function startServerOnce() {
  if (runningServer) return runningServer;
  const app = createApp();
  const deferredController = new AbortController();
  const tasks = [];
  let server;
  let initialVetLoad = Promise.resolve();
  let stopped = false;
  const stop = singleFlight(async () => {
    if (stopped) return;
    stopped = true;
    deferredController.abort();
    for (const timer of memoryTimers) clearTimeout(timer);
    memoryTimers.clear();
    const closing = server?.listening
      ? new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      : Promise.resolve();
    try {
      await Promise.all([closing, initialVetLoad, ...tasks.map(task => task.stop())]);
    } finally {
      for (const timer of memoryTimers) clearTimeout(timer);
      memoryTimers.clear();
      app.locals?.dispose?.();
      if (runningServer?.server === server) runningServer = null;
    }
  });
  try {
    if (config.enableRateLimit) {
      console.log(
        `Rate limiting enabled: ${config.rateLimitMax} requests per ${config.rateLimitWindowMs}ms`
      );
    }

    console.log('Vérification et téléchargement des données...');
    await downloadDataIfNeeded();

    console.log('Chargement des données en mémoire...');
    await loadData();
    scheduleMemoryPlateauLogs('bdpm_load');

    if (!VET_LOAD_DEFERRED) {
      await delayBeforeVetLoad(deferredController.signal);
      await loadVetDataSafe();
    } else {
      console.log('Chargement vétérinaire différé (VET_LOAD_DEFERRED=true)');
    }

    async function refreshBdpm() {
      console.log(`🔄 Rafraîchissement BDPM (intervalle ${config.bdpmCheckIntervalHours}h)...`);
      try {
        const { changed: bdpmChanged } = await downloadDataIfNeeded();
        if (bdpmChanged) await reloadBdpmAfterChange();
      } catch (err) {
        console.error('❌ Erreur rafraîchissement BDPM:', err.message);
      }
    }

    async function refreshVet() {
      await initialVetLoad;
      if (stopped) return;
      console.log(`🔄 Rafraîchissement vétérinaire (intervalle ${config.vetCheckIntervalHours}h)...`);
      try {
        const { changed: vetChanged } = await downloadVetDataIfNeeded();
        if (vetChanged) await reloadVetAfterChange();
      } catch (err) {
        console.warn('⚠ Erreur rafraîchissement vétérinaire:', err.message);
      }
    }

    server = app.listen(PORT);
    await new Promise((resolve, reject) => {
      const onError = error => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('listening', onListening);
      server.once('error', onError);
    });
    console.log(
      `Planificateur: BDPM toutes les ${config.bdpmCheckIntervalHours}h, vétérinaire toutes les ${config.vetCheckIntervalHours}h`
    );
    console.log(`Serveur démarré sur le port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Swagger Docs: http://localhost:${PORT}/api-docs`);
    if (VET_LOAD_DEFERRED) {
      initialVetLoad = (async () => {
        await delayBeforeVetLoad(deferredController.signal);
        console.log('Chargement des données vétérinaires (différé après listen)...');
        await loadVetDataSafe();
      })().catch(error => {
        if (error.name !== 'AbortError') console.warn('⚠ Échec chargement vétérinaire différé:', error.message);
      });
    }
    const bdpmTask = startPeriodicTask(refreshBdpm, BDPM_REFRESH_MS);
    const vetTask = startPeriodicTask(refreshVet, VET_REFRESH_MS);
    tasks.push(bdpmTask, vetTask);
    runningServer = { app, server, stop, refreshBdpm: bdpmTask.run, refreshVet: vetTask.run };
    return runningServer;
  } catch (error) {
    await stop();
    console.error('Erreur au démarrage:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer,
  shouldRestartOnDataChange,
  reloadBdpmAfterChange,
  reloadVetAfterChange
};
