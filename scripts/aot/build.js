#!/usr/bin/env node
'use strict';

/**
 * Construit l'exécutable autonome du serveur avec Bun `--compile --aot`.
 *
 *   npm run build:aot                  # dist/medicaments-api + dist/7za
 *   npm run build:aot -- --require-aot # échoue si FrozenMiniSearch n'est pas compilé typé
 *
 * - `--trim --trim-locales=fr` : retire les API non utilisées ; `localeCompare(…, 'fr')`
 *   a besoin d'Intl avec la locale fr.
 * - `--define process.env.MEDICAMENTS_STANDALONE="1"` : src/config.js exige alors DATA_DIR
 *   et cherche 7za à côté de l'exécutable.
 * - `--define process.env.NODE_ENV="production"` : Bun remplace `process.env.NODE_ENV` par
 *   une constante au build (« development » par défaut, bien que l'aide dise que --compile
 *   implique --production ; vérifié sur 1.4.6-canary.1+736fe1187). Express et src/config.js
 *   lisent cette constante : le NODE_ENV de l'environnement d'exécution est ignoré.
 *   `--production` donnerait la même valeur mais minifierait aussi le code.
 * - `--asset` embarque public/ (page d'accueil) et les fichiers de swagger-ui-dist que
 *   swagger-ui-express sert sous /api-docs/. Dans l'exécutable, `__dirname` et les chemins
 *   de node_modules restent ceux de la machine de build : sans ces assets, `/` répond 404
 *   et Swagger UI reçoit sa page HTML à la place de son CSS et de son JS, dès que le
 *   checkout n'est plus là.
 * - 7za (7zip-bin) est copié à côté de l'exécutable : un binaire embarqué ne peut pas
 *   être lancé avec execFile.
 * - Si @yoch/frozenminisearch expose la condition d'export "aot", `bun build --compile --aot`
 *   la choisit seul et compile la bibliothèque avec ses types (sans --conditions). Avec une
 *   version qui ne l'expose pas, le build passe mais compile le JavaScript non typé
 *   (recherche plus lente) ; `--require-aot` en fait une erreur.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const { createRequire } = require('module');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const outDir = path.join(root, 'dist');
const outfile = path.join(outDir, 'medicaments-api');
const metafile = path.join(outDir, 'medicaments-api.meta.json');
const requireAot = process.argv.includes('--require-aot');
const aotSource = '@yoch/frozenminisearch/dist/aot/index.aot.ts';

function fail(message) {
  console.error(`build:aot: ${message}`);
  process.exit(1);
}

const help = spawnSync('bun', ['build', '--help'], { encoding: 'utf8' });
if (help.error) fail(`bun introuvable (${help.error.message}) : https://bun.com/docs/installation`);
if (!/^\s*--aot(?![\w-])/m.test(help.stdout)) fail('cette version de Bun ne propose pas --aot');

// Fichiers lus par swagger-ui-express (serve + setup) ; le reste de swagger-ui-dist
// (cartes source, bundles ES) ajouterait ~10 Mo.
const SWAGGER_ASSETS = [
  'swagger-ui.css',
  'swagger-ui-bundle.js',
  'swagger-ui-standalone-preset.js',
  'favicon-16x16.png',
  'favicon-32x32.png'
];
// Le dossier que swagger-ui-express sert réellement : il le lit avec
// require('swagger-ui-dist/absolute-path'), résolu depuis son propre module (swagger-ui-dist
// n'est pas une dépendance directe du projet).
const requireFromSwaggerUiExpress = createRequire(require.resolve('swagger-ui-express'));
const swaggerDir = requireFromSwaggerUiExpress('swagger-ui-dist/absolute-path')();
const assets = ['public', ...SWAGGER_ASSETS.map((file) => path.join(swaggerDir, file))].map(
  (asset) => path.relative(root, path.resolve(root, asset))
);
for (const asset of assets) {
  if (!fs.existsSync(path.join(root, asset))) fail(`asset introuvable : ${asset}`);
}

fs.mkdirSync(outDir, { recursive: true });
const args = [
  'build',
  '--compile',
  '--aot',
  '--trim',
  '--trim-locales=fr',
  ...assets.flatMap((asset) => ['--asset', asset]),
  '--define',
  'process.env.MEDICAMENTS_STANDALONE="1"',
  '--define',
  'process.env.NODE_ENV="production"',
  'src/server.js',
  '--outfile',
  outfile,
  `--metafile=${metafile}`
];
// NODE_ENV=production aussi dans l'environnement de Bun : le --define le fixe déjà, ceci
// évite qu'un NODE_ENV=development exporté dans le shell de build ne prête à confusion.
const build = spawnSync('bun', args, {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, NODE_ENV: 'production' },
  maxBuffer: 64 * 1024 * 1024
});
const output = `${build.stdout || ''}${build.stderr || ''}`;
process.stdout.write(output);
if (build.status !== 0) fail(`bun ${args.join(' ')} a échoué (code ${build.status})`);

const inputs = Object.keys(JSON.parse(fs.readFileSync(metafile, 'utf8')).inputs);
const library = inputs.filter((input) => input.includes('@yoch/frozenminisearch/'));
// Résolue ne veut pas dire typée : sur une erreur de type dans la source, Bun la compile
// sans ses types, en le signalant (même critère que make test-aot dans minisearch).
if (/compiled without (its|their) types|index\.aot\.ts:\d+:\d+/.test(output)) {
  const message = 'Bun signale un diagnostic dans la source typée de FrozenMiniSearch ou la compile sans ses types';
  if (requireAot) fail(message);
  console.warn(`build:aot: attention : ${message}`);
}
if (!library.some((input) => input.endsWith(aotSource))) {
  const message =
    `FrozenMiniSearch compilé depuis ${library.join(', ') || '?'} et non depuis la source typée ` +
    '(cette version de @yoch/frozenminisearch n\'expose pas la condition d\'export "aot") : la recherche sera plus lente';
  if (requireAot) fail(message);
  console.warn(`build:aot: attention : ${message}`);
}

const sevenZip = require('7zip-bin').path7za;
const sevenZipOut = path.join(outDir, '7za');
fs.copyFileSync(sevenZip, sevenZipOut);
fs.chmodSync(sevenZipOut, 0o755);

const sizeMb = (fs.statSync(outfile).size / 1e6).toFixed(1);
const revision = spawnSync('bun', ['--revision'], { encoding: 'utf8' }).stdout.trim();
console.log(`build:aot: ${path.relative(root, outfile)} (${sizeMb} Mo, Bun ${revision}) et ${path.relative(root, sevenZipOut)}`);
