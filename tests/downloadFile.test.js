'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { downloadFile } = require('../src/services/download/syncHelpers');
const { fetchRemoteFingerprint } = require('../src/utils/remoteFileProbe');
const { describeError } = require('../src/utils/httpErrors');

let dir;
let server;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'download-file-'));
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  jest.restoreAllMocks();
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    server = null;
  }
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
    .rejects.toMatchObject({ name: 'TimeoutError', message: 'aucune donnée reçue depuis 150 ms' });
  expect(Date.now() - started).toBeLessThan(3000);
  await responseClosed;
});

test('le délai d’inactivité couvre l’attente des en-têtes', async () => {
  const base = await listen(() => {});
  await expect(downloadFile(`${base}/f`, path.join(dir, 'out'), { timeoutMs: 150 }))
    .rejects.toMatchObject({ code: 'ETIMEDOUT', message: 'aucune donnée reçue depuis 150 ms' });
});

test('la réception des en-têtes relance le délai d’inactivité', async () => {
  const base = await listen((req, res) => {
    setTimeout(() => {
      res.writeHead(200);
      res.flushHeaders();
      setTimeout(() => res.end('ok'), 150);
    }, 150);
  });
  const file = path.join(dir, 'out');
  await downloadFile(`${base}/f`, file, { timeoutMs: 250 });
  expect(fs.readFileSync(file, 'utf8')).toBe('ok');
});

test('la durée totale borne un vrai transfert continu', async () => {
  let closed;
  const responseClosed = new Promise(resolve => { closed = resolve; });
  const base = await listen((req, res) => {
    res.writeHead(200);
    const timer = setInterval(() => res.write('x'), 10);
    res.on('close', () => { clearInterval(timer); closed(); });
  });
  await expect(downloadFile(`${base}/f`, path.join(dir, 'out'), { timeoutMs: 1000, totalTimeoutMs: 150 }))
    .rejects.toMatchObject({ name: 'TimeoutError', message: 'durée totale de 150 ms dépassée' });
  await responseClosed;
});

test('refuse une réponse 2xx sans corps au lieu d’écrire un fichier vide', async () => {
  const base = await listen((req, res) => { res.writeHead(204); res.end(); });
  const file = path.join(dir, 'out');
  await expect(downloadFile(`${base}/f`, file)).rejects.toThrow('réponse HTTP 204 sans corps');
  expect(fs.existsSync(file)).toBe(false);
});

test('describeError expose la cause réseau masquée par « fetch failed »', async () => {
  const base = await listen(() => {});
  server.close();
  server = null;
  const error = await downloadFile(`${base}/f`, path.join(dir, 'out')).catch(e => e);
  expect(error.message).toBe('fetch failed');
  expect(describeError(error)).toMatch(/^fetch failed \(.*ECONNREFUSED/);
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

test('la sonde se rabat sur GET Range et lit la taille totale de Content-Range', async () => {
  const seen = [];
  const base = await listen((req, res) => {
    seen.push(`${req.method} ${req.headers.range ?? ''}`.trim());
    if (req.method === 'HEAD') { res.writeHead(405); res.end(); return; }
    res.writeHead(206, { ETag: '"r"', 'Content-Range': 'bytes 0-0/5000', 'Content-Length': 1 });
    res.end('x');
  });
  expect(await fetchRemoteFingerprint(`${base}/f`)).toEqual({
    etag: '"r"', lastModified: null, contentLength: 5000
  });
  expect(seen).toEqual(['HEAD', 'GET bytes=0-0']);
});

test('une réponse 206 de taille totale inconnue ne donne pas de taille', async () => {
  const base = await listen((req, res) => {
    if (req.method === 'HEAD') { res.writeHead(405); res.end(); return; }
    res.writeHead(206, { 'Content-Range': 'bytes 0-0/*', 'Content-Length': 1 });
    res.end('x');
  });
  expect(await fetchRemoteFingerprint(`${base}/f`)).toEqual({
    etag: null, lastModified: null, contentLength: null
  });
});

test('la sonde échoue après le délai si le serveur ne répond jamais', async () => {
  const base = await listen(() => {});
  await expect(fetchRemoteFingerprint(`${base}/f`, { timeout: 150 }))
    .rejects.toMatchObject({ name: 'TimeoutError', message: 'aucune réponse depuis 150 ms' });
});

test('describeError détaille une AggregateError de connexion IPv6 + IPv4', () => {
  const cause = Object.assign(new AggregateError([
    new Error('connect ECONNREFUSED ::1:443'),
    new Error('connect ECONNREFUSED 127.0.0.1:443')
  ], ''), { code: 'ECONNREFUSED' });
  expect(describeError(new TypeError('fetch failed', { cause })))
    .toBe('fetch failed (connect ECONNREFUSED ::1:443 ; connect ECONNREFUSED 127.0.0.1:443)');
});
