import { setTimeout as delay } from 'node:timers/promises';
import config from '../config.mts';
import { downloadDataIfNeeded } from './dataDownloader.mts';
import { downloadVetDataIfNeeded } from './vetDataDownloader.mts';
import { loadData } from './dataLoader.mts';
import { loadVetData } from './vetDataLoader.mts';
import { logMemoryUsage } from '../utils/processMemory.mts';
import { singleFlight } from '../utils/singleFlight.mts';
import { startPeriodicTask, type PeriodicTaskHandle } from '../utils/periodicTask.mts';

const BDPM_REFRESH_MS = config.bdpmCheckIntervalHours * 60 * 60 * 1000;
const VET_REFRESH_MS = config.vetCheckIntervalHours * 60 * 60 * 1000;
const VET_LOAD_DEFERRED = config.vetLoadDeferred;
const VET_LOAD_DELAY_MS = config.vetLoadDelayMs;
const MEMORY_PLATEAU_DELAYS_MS: ReadonlyArray<readonly [string, number]> = [
  ['+30s', 30 * 1000],
  ['+2min', 2 * 60 * 1000],
  ['+5min', 5 * 60 * 1000]
];

const memoryTimers = new Set<ReturnType<typeof setTimeout>>();

export interface ListenerHandle<TServer> {
  server: TServer;
  close: () => Promise<void>;
}

export interface ManagedServerInstance<TServer> {
  server: TServer;
  stop: () => Promise<void>;
  refreshBdpm: () => Promise<void>;
  refreshVet: () => Promise<void>;
}

export interface ManagedServerOptions<TServer> {
  listen: () => Promise<ListenerHandle<TServer>>;
  onStop?: () => void;
  logStartup?: (port: number) => void;
}

function scheduleMemoryPlateauLogs(scope: string): void {
  logMemoryUsage(`${scope}:done`);
  for (let i = 0; i < MEMORY_PLATEAU_DELAYS_MS.length; i++) {
    const [suffix, delayMs] = MEMORY_PLATEAU_DELAYS_MS[i];
    const timer = setTimeout(() => {
      memoryTimers.delete(timer);
      logMemoryUsage(`${scope}:${suffix}`);
    }, delayMs);
    memoryTimers.add(timer);
    if (typeof timer.unref === 'function') timer.unref();
  }
}

function maybeRunPostLoadGc(scope: string): void {
  if (!config.postLoadGc) return;
  if (config.nodeEnv === 'production') {
    console.warn('POST_LOAD_GC=true ignoré en production');
    return;
  }
  const globalWithGc = globalThis as typeof globalThis & { gc?: () => void };
  if (typeof globalWithGc.gc !== 'function') {
    console.warn('POST_LOAD_GC=true mais global.gc indisponible — lancer Node avec --expose-gc');
    return;
  }
  globalWithGc.gc();
  logMemoryUsage(`${scope}:post_gc`);
}

function shouldRestartOnDataChange(): boolean {
  return config.reloadStrategy === 'restart' || config.reloadStrategy === 'exit';
}

async function reloadBdpmAfterChange(): Promise<void> {
  if (shouldRestartOnDataChange()) {
    console.log('Données BDPM mises à jour — redémarrage du processus demandé (RELOAD_STRATEGY=restart)');
    process.exit(0);
  }
  await loadData();
  scheduleMemoryPlateauLogs('bdpm_reload');
}

async function reloadVetAfterChange(): Promise<void> {
  if (shouldRestartOnDataChange()) {
    console.log('Données vétérinaires mises à jour — redémarrage du processus demandé (RELOAD_STRATEGY=restart)');
    process.exit(0);
  }
  await loadVetData();
  scheduleMemoryPlateauLogs('vet_reload');
  maybeRunPostLoadGc('vet_reload');
}

async function delayBeforeVetLoad(signal: AbortSignal): Promise<void> {
  if (VET_LOAD_DELAY_MS > 0) await delay(VET_LOAD_DELAY_MS, undefined, { signal });
}

