const express = require('express');
const cors = require('cors');
const { downloadDataIfNeeded } = require('./services/dataDownloader');
const { loadData, getMetadata } = require('./services/dataLoader');
const medicamentRoutes = require('./routes/medicaments');

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
            <a href="/api/health" style="color: #666;">Status API</a>
        </p>
    </body>
    </html>
  `);
});

app.get('/api/health', (req, res) => {
    const metadata = getMetadata();
    const { pretty } = req.query;

    const responseData = {
        status: 'ok',
        message: 'API des médicaments française',
        attribution: 'base de données publique des médicaments - gouv.fr',
        metadata: {
            last_updated: metadata.last_updated,
            source: metadata.source
        }
    };

    if (pretty === 'true' || pretty === '1') {
        res.set('Content-Type', 'application/json; charset=utf-8');
        res.send(JSON.stringify(responseData, null, 2));
    } else {
        res.json(responseData);
    }
});

const REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

async function startServer() {
    try {
        console.log('Vérification et téléchargement des données...');
        await downloadDataIfNeeded();

        console.log('Chargement des données en mémoire...');
        await loadData();

        // Schedule periodic updates
        setInterval(async () => {
            console.log('🔄 Rafraîchissement périodique des données...');
            try {
                const { changed } = await downloadDataIfNeeded();
                if (!changed) {
                    console.log('✓ Données inchangées, rechargement mémoire ignoré');
                    return;
                }
                await loadData();
                console.log('✅ Données rafraîchies avec succès');
            } catch (err) {
                console.error('❌ Erreur lors du rafraîchissement des données:', err);
            }
        }, REFRESH_INTERVAL);

        app.listen(PORT, () => {
            console.log(`Serveur démarré sur le port ${PORT}`);
            console.log(`Health check: http://localhost:${PORT}/api/health`);
            console.log(`Swagger Docs: http://localhost:${PORT}/api-docs`);
        });
    } catch (error) {
        console.error('Erreur au démarrage:', error);
        process.exit(1);
    }
}

startServer();