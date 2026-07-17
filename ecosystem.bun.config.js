/**
 * Variante PM2 + Bun (expérimentale).
 *
 * Défaut prod = ecosystem.config.js (Node). Bun n’a pas montré de gain
 * mesurable ; à n’utiliser que pour retester.
 *
 * Important : ne pas utiliser `interpreter: 'bun'` + `script: src/server.js`
 * (ProcessContainerForkBun casse `require.main` → startServer ne part pas).
 * Ici Bun est le binaire lancé directement (`interpreter: 'none'`).
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
 * Prérequis : Bun installé (~/.bun/bin/bun), PORT=3100 dans .env.
 */
module.exports = {
  apps: [
    {
      name: 'medicaments-api',
      script: `${process.env.HOME}/.bun/bin/bun`,
      args: '--env-file=.env src/server.js',
      interpreter: 'none',
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env: {
        PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
        NODE_ENV: 'production',
        RELOAD_STRATEGY: 'restart',
        CORPUS_LIGHT_PROFILE: 'true',
        VET_LOAD_DEFERRED: 'true',
        VET_LOAD_DELAY_MS: '5000'
      }
    }
  ]
};
