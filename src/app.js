'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const swaggerUi = require('swagger-ui-express');

const config = require('./config');
const { getMetadata } = require('./services/dataLoader');
const { getRuntimeConfig } = require('./runtimeConfig');
const medicamentRoutes = require('./routes/medicaments');
const veterinaireRoutes = require('./routes/veterinaires');
const swaggerSpecs = require('./swagger');

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

function createApp() {
  const app = express();

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
  }

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

  app.get('/health', healthHandler);
  app.get('/config', (req, res) => {
    res.json(getRuntimeConfig());
  });

  return app;
}

module.exports = { createApp };
