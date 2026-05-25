const express = require('express');
const cors = require('cors');
const { downloadDataIfNeeded } = require('./services/dataDownloader');
const { downloadVetDataIfNeeded } = require('./services/vetDataDownloader');
const { loadData, getMetadata } = require('./services/dataLoader');
const { summarizePhases, snapshotProcessMemory } = require('./utils/memoryProfile');
const { loadVetData } = require('./services/vetDataLoader');
const medicamentRoutes = require('./routes/medicaments');
const veterinaireRoutes = require('./routes/veterinaires');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use(require('helmet')());

// Rate Limiting
const rateLimit = require('express-rate-limit');
const enableRateLimit = process.env.ENABLE_RATE_LIMIT === 'true';

if (enableRateLimit) {
    const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
    const max = parseInt(process.env.RATE_LIMIT_MAX || '500', 10);
    const limiter = rateLimit({
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
            status: 429,
            error: 'Too Many Requests',
            message: 'Vous avez dépassé la limite de requêtes autorisée. Veuillez réessayer plus tard.'
        }
    });

    app.use(limiter);
    console.log(`Rate limiting enabled: ${max} requests per ${windowMs}ms`);
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
    res.send(`
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>API Médicaments France</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 40px; line-height: 1.6; max-width: 800px; margin: 0 auto; padding: 20px; text-align: center; }
            h1 { color: #333; margin-bottom: 20px; }
            p { color: #666; margin-bottom: 40px; }
            .links { display: flex; justify-content: center; gap: 20px; }
            .btn { display: inline-block; padding: 12px 24px; background: #007bff; color: white; text-decoration: none; border-radius: 6px; font-weight: bold; transition: background 0.2s; }
            .btn:hover { background: #0056b3; }
            .btn-secondary { background: #6c757d; }
            .btn-secondary:hover { background: #545b62; }
        </style>
    </head>
    <body>
        <h1>🏥 API Base de Données Publique des Médicaments</h1>
        <p>API REST pour accéder aux données officielles des médicaments en France (BDPM).</p>

        <div class="links">
            <a href="/api-docs" class="btn">📚 Documentation Swagger</a>
            <a href="/api-docs.json" class="btn btn-secondary">⚙️ Spécification OpenAPI</a>
        </div>

        <p style="margin-top: 50px; font-size: 0.9em;">
            <a href="/health" style="color: #666;">Status API</a>
        </p>
    </body>
    </html>
  `);
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
    const memory = memoryUsageMb();
    const memorySummary = summarizePhases();
    let status = 'ok';
    if (memory.rss_mb >= MEMORY_CRITICAL_RSS_MB) {
        status = 'degraded';
    } else if (memory.rss_mb >= MEMORY_ALERT_RSS_MB) {
        status = 'warning';
    }

    const responseData = {
        status,
        message: 'API des médicaments française',
        attribution: 'base de données publique des médicaments - gouv.fr',
        metadata: {
            last_updated: metadata.last_updated,
            source: metadata.source
        },
        memory,
        memory_thresholds_mb: {
            alert: MEMORY_ALERT_RSS_MB,
            critical: MEMORY_CRITICAL_RSS_MB
        },
        memory_load_phases: memorySummary,
        reload_strategy: RELOAD_STRATEGY,
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
app.get('/api/health', healthHandler);

const REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const MEMORY_ALERT_RSS_MB = parseInt(process.env.MEMORY_ALERT_RSS_MB || '450', 10);
const MEMORY_CRITICAL_RSS_MB = parseInt(process.env.MEMORY_CRITICAL_RSS_MB || '480', 10);
const RELOAD_STRATEGY = String(process.env.RELOAD_STRATEGY || 'in-process').toLowerCase();

function shouldRestartOnDataChange() {
  return RELOAD_STRATEGY === 'restart' || RELOAD_STRATEGY === 'exit';
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

async function loadVetDataSafe() {
    try {
        await downloadVetDataIfNeeded();
        await loadVetData();
    } catch (err) {
        console.warn('⚠ Données vétérinaires indisponibles (le serveur continue sans):', err.message);
    }
}

async function startServer() {
    try {
        console.log('Vérification et téléchargement des données...');
        await downloadDataIfNeeded();

        console.log('Chargement des données en mémoire...');
        await loadData();
        await loadVetDataSafe();
        const bootMemory = snapshotProcessMemory();
        console.log(
            `Mémoire après chargement: rss=${bootMemory.rss_mb}Mo heap=${bootMemory.heap_used_mb}Mo`
        );

        // Schedule periodic updates
        setInterval(async () => {
            console.log('🔄 Rafraîchissement périodique des données...');
            try {
                const { changed: bdpmChanged } = await downloadDataIfNeeded();
                if (bdpmChanged) await reloadBdpmAfterChange();
            } catch (err) {
                console.error('❌ Erreur rafraîchissement BDPM:', err.message);
            }
            try {
                const { changed: vetChanged } = await downloadVetDataIfNeeded();
                if (vetChanged) await reloadVetAfterChange();
            } catch (err) {
                console.warn('⚠ Erreur rafraîchissement vétérinaire:', err.message);
            }
        }, REFRESH_INTERVAL);

        app.listen(PORT, () => {
            console.log(`Serveur démarré sur le port ${PORT}`);
            console.log(`Health check: http://localhost:${PORT}/health`);
            console.log(`Swagger Docs: http://localhost:${PORT}/api-docs`);
        });
    } catch (error) {
        console.error('Erreur au démarrage:', error);
        process.exit(1);
    }
}

startServer();