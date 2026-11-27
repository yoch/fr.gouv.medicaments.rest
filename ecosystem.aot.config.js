/**
 * Variante PM2 pour l'exécutable compilé (npm run build:aot), pendant la transition.
 *
 * Cible recommandée : l'unité systemd deploy/medicaments-api.service, qui n'a besoin ni
 * de Node ni de PM2 sur l'hôte (voir docs/BUN_AOT.md, « Déploiement »). Cette variante
 * garde les habitudes PM2 (logs, `pm2 save`) tant que Node reste installé pour le retour
 * arrière.
 *
 * L'exécutable est lancé directement (`interpreter: 'none'`). Il charge .env depuis `cwd`
 * (racine du dépôt) sans écraser les variables ci-dessous ; NODE_ENV est fixé au build.
 *
 * Basculer Node → exécutable :
 *   npm run build:aot
 *   pm2 delete medicaments-api
 *   pm2 start ecosystem.aot.config.js
 *   pm2 save
 *   curl -sS http://127.0.0.1:3100/health
 *
 * Revenir exécutable → Node :
 *   pm2 delete medicaments-api
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   curl -sS http://127.0.0.1:3100/health
 *
 * Prérequis : PORT=3100 dans .env (proxy Apache). DATA_DIR vaut <dépôt>/data sauf s'il est
 * défini dans .env ; VET_DATA_DIR en dérive comme sous Node.
 */
const fs = require('fs');
const path = require('path');

// Comme le défaut de src/config.js sous Node (<dépôt>/data), sauf si .env ou
// l'environnement de `pm2 start` fixe déjà DATA_DIR : une variable posée par PM2
// masquerait celle de .env.
const dotenvPath = path.join(__dirname, '.env');
const dotenvSetsDataDir =
  fs.existsSync(dotenvPath) && /^[^\S\n]*(?:export[^\S\n]+)?DATA_DIR[^\S\n]*=[^\S\n]*(?!["']{2})[^\s#]/m.test(fs.readFileSync(dotenvPath, 'utf8'));
const dataDirEnv =
  (process.env.DATA_DIR || dotenvSetsDataDir) ? {} : { DATA_DIR: path.join(__dirname, 'data') };

module.exports = {
  apps: [
    {
      name: 'medicaments-api',
      script: path.join(__dirname, 'dist/medicaments-api'),
      interpreter: 'none',
      exec_mode: 'fork',
      cwd: __dirname,
      // RELOAD_STRATEGY=restart sort avec le code 0 : PM2 doit aussi relancer ce cas.
      autorestart: true,
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env: {
        RELOAD_STRATEGY: 'restart',
        ...dataDirEnv,
        CORPUS_LIGHT_PROFILE: 'true',
        VET_LOAD_DEFERRED: 'true',
        VET_LOAD_DELAY_MS: '2000'
      }
    }
  ]
};
