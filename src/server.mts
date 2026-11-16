import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type http from 'node:http';
import config from './config.mts';
import { createApp } from './app.mts';
import { singleFlight } from './utils/singleFlight.mts';
import {
  createServerLifecycle,
  shouldRestartOnDataChange,
  reloadBdpmAfterChange,
  reloadVetAfterChange
} from './services/serverLifecycle.mts';

export interface RunningServer {
  app: ReturnType<typeof createApp>;
  server: http.Server;
  stop: () => Promise<void>;
  refreshBdpm: () => Promise<void>;
  refreshVet: () => Promise<void>;
}

let runningServer: RunningServer | null = null;

async function listenExpress(app: ReturnType<typeof createApp>, port: number): Promise<http.Server> {
  const activeServer = app.listen(port);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      activeServer.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      activeServer.off('error', onError);
      resolve();
    };
    activeServer.once('listening', onListening);
    activeServer.once('error', onError);
  });
  return activeServer;
}

const startServer = singleFlight(async (): Promise<RunningServer> => {
  if (runningServer) return runningServer;
  const app = createApp();
  let currentServer: http.Server | null = null;
  const startLifecycle = createServerLifecycle<http.Server>({
    listen: async () => {
      const server = await listenExpress(app, config.port);
      currentServer = server;
      return {
        server,
        close: () =>
          server.listening
            ? new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
              )
            : Promise.resolve()
      };
    },
    onStop: () => {
      app.locals?.dispose?.();
      if (runningServer?.server === currentServer) runningServer = null;
    },
    logStartup: (port) => {
      console.log(`Serveur démarré sur le port ${port}`);
      console.log(`Health check: http://localhost:${port}/health`);
      console.log(`Swagger Docs: http://localhost:${port}/api-docs`);
    }
  });

  const managed = await startLifecycle();
  if (!managed) return undefined as unknown as RunningServer;
  runningServer = {
    app,
    server: managed.server,
    stop: async () => {
      await managed.stop();
      if (runningServer?.server === currentServer) runningServer = null;
    },
    refreshBdpm: managed.refreshBdpm,
    refreshVet: managed.refreshVet
  };
  return runningServer;
});

const isDirectEntrypoint =
  (import.meta as { main?: boolean }).main === true ||
  (Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (isDirectEntrypoint) {
  startServer();
}

export {
  startServer,
  shouldRestartOnDataChange,
  reloadBdpmAfterChange,
  reloadVetAfterChange
};
