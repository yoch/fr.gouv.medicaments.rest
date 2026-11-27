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
 * - 7za (7zip-bin) est copié à côté de l'exécutable : un binaire embarqué ne peut pas
 *   être lancé avec execFile.
 * - Si @yoch/frozenminisearch expose la condition d'export "aot", `bun build --compile --aot`
 *   la choisit seul et compile la bibliothèque avec ses types (sans --conditions). Avec une
 *   version qui ne l'expose pas, le build passe mais compile le JavaScript non typé
 *   (recherche plus lente) ; `--require-aot` en fait une erreur.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
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

fs.mkdirSync(outDir, { recursive: true });
const args = [
  'build',
  '--compile',
  '--aot',
  '--trim',
  '--trim-locales=fr',
  '--define',
  'process.env.MEDICAMENTS_STANDALONE="1"',
  '--define',
  'process.env.NODE_ENV="production"',
  'src/server.js',
  '--outfile',
  outfile,
  `--metafile=${metafile}`
];
const build = spawnSync('bun', args, { cwd: root, stdio: 'inherit' });
if (build.status !== 0) fail(`bun ${args.join(' ')} a échoué (code ${build.status})`);

const inputs = Object.keys(JSON.parse(fs.readFileSync(metafile, 'utf8')).inputs);
const library = inputs.filter((input) => input.includes('@yoch/frozenminisearch/'));
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
