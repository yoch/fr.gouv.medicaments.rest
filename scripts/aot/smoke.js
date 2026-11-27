#!/usr/bin/env node
'use strict';

/**
 * Compare l'exécutable compilé (npm run build:aot) au serveur Node sur les mêmes données.
 *
 *   DATA_DIR=/chemin/data [VET_DATA_DIR=…] npm run smoke:aot
 *
 * Les deux serveurs démarrent sur des ports libres, avec des intervalles de
 * rafraîchissement maximaux (pas de téléchargement si les données sont récentes), puis
 * chaque chemin doit donner le même statut et le même corps. Les champs qui dépendent de
 * l'instant ou du processus (horodatages, mémoire, uptime) sont ignorés.
 * Variables : AOT_BINARY (défaut dist/medicaments-api), SMOKE_TIMEOUT_MS (défaut 120000).
 */

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const binary = process.env.AOT_BINARY || path.join(root, 'dist', 'medicaments-api');
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS) || 120000;

const PATHS = [
  '/',
  '/api-docs/',
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

function start(label, command, args, port) {
  const env = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
    RELOAD_STRATEGY: 'in-process',
    BDPM_CHECK_INTERVAL_HOURS: '596',
    VET_CHECK_INTERVAL_HOURS: '596',
    VET_LOAD_DEFERRED: 'false',
    ENABLE_RATE_LIMIT: 'false'
  };
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  return { label, child, port, log: () => log };
}

async function waitReady(server) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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
  const [aotPort, nodePort] = [await freePort(), await freePort()];
  const servers = [
    start('exécutable AOT', binary, [], aotPort),
    start('Node', process.execPath, ['src/server.js'], nodePort)
  ];
  try {
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
    for (const { child } of servers) child.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(`smoke:aot: ${error.message}`);
  process.exitCode = 1;
});
