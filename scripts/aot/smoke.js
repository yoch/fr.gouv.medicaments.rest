#!/usr/bin/env node
'use strict';

/**
 * Compare l'exécutable compilé (npm run build:aot) au serveur Node sur les mêmes données.
 *
 *   DATA_DIR=/chemin/data [VET_DATA_DIR=…] npm run smoke:aot
 *
 * Chaque serveur reçoit sa propre copie des données (DATA_DIR n'est jamais modifié) et un
 * répertoire courant vide (aucun .env ne s'applique), avec des intervalles de
 * rafraîchissement maximaux : pas de téléchargement si les données ont moins de 25 jours.
 * Chaque chemin doit ensuite donner le même statut et le même corps. Les champs qui
 * dépendent de l'instant ou du processus (horodatages, mémoire, uptime) sont ignorés.
 *
 * Lancé depuis le checkout de build, le test ne voit pas un asset manquant (les chemins
 * embarqués existent aussi sur le disque) : voir docs/BUN_AOT.md pour la vérification
 * sans checkout.
 * Variables : AOT_BINARY (défaut dist/medicaments-api), SMOKE_TIMEOUT_MS (défaut 120000).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const binary = process.env.AOT_BINARY || path.join(root, 'dist', 'medicaments-api');
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS) || 120000;

const PATHS = [
  '/',
  '/api-docs/',
  '/api-docs/swagger-ui.css',
  '/api-docs.json',
  '/health',
  '/config',
  '/api/medicaments/search?q=paracetamol&limit=10',
  '/api/medicaments/search?q=doliprane&limit=10&detail=summary',
  '/api/medicaments/search?q=dolipranr&limit=10',
  '/api/medicaments/search?q=acide%20ac%C3%A9tylsalicylique&limit=20',
  '/api/medicaments/search?q=3400936403114',
  '/api/medicaments/disponibilite/alerts',
  '/api/medicaments/specialites?q=doliprane&limit=5',
  '/api/veterinaires/medicaments?q=amoxicilline&limit=10',
  '/api/medicaments/search?q=',
  '/inexistant'
];
const VOLATILE_KEYS = new Set(['generated_at', 'uptime_seconds', 'memory']);

if (!process.env.DATA_DIR) {
  console.error('smoke:aot: DATA_DIR est obligatoire (dossier des données BDPM)');
  process.exit(1);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function copyData(work, name) {
  const dataDir = path.join(work, name, 'data');
  fs.cpSync(process.env.DATA_DIR, dataDir, { recursive: true, preserveTimestamps: true });
  let vetDataDir = path.join(dataDir, 'veterinaires');
  if (process.env.VET_DATA_DIR) {
    vetDataDir = path.join(work, name, 'veterinaires');
    fs.cpSync(process.env.VET_DATA_DIR, vetDataDir, { recursive: true, preserveTimestamps: true });
  }
  const cwd = path.join(work, name, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  return { cwd, dataDir, vetDataDir };
}

function start(label, command, args, port, { cwd, dataDir, vetDataDir }) {
  const env = {
    ...process.env,
    DATA_DIR: dataDir,
    VET_DATA_DIR: vetDataDir,
    PORT: String(port),
    NODE_ENV: 'production',
    RELOAD_STRATEGY: 'in-process',
    BDPM_CHECK_INTERVAL_HOURS: '596',
    VET_CHECK_INTERVAL_HOURS: '596',
    VET_LOAD_DEFERRED: 'false',
    ENABLE_RATE_LIMIT: 'false'
  };
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const server = { label, child, port, error: null, log: () => log };
  let log = '';
  child.on('error', (error) => { server.error = error; });
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  return server;
}

async function waitReady(server) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.error) throw new Error(`${server.label} : ${server.error.message}`);
    if (server.child.exitCode !== null) {
      throw new Error(`${server.label} s'est arrêté (code ${server.child.exitCode})\n${server.log()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`);
      if (response.ok) return;
    } catch {
      // pas encore à l'écoute
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${server.label} n'a pas répondu sur /health en ${timeoutMs} ms\n${server.log()}`);
}

function firstDifference(a, b, at = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return `${at || '.'} : ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const found = firstDifference(a[key], b[key], `${at}.${key}`);
    if (found) return found;
  }
  return null;
}

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (!VOLATILE_KEYS.has(key)) out[key] = stripVolatile(inner);
  }
  return out;
}

async function fetchNormalized(port, urlPath) {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`);
  const text = await response.text();
  let body = text;
  if ((response.headers.get('content-type') || '').includes('json')) {
    body = JSON.stringify(stripVolatile(JSON.parse(text)));
  }
  return { status: response.status, body };
}

async function main() {
  if (!fs.existsSync(binary)) throw new Error(`${binary} introuvable : lancer npm run build:aot`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'medicaments-smoke-aot-'));
  const servers = [];
  try {
    const [aotPort, nodePort] = [await freePort(), await freePort()];
    servers.push(start('exécutable AOT', binary, [], aotPort, copyData(work, 'aot')));
    servers.push(
      start('Node', process.execPath, [path.join(root, 'src', 'server.js')], nodePort, copyData(work, 'node'))
    );
    await Promise.all(servers.map(waitReady));
    let failures = 0;
    for (const urlPath of PATHS) {
      const [aot, node] = await Promise.all([
        fetchNormalized(aotPort, urlPath),
        fetchNormalized(nodePort, urlPath)
      ]);
      const same = aot.status === node.status && aot.body === node.body;
      if (!same) failures++;
      console.log(`${same ? 'ok  ' : 'DIFF'} ${aot.status} ${urlPath}${same ? '' : ` (Node : ${node.status})`}`);
      if (!same && aot.status === node.status) {
        let detail = 'corps différents';
        try {
          detail = firstDifference(JSON.parse(aot.body), JSON.parse(node.body)) || detail;
        } catch {
          // corps non JSON
        }
        console.log(`     ${detail}`);
      }
    }
    if (failures > 0) throw new Error(`${failures} chemin(s) diffèrent entre l'exécutable et Node`);
    console.log(`smoke:aot: ${PATHS.length} chemins identiques à Node`);
  } finally {
    await Promise.all(servers.map(stop));
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function stop({ child }) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}

main().catch((error) => {
  console.error(`smoke:aot: ${error.message}`);
  process.exitCode = 1;
});
