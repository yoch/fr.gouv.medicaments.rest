'use strict';

const config = require('./config');
const { downloadDataIfNeeded } = require('./services/dataDownloader');
const { downloadVetDataIfNeeded } = require('./services/vetDataDownloader');
const { loadData } = require('./services/dataLoader');
const { loadVetData } = require('./services/vetDataLoader');
const { createApp } = require('./app');
const { logMemoryUsage } = require('./utils/processMemory');

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

function scheduleMemoryPlateauLogs(scope) {
  logMemoryUsage(`${scope}:done`);
  for (const [suffix, delayMs] of MEMORY_PLATEAU_DELAYS_MS) {
    const timer = setTimeout(() => {
      logMemoryUsage(`${scope}:${suffix}`);
    }, delayMs);
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

async function delayBeforeVetLoad() {
  if (VET_LOAD_DELAY_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, VET_LOAD_DELAY_MS));
  }
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

function scheduleDeferredVetLoad() {
  (async () => {
    await delayBeforeVetLoad();
    console.log('Chargement des données vétérinaires (différé après listen)...');
    await loadVetDataSafe();
  })().catch((err) => {
    console.warn('⚠ Échec chargement vétérinaire différé:', err.message);
  });
}

async function startServer() {
  try {
    const app = createApp();

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
      await delayBeforeVetLoad();
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
      console.log(`🔄 Rafraîchissement vétérinaire (intervalle ${config.vetCheckIntervalHours}h)...`);
      try {
        const { changed: vetChanged } = await downloadVetDataIfNeeded();
        if (vetChanged) await reloadVetAfterChange();
      } catch (err) {
        console.warn('⚠ Erreur rafraîchissement vétérinaire:', err.message);
      }
    }

    setInterval(refreshBdpm, BDPM_REFRESH_MS);
    setInterval(refreshVet, VET_REFRESH_MS);

    app.listen(PORT, () => {
      console.log(
        `Planificateur: BDPM toutes les ${config.bdpmCheckIntervalHours}h, vétérinaire toutes les ${config.vetCheckIntervalHours}h`
      );
      console.log(`Serveur démarré sur le port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
      console.log(`Swagger Docs: http://localhost:${PORT}/api-docs`);
      if (VET_LOAD_DEFERRED) {
        scheduleDeferredVetLoad();
      }
    });
  } catch (error) {
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