async function loadVetDataSafe(): Promise<void> {
  try {
    await downloadVetDataIfNeeded();
    await loadVetData();
    scheduleMemoryPlateauLogs('vet_load');
    maybeRunPostLoadGc('vet_load');
  } catch (err) {
    const error = err as Error;
    console.warn('⚠ Données vétérinaires indisponibles (le serveur continue sans):', error.message);
  }
}

function createServerLifecycle<TServer>(options: ManagedServerOptions<TServer>) {
  let running: ManagedServerInstance<TServer> | null = null;

  const startOnce = async (): Promise<ManagedServerInstance<TServer>> => {
    if (running) return running;
    const deferredController = new AbortController();
    const tasks: PeriodicTaskHandle[] = [];
    let listener: ListenerHandle<TServer> | null = null;
    let initialVetLoad = Promise.resolve();
    let stopped = false;

    const stop = singleFlight(async () => {
      if (stopped) return;
      stopped = true;
      deferredController.abort();
      for (const timer of memoryTimers) clearTimeout(timer);
      memoryTimers.clear();
      const closing = listener ? listener.close() : Promise.resolve();
      try {
        await Promise.all([closing, initialVetLoad, ...tasks.map((task) => task.stop())]);
      } finally {
        for (const timer of memoryTimers) clearTimeout(timer);
        memoryTimers.clear();
        options.onStop?.();
        if (listener && running?.server === listener.server) running = null;
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

      async function refreshBdpm(): Promise<void> {
        console.log(`🔄 Rafraîchissement BDPM (intervalle ${config.bdpmCheckIntervalHours}h)...`);
        try {
          const { changed: bdpmChanged } = await downloadDataIfNeeded();
          if (bdpmChanged) await reloadBdpmAfterChange();
        } catch (err) {
          const error = err as Error;
          console.error('❌ Erreur rafraîchissement BDPM:', error.message);
        }
      }

      async function refreshVet(): Promise<void> {
        await initialVetLoad;
        if (stopped) return;
        console.log(`🔄 Rafraîchissement vétérinaire (intervalle ${config.vetCheckIntervalHours}h)...`);
        try {
          const { changed: vetChanged } = await downloadVetDataIfNeeded();
          if (vetChanged) await reloadVetAfterChange();
        } catch (err) {
          const error = err as Error;
          console.warn('⚠ Erreur rafraîchissement vétérinaire:', error.message);
        }
      }

      listener = await options.listen();
      console.log(
        `Planificateur: BDPM toutes les ${config.bdpmCheckIntervalHours}h, vétérinaire toutes les ${config.vetCheckIntervalHours}h`
      );
      if (options.logStartup) {
        options.logStartup(config.port);
      } else {
        console.log(`Serveur démarré sur le port ${config.port}`);
        console.log(`Health check: http://localhost:${config.port}/health`);
      }

      if (VET_LOAD_DEFERRED) {
        initialVetLoad = (async () => {
          await delayBeforeVetLoad(deferredController.signal);
          console.log('Chargement des données vétérinaires (différé après listen)...');
          await loadVetDataSafe();
        })().catch((err) => {
          const error = err as Error;
          if (error.name !== 'AbortError') {
            console.warn('⚠ Échec chargement vétérinaire différé:', error.message);
          }
        });
      }

      const bdpmTask = startPeriodicTask(refreshBdpm, BDPM_REFRESH_MS);
      const vetTask = startPeriodicTask(refreshVet, VET_REFRESH_MS);
      tasks.push(bdpmTask, vetTask);

      running = {
        server: listener.server,
        stop,
        refreshBdpm: bdpmTask.run,
        refreshVet: vetTask.run
      };
      return running;
    } catch (error) {
      await stop();
      console.error('Erreur au démarrage:', error);
      process.exit(1);
    }
  };

  return singleFlight(startOnce);
}

export {
  createServerLifecycle,
  shouldRestartOnDataChange,
  reloadBdpmAfterChange,
  reloadVetAfterChange
};
