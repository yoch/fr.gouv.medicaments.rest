#!/usr/bin/env node
'use strict';

// Compare les réponses HTTP réelles de Node et Bun, sans Jest ni téléchargement.
// NODE_BIN=node BUN_BIN=bun node scripts/benchmark/verify-runtime-parity.js
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const worker = `
(async () => {
  const bdpm = require('./src/services/dataLoader');
  const vet = require('./src/services/vetDataLoader');
  await bdpm.loadData();
  await vet.loadVetData();
  require('./src/app').createApp().listen(0, '127.0.0.1', function () {
    console.log('__READY__' + this.address().port);
  });
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

function normalizeBody(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    if (k === 'generated_at' || k.endsWith('_updated_at') || k.endsWith('last_updated') || k === 'last_updated_at') {
      delete obj[k];
    } else if (typeof obj[k] === 'object') {
      normalizeBody(obj[k]);
    }
  }
}

function start(runtime, isStandalone = false) {
  return new Promise((resolve, reject) => {
    const args = isStandalone ? [] : ['-e', worker];
    const child = spawn(runtime, args, {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'production', ENABLE_RATE_LIMIT: 'false' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let errors = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${runtime}: délai de chargement dépassé\n${errors}`));
    }, 60_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`${runtime}: sortie ${code}\n${errors}`));
    });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/__READY__(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ child, url: `http://127.0.0.1:${match[1]}` });
      }
    });
  });
}

async function main() {
  const servers = [];
  try {
    // Chargements séquentiels pour éviter la contention entre runtimes.
    servers.push(await start(process.env.NODE_BIN || process.execPath));
    servers.push(await start(process.env.BUN_BIN || 'bun'));
    if (process.env.AOT_BIN) {
      servers.push(await start(process.env.AOT_BIN, true));
    }
    const paths = [
      '/api/medicaments/specialites?limit=20',
      '/api/medicaments/specialites?q=paracetamol&limit=10',
      '/api/medicaments/specialites?q=paracetamol&limit=10&page=2',
      '/api/medicaments/specialites?q=dolipran&limit=10',
      '/api/medicaments/specialites/60234100',
      '/api/medicaments/presentations?q=500&limit=20',
      '/api/medicaments/compositions?q=amoxicilline&limit=20',
      '/api/medicaments/substances?q=para&limit=10',
      '/api/medicaments/avis-smr?limit=10',
      '/api/medicaments/avis-asmr?limit=10',
      '/api/medicaments/groupes-generiques?limit=10',
      '/api/medicaments/conditions?limit=10',
      '/api/medicaments/disponibilite?limit=10',
      '/api/medicaments/disponibilite/alerts?limit=10',
      '/api/medicaments/disponibilite/alerts?q=doliprane&limit=10',
      '/api/medicaments/interet-therapeutique-majeur?limit=10',
      '/api/medicaments/search?q=paracetamol&limit=10',
      '/api/medicaments/search?q=sultrian&source=veterinary&limit=10',
      '/api/medicaments/search?q=amoxicilline&source=mixed&limit=10&detail=summary',
      '/api/medicaments/search?q=doliprane&limit=10&format=markdown',
      '/api/veterinaires/medicaments?limit=20',
      '/api/veterinaires/medicaments?q=sultrian&limit=10',
      '/api/veterinaires/medicaments?q=amoxi&limit=10&page=2',
      '/api/veterinaires/medicaments/0452300',
      '/api/veterinaires/compositions?q=amoxicilline&limit=10',
      '/api/veterinaires/presentations?q=boite&limit=10',
      '/api/medicaments/search',
      '/api/veterinaires/medicaments/0000000'
    ];
    for (const endpoint of paths) {
      const responses = await Promise.all(servers.map(async server => {
        const response = await fetch(server.url + endpoint, { signal: AbortSignal.timeout(15_000) });
        const text = await response.text();
        const body = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
        normalizeBody(body);
        return { status: response.status, body };
      }));
      for (let i = 1; i < responses.length; i++) {
        assert.deepEqual(responses[i], responses[0], `${endpoint} (server #${i} vs #0)`);
      }
      const expectedStatus = endpoint === '/api/medicaments/search' ? 400
        : endpoint.endsWith('/0000000') ? 404 : 200;
      assert.equal(responses[0].status, expectedStatus, endpoint);
    }
    console.log(`${paths.length} réponses HTTP identiques entre ${servers.length} runtimes (Node, Bun JIT${process.env.AOT_BIN ? ', Bun AOT' : ''}) (statut et contenu).`);
  } finally {
    await Promise.all(servers.map(({ child }) => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill();
    })));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
