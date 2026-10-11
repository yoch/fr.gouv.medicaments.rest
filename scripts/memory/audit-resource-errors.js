#!/usr/bin/env node
'use strict';

// Injecte des erreurs dans des processus isolés ; n'appelle aucune URL distante.
// node --expose-gc scripts/memory/audit-resource-errors.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const root = path.resolve(__dirname, '../..');

async function runCase(name) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'medicaments-audit-'));
  const result = { name };
  const cleanups = [];
  const errors = [];
  const onUncaught = error => errors.push(error.message);
  process.on('uncaughtException', onUncaught);
  let source, sink;
  try {
    if (name === 'pool-reload') {
      process.env.VET_DATA_DIR = temp;
      process.env.VET_PRODUCTS_FILE = 'products.xml';
      process.env.VET_DICT_FILE = 'dict.xml';
      fs.writeFileSync(path.join(temp, 'dict.xml'), '<root/>');
      const { loadVetData } = require('../../src/services/vetDataLoader');
      const { internPoolSize, clearInternPool } = require('../../src/utils/stringPool');
      const state = require('../../src/services/vet/state');
      result.cycles = [];
      for (let cycle = 0; cycle < 3; cycle++) {
        let xml = '<root>\n';
        for (let n = 0; n < 1000; n++) {
          xml += `<medicinal-product><num>${n + 1}</num><nom>Produit ${n}</nom><maj-rcp>AUDIT_DATE_${cycle}_${n}</maj-rcp><modele-destine-vente><mod-vte><lib-mod>AUDIT_LIBELLE_${cycle}_${n} emballage nouveau</lib-mod></mod-vte></modele-destine-vente></medicinal-product>\n`;
        }
        fs.writeFileSync(path.join(temp, 'products.xml'), xml + '</root>');
        await loadVetData();
        if (global.gc) global.gc();
        result.cycles.push({ cycle, pool: internPoolSize(), rows: state.corpus.medicaments.length, heap_used: process.memoryUsage().heapUsed });
      }
      state.reset();
      for (const rows of Object.values(state.corpus)) rows.length = 0;
      if (global.gc) global.gc();
      result.pool_after_corpus_reset = internPoolSize();
      clearInternPool();
      if (global.gc) global.gc();
      result.pool_after_explicit_clear = internPoolSize();
    } else if (['download-source-error', 'download-writer-error', 'download-directory-error'].includes(name)) {
      source = new PassThrough();
      sink = new Writable({ write(chunk, encoding, callback) { callback(new Error('AUDIT_DISK_FULL')); } });
      // Remplacer axios uniquement dans ce worker, avant import du helper.
      const axiosPath = require.resolve('axios');
      require('axios');
      let requests = 0;
      require.cache[axiosPath].exports = async () => { requests++; return { data: source }; };
      const extra = require('fs-extra');
      const originalWrite = extra.createWriteStream;
      const originalEnsure = extra.ensureDir;
      let writerCreated = false;
      cleanups.push(() => { extra.createWriteStream = originalWrite; extra.ensureDir = originalEnsure; });
      extra.createWriteStream = (...args) => {
        writerCreated = true;
        if (name !== 'download-writer-error') sink = originalWrite(...args);
        return sink;
      };
      if (name === 'download-directory-error') extra.ensureDir = async () => { throw new Error('AUDIT_DIRECTORY_FAILURE'); };
      const { downloadFile } = require('../../src/services/download/syncHelpers');
      let status = 'pending';
      const download = downloadFile('http://audit.invalid/local-mock', path.join(temp, 'file'));
      download.then(() => { status = 'resolved'; }, error => { status = `rejected: ${error.message}`; });
      await delay(50);
      if (name === 'download-source-error') source.destroy(new Error('AUDIT_SOCKET_RESET'));
      if (name === 'download-writer-error') source.write('data');
      await delay(100);
      Object.assign(result, { promise_status: status, source_destroyed: source.destroyed,
        http_requests: requests,
        source_error_listeners: source.listenerCount('error'),
        writer_created: writerCreated,
        writer_destroyed: writerCreated ? sink.destroyed : null,
        writer_finished: writerCreated ? sink.writableFinished : null,
        uncaught_errors: errors.slice() });
    } else if (name === 'csv-source-error') {
      const original = fs.createReadStream;
      cleanups.push(() => { fs.createReadStream = original; });
      source = new PassThrough();
      fs.createReadStream = () => source;
      let status = 'pending';
      require('../../src/services/dataLoader').loadData().then(
        () => { status = 'resolved'; }, error => { status = `rejected: ${error.message}`; });
      await delay(50);
      source.destroy(new Error('AUDIT_CSV_READ_FAILURE'));
      await delay(100);
      Object.assign(result, { promise_status: status, source_error_listeners: source.listenerCount('error'), uncaught_errors: errors.slice() });
    } else if (name === 'header-fd-error') {
      process.env.VET_DATA_DIR = path.join(root, 'tests/fixtures/veterinaires');
      process.env.VET_PRODUCTS_FILE = 'amm-vet-fixture.xml';
      process.env.VET_DICT_FILE = 'amm-vet-d-fixture.xml';
      const originalOpen = fs.openSync;
      const originalRead = fs.readSync;
      const originalClose = fs.closeSync;
      const opened = [];
      const closed = [];
      fs.openSync = function(file, ...args) {
        const fd = originalOpen.call(this, file, ...args);
        if (String(file).endsWith('amm-vet-fixture.xml')) opened.push(fd);
        return fd;
      };
      fs.readSync = function(fd, ...args) {
        if (opened.includes(fd)) throw new Error('AUDIT_HEADER_READ_FAILURE');
        return originalRead.call(this, fd, ...args);
      };
      fs.closeSync = function(fd) { closed.push(fd); return originalClose.call(this, fd); };
      cleanups.push(() => {
        fs.openSync = originalOpen; fs.readSync = originalRead; fs.closeSync = originalClose;
        for (const fd of opened) if (!closed.includes(fd)) originalClose(fd);
      });
      await require('../../src/services/vetDataLoader').loadVetData();
      Object.assign(result, { header_fds_opened: opened.length, header_fds_closed: opened.filter(fd => closed.includes(fd)).length });
    } else if (name === 'refresh-overlap') {
      let bdpmCalls = 0;
      let releaseDownload;
      function replace(modulePath, exports) {
        const resolved = require.resolve(modulePath);
        require(modulePath);
        require.cache[resolved].exports = exports;
      }
      replace('../../src/services/dataDownloader', { downloadDataIfNeeded: () => {
        bdpmCalls++;
        return bdpmCalls === 1 ? Promise.resolve({ changed: false }) : new Promise(resolve => {
          releaseDownload = () => resolve({ changed: false });
        });
      } });
      replace('../../src/services/vetDataDownloader', { downloadVetDataIfNeeded: async () => ({ changed: false }) });
      replace('../../src/services/dataLoader', { loadData: async () => {} });
      replace('../../src/services/vetDataLoader', { loadVetData: async () => {} });
      replace('../../src/app', { createApp: () => ({ listen() {
        const server = new (require('node:events').EventEmitter)();
        server.listening = true;
        server.close = callback => { server.listening = false; callback(); };
        queueMicrotask(() => server.emit('listening'));
        return server;
      } }) });
      const originalTimeout = global.setTimeout;
      global.setTimeout = () => ({ unref() {} });
      cleanups.push(() => { global.setTimeout = originalTimeout; });
      const running = await require('../../src/server').startServer();
      const first = running.refreshBdpm();
      const shared = [running.refreshBdpm(), running.refreshBdpm()].every(promise => promise === first);
      await Promise.resolve();
      Object.assign(result, { startup_bdpm_calls: 1, total_bdpm_calls: bdpmCalls,
        simultaneous_refreshes: bdpmCalls - 1, shared_promise: shared });
      releaseDownload();
      await first;
      await running.stop();
    } else if (name === 'timer-overflow') {
      process.env.BDPM_CHECK_INTERVAL_HOURS = '597';
      try {
        require('../../src/config');
        result.configuration_rejected = false;
      } catch (error) {
        Object.assign(result, { configuration_rejected: true, error: error.message });
      }
    } else if (name === 'range-ignored') {
      const http = require('node:http');
      const payloadBytes = 4 * 1024 * 1024;
      const server = http.createServer((req, res) => {
        if (req.method === 'HEAD') { res.writeHead(405); res.end(); return; }
        result.range_header = req.headers.range;
        res.setHeader('Content-Length', payloadBytes);
        res.end(Buffer.alloc(payloadBytes, 'x'));
      });
      server.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      cleanups.push(() => { server.closeAllConnections(); server.close(); });
      // Loopback uniquement ; conserver le proxy pour tout accès externe.
      process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1'].filter(Boolean).join(',');
      const before = process.memoryUsage();
      const fingerprint = await require('../../src/utils/remoteFileProbe').fetchRemoteFingerprint(`http://127.0.0.1:${server.address().port}/file`);
      Object.assign(result, { payload_bytes: payloadBytes, fingerprint, before, after: process.memoryUsage() });
    } else throw new Error(`Cas inconnu: ${name}`);
    return result;
  } finally {
    if (source && !source.destroyed) source.destroy();
    if (sink && !sink.destroyed) sink.destroy();
    for (const cleanup of cleanups.reverse()) cleanup();
    process.removeListener('uncaughtException', onUncaught);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv[2] === '--case') {
    const result = await runCase(process.argv[3]);
    console.log('__RESULT__' + JSON.stringify(result));
    // Les cas injectés peuvent garder une promesse/ressource ouverte par construction.
    process.exit(0);
  }
  const results = [];
  for (const name of ['pool-reload', 'download-source-error', 'download-writer-error', 'download-directory-error', 'csv-source-error', 'header-fd-error', 'refresh-overlap', 'timer-overflow', 'range-ignored']) {
    const child = spawnSync(process.execPath, [...process.execArgv, __filename, '--case', name], {
      cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024
    });
    if (child.status !== 0 || child.error) throw new Error(`${name}: ${child.error || child.stderr}`);
    const line = child.stdout.split('\n').find(row => row.startsWith('__RESULT__'));
    if (!line) throw new Error(`${name}: résultat manquant`);
    results.push(JSON.parse(line.slice('__RESULT__'.length)));
  }
  const out = path.resolve(process.env.AUDIT_ERRORS_OUT || path.join(root, 'tmp/memory-audit/resource-errors.json'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ runtime: process.version, results }, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
  console.log(`Résultats: ${out}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
