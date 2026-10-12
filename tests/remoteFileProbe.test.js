'use strict';

const http = require('node:http');
const axios = require('axios');
const { fetchRemoteFingerprint, parseIntervalHours } = require('../src/utils/remoteFileProbe');

afterEach(() => jest.restoreAllMocks());

test('abandonne le corps lorsque le serveur ignore Range et ne termine jamais sa réponse', async () => {
  let closeResponse;
  const responseClosed = new Promise(resolve => { closeResponse = resolve; });
  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') { res.writeHead(405); res.end(); return; }
    expect(req.headers.range).toBe('bytes=0-0');
    res.writeHead(200, { 'Content-Length': 1024 * 1024 * 100, ETag: 'test-etag' });
    res.write('premiers octets');
    res.on('close', closeResponse);
  });
  // Garder le proxy externe intact ; seule cette requête de test est sur loopback.
  const originalGet = axios.get.bind(axios);
  const originalHead = axios.head.bind(axios);
  jest.spyOn(axios, 'get').mockImplementation((url, opts) => originalGet(url, { ...opts, proxy: false }));
  jest.spyOn(axios, 'head').mockImplementation((url, opts) => originalHead(url, { ...opts, proxy: false }));
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const result = await fetchRemoteFingerprint(`http://127.0.0.1:${server.address().port}/file`);
    expect(result).toEqual({ etag: 'test-etag', lastModified: null, contentLength: 104857600 });
    await responseClosed;
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('accepte 596 heures et refuse le débordement qui lancerait un timer de 1 ms', () => {
  expect(parseIntervalHours('596', 72)).toBe(596);
  expect(() => parseIntervalHours('597', 72)).toThrow(RangeError);
  expect(parseIntervalHours('0', 72)).toBe(72);
});
