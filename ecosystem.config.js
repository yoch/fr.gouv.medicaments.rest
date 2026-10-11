/**
 * Config PM2 par défaut — Node.
 *
 * Variante Bun (expérimentale, pas de gain mesuré en prod) :
 *   ecosystem.bun.config.js
 *
 * Basculer Node → Bun :
 *   pm2 delete medicaments-api
 *   pm2 start ecosystem.bun.config.js
 *   pm2 save
 *   curl -sS http://127.0.0.1:3100/health
 *
 * Revenir Bun → Node :
 *   pm2 delete medicaments-api
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   curl -sS http://127.0.0.1:3100/health
 *
 * Prérequis : PORT=3100 dans .env (proxy Apache).
 */
module.exports = {
  apps: [
    {
      name: 'medicaments-api',
      script: 'src/server.js',
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // Plafonne la jeune génération V8 : pic RSS au chargement ~350 → ~225 Mo (Node 24).
      node_args: '--env-file=.env --max-semi-space-size=8',
      env: {
        NODE_ENV: 'production',
        RELOAD_STRATEGY: 'restart',
        CORPUS_LIGHT_PROFILE: 'true',
        VET_LOAD_DEFERRED: 'true',
        VET_LOAD_DELAY_MS: '2000'
      }
    }
  ]
};
