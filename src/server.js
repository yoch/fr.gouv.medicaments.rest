const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const config = require('./config');
const { downloadDataIfNeeded } = require('./services/dataDownloader');
const { downloadVetDataIfNeeded } = require('./services/vetDataDownloader');
const { loadData, getMetadata } = require('./services/dataLoader');
const { getRuntimeConfig } = require('./runtimeConfig');
const { loadVetData } = require('./services/vetDataLoader');
const medicamentRoutes = require('./routes/medicaments');
const veterinaireRoutes = require('./routes/veterinaires');

const app = express();
const PORT = config.port;

app.use(cors());
app.use(express.json());
app.use(helmet());

if (config.enableRateLimit) {
  const limiter = rateLimit({
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
  console.log(
    `Rate limiting enabled: ${config.rateLimitMax} requests per ${config.rateLimitWindowMs}ms`
  );
}

// Swagger spec
const swaggerSpecs = require('./swagger');
const swaggerUi = require('swagger-ui-express');

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpecs));
app.get('/api-docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpecs);
});

app.use('/api/medicaments', medicamentRoutes);
app.use('/api/veterinaires', veterinaireRoutes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

function memoryUsageMb() {
  const n = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;
  const u = process.memoryUsage();
  return {
    rss_mb: n(u.rss),
    heap_used_mb: n(u.heapUsed),
    heap_total_mb: n(u.heapTotal),
    external_mb: n(u.external),
    array_buffers_mb: n(u.arrayBuffers ?? 0),
    non_heap_mb: n(Math.max(0, u.rss - u.heapUsed))
  };
}

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

app.get('/health', healthHandler);
app.get('/config', (req, res) => {
  res.json(getRuntimeConfig());
});

const BDPM_REFRESH_MS = config.bdpmCheckIntervalHours * 60 * 60 * 1000;
const VET_REFRESH_MS = config.vetCheckIntervalHours * 60 * 60 * 1000;
const VET_LOAD_DEFERRED = config.vetLoadDeferred;
const VET_LOAD_DELAY_MS = config.vetLoadDelayMs;

function shouldRestartOnDataChange() {
  return config.reloadStrategy === 'restart' || config.reloadStrategy === 'exit';
}

async function reloadBdpmAfterChange() {
  if (shouldRestartOnDataChange()) {
    console.log('Données BDPM mises à jour — redémarrage du processus demandé (RELOAD_STRATEGY=restart)');
    process.exit(0);
  }
  await loadData();
}

async function reloadVetAfterChange() {
  if (shouldRestartOnDataChange()) {
    console.log('Données vétérinaires mises à jour — redémarrage du processus demandé (RELOAD_STRATEGY=restart)');
    process.exit(0);
  }
  await loadVetData();
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
    console.log('Vérification et téléchargement des données...');
    await downloadDataIfNeeded();

    console.log('Chargement des données en mémoire...');
    await loadData();

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

startServer();
