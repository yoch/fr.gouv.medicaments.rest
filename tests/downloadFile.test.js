'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { downloadFile } = require('../src/services/download/syncHelpers');
const { fetchRemoteFingerprint } = require('../src/utils/remoteFileProbe');

let dir;
let server;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'download-file-'));
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  jest.restoreAllMocks();
  server?.closeAllConnections();
  await new Promise(resolve => server?.close(resolve));
  server = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function listen(handler) {
  server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('suit une redirection, envoie les en-têtes et retourne le SHA-256', async () => {
  let seenHeader;
  const base = await listen((req, res) => {
    if (req.url === '/start') { res.writeHead(302, { Location: '/final' }); res.end(); return; }
    seenHeader = req.headers['x-test'];
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('contenu distant');
  });
  const file = path.join(dir, 'out');
  const hash = await downloadFile(`${base}/start`, file, { headers: { 'X-Test': 'oui' } });
  expect(hash).toBe(crypto.createHash('sha256').update('contenu distant').digest('hex'));
  expect(fs.readFileSync(file, 'utf8')).toBe('contenu distant');
  expect(seenHeader).toBe('oui');
});

test('abandonne un transfert silencieux après le délai d’inactivité', async () => {
  let closed;
  const responseClosed = new Promise(resolve => { closed = resolve; });
  const base = await listen((req, res) => {
    res.writeHead(200);
    res.write('début');
    res.on('close', closed);
  });
  const started = Date.now();
  await expect(downloadFile(`${base}/f`, path.join(dir, 'out'), { timeoutMs: 150 }))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(Date.now() - started).toBeLessThan(3000);
  await responseClosed;
});

test('un transfert lent mais actif n’est pas interrompu par le délai d’inactivité', async () => {
  const base = await listen((req, res) => {
    res.writeHead(200);
    let n = 0;
    const timer = setInterval(() => {
      res.write('x');
      if (++n === 8) { clearInterval(timer); res.end(); }
    }, 40);
    res.on('close', () => clearInterval(timer));
  });
  const file = path.join(dir, 'out');
  await downloadFile(`${base}/f`, file, { timeoutMs: 200 });
  expect(fs.readFileSync(file, 'utf8')).toBe('xxxxxxxx');
});

test('la sonde lit etag, last-modified et content-length via HEAD', async () => {
  const base = await listen((req, res) => {
    res.writeHead(200, { ETag: '"abc"', 'Last-Modified': 'Wed, 21 Oct 2026 07:28:00 GMT', 'Content-Length': 42 });
    res.end();
  });
  expect(await fetchRemoteFingerprint(`${base}/f`)).toEqual({
    etag: '"abc"', lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT', contentLength: 42
  });
});

test('la sonde échoue après le délai si le serveur ne répond jamais', async () => {
  const base = await listen(() => {});
  await expect(fetchRemoteFingerprint(`${base}/f`, { timeout: 150 })).rejects.toBeDefined();
});
