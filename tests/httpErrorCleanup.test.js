'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const axios = require('axios');
const { fetchRemoteFingerprint } = require('../src/utils/remoteFileProbe');
const { downloadFile } = require('../src/services/download/syncHelpers');

test.each([
  ['probe', 404, false], ['probe', 503, false],
  ['download', 404, false], ['download', 503, false],
  ['probe', 404, true], ['probe', 503, true],
  ['download', 404, true], ['download', 503, true]
])('%s ferme une réponse %i sans fin (gzip=%s)', async (operation, status, gzip) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-error-cleanup-'));
  const previousProxy = axios.defaults.proxy;
  axios.defaults.proxy = false; // Uniquement le serveur loopback de ce test.
  const openResponses = new Set();
  let closed;
  let closeDeadline;
  let timer;
  const responseClosed = new Promise(resolve => { closed = resolve; });
  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') { res.writeHead(405); res.end(); return; }
    openResponses.add(res);
    res.once('close', () => { openResponses.delete(res); closed(true); });
    res.writeHead(status, gzip ? { 'Content-Encoding': 'gzip' } : {});
    res.write(gzip ? gzipSync('erreur distante') : 'erreur distante');
    // Ne jamais terminer : le client doit abandonner le corps après le rejet.
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/file`;
    const request = operation === 'probe'
      ? fetchRemoteFingerprint(url, { timeout: 10000 })
      : downloadFile(url, path.join(dir, 'file'), { timeoutMs: 10000 });
    await expect(request).rejects.toMatchObject({ response: { status: operation === 'probe' ? 405 : status } });
    closeDeadline = new Promise(resolve => { timer = setTimeout(() => resolve(false), 300); });
    expect(await Promise.race([responseClosed, closeDeadline])).toBe(true);
    expect(openResponses.size).toBe(0);
    expect(fs.existsSync(path.join(dir, 'file'))).toBe(false);
  } finally {
    clearTimeout(timer);
    axios.defaults.proxy = previousProxy;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
