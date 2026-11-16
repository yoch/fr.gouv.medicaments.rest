import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import swaggerUi from 'swagger-ui-express';

import config from './config.mts';
import { getMetadata } from './services/dataLoader.mts';
import { getRuntimeConfig } from './runtimeConfig.mts';
import { memoryUsageMb } from './utils/processMemory.mts';
import medicamentRoutes from './routes/medicaments/index.mts';
import veterinaireRoutes from './routes/veterinaires.mts';
import swaggerSpecs from './swagger.js';

function healthHandler(req, res) {
  const metadata = getMetadata();
  const { pretty } = req.query;

  const responseData = {
    status: 'ok',
    message: 'API des médicaments française',
    attribution: 'base de données publique des médicaments - gouv.fr',
    metadata: {
      last_updated: metadata.last_updated,
      source: metadata.source
    },
    memory: memoryUsageMb(),
    reload_strategy: config.reloadStrategy,
    uptime_seconds: Math.floor(process.uptime())
  };

  if (pretty === 'true' || pretty === '1') {
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(responseData, null, 2));
  } else {
    res.json(responseData);
  }
}

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_INDEX_HTML = APP_DIR.startsWith('/$bunfs')
  ? path.join(process.cwd(), 'public/index.html')
  : path.resolve(APP_DIR, '../public/index.html');

function createApp() {
  const app = express();
  let store = null;
  // Le MemoryStore du rate limiter garde un timer : à appeler quand l'app est abandonnée.
  app.locals.dispose = () => {
    store?.shutdown();
    store = null;
  };

  app.use(cors());
  app.use(express.json());
  app.use(helmet());

  if (config.enableRateLimit) {
    store = new (rateLimit as any).MemoryStore();
    const limiter = rateLimit({
      store,
      windowMs: config.rateLimitWindowMs,
      max: config.rateLimitMax,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        status: 429,
        error: 'Too Many Requests',
        message: 'Vous avez dépassé la limite de requêtes autorisée. Veuillez réessayer plus tard.'
      }
    });

    app.use(limiter);
  }

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpecs));
  app.get('/api-docs.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpecs);
  });

  app.use('/api/medicaments', medicamentRoutes);
  app.use('/api/veterinaires', veterinaireRoutes);

  app.get('/', (req, res) => {
    res.sendFile(PUBLIC_INDEX_HTML);
  });

  app.get('/health', healthHandler);
  app.get('/config', (req, res) => {
    res.json(getRuntimeConfig());
  });

  return app;
}

export {
createApp
};