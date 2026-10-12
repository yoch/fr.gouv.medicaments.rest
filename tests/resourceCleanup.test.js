'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { PassThrough, Readable, Writable } = require('node:stream');
const { once } = require('node:events');

jest.mock('axios', () => jest.fn());

describe('fermeture des ressources', () => {
  let dir;
  let extra;
  let axios;
  let writer;
  let helpers;

  beforeEach(() => {
    jest.resetModules();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-cleanup-'));
    axios = require('axios');
    extra = require('fs-extra');
    const originalWrite = extra.createWriteStream;
    jest.spyOn(extra, 'createWriteStream').mockImplementation((...args) => {
      writer = originalWrite(...args);
      return writer;
    });
    helpers = require('../src/services/download/syncHelpers');
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('télécharge et hashe après fermeture du fichier', async () => {
    const source = Readable.from(['bonjour']);
    axios.mockResolvedValue({ data: source });
    const file = path.join(dir, 'download');
    expect(await helpers.downloadFile('http://test.invalid', file))
      .toBe(crypto.createHash('sha256').update('bonjour').digest('hex'));
    expect(fs.readFileSync(file, 'utf8')).toBe('bonjour');
    expect(source.destroyed).toBe(true);
    expect(writer.closed).toBe(true);
    await expect(helpers.hashFile(path.join(dir, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('rejette une erreur source et ferme le writer', async () => {
    const source = new PassThrough();
    axios.mockResolvedValue({ data: source });
    const ready = once(source, 'resume');
    const result = expect(helpers.downloadFile('http://test.invalid', path.join(dir, 'file')))
      .rejects.toThrow('socket reset');
    await ready;
    source.destroy(new Error('socket reset'));
    await result;
    expect(writer.closed).toBe(true);
  });

  test('détruit la réponse HTTP en cas de disque plein', async () => {
    const source = new PassThrough();
    const failedWriter = new Writable({ write(chunk, encoding, callback) { callback(new Error('disk full')); } });
    extra.createWriteStream.mockReturnValue(failedWriter);
    axios.mockResolvedValue({ data: source });
    const ready = once(source, 'resume');
    const result = expect(helpers.downloadFile('http://test.invalid', path.join(dir, 'file')))
      .rejects.toThrow('disk full');
    await ready;
    source.write('data');
    await result;
    expect(source.destroyed).toBe(true);
    expect(failedWriter.destroyed).toBe(true);
  });

  test('ne démarre pas de requête si le dossier ne peut pas être créé', async () => {
    jest.spyOn(extra, 'ensureDir').mockRejectedValue(new Error('permission denied'));
    await expect(helpers.downloadFile('http://test.invalid', path.join(dir, 'file')))
      .rejects.toThrow('permission denied');
    expect(axios).not.toHaveBeenCalled();
  });

  test('détruit la réponse si la création du writer échoue synchroniquement', async () => {
    const source = new PassThrough();
    axios.mockResolvedValue({ data: source });
    extra.createWriteStream.mockImplementation(() => { throw new Error('cannot open'); });
    await expect(helpers.downloadFile('http://test.invalid', path.join(dir, 'file')))
      .rejects.toThrow('cannot open');
    expect(source.destroyed).toBe(true);
  });

  test('borne la durée totale même si la source envoie continuellement des octets', async () => {
    const source = new PassThrough();
    axios.mockResolvedValue({ data: source });
    const timer = setInterval(() => source.write('x'), 5);
    try {
      await expect(helpers.downloadFile('http://test.invalid', path.join(dir, 'file'), { totalTimeoutMs: 40 }))
        .rejects.toMatchObject({ name: 'AbortError' });
      expect(source.destroyed).toBe(true);
      expect(writer.closed).toBe(true);
    } finally {
      clearInterval(timer);
    }
  });

  test('propage une erreur de lecture CSV et libère la source', async () => {
    const source = new PassThrough();
    const exists = fs.existsSync;
    jest.spyOn(fs, 'existsSync').mockImplementation(file => String(file).endsWith('.txt') || exists(file));
    jest.spyOn(fs, 'createReadStream').mockReturnValue(source);
    const ready = once(source, 'resume');
    const loader = require('../src/services/dataLoader');
    const first = loader.loadData();
    expect(loader.loadData()).toBe(first);
    const result = expect(first).rejects.toThrow('csv read failed');
    await ready;
    source.destroy(new Error('csv read failed'));
    await result;
    expect(source.destroyed).toBe(true);
    expect(fs.createReadStream).toHaveBeenCalledTimes(1);
  });

  test('annule la lecture CSV si l’indexeur échoue avant de consommer le flux', async () => {
    const source = new PassThrough();
    const exists = fs.existsSync;
    jest.spyOn(fs, 'existsSync').mockImplementation(file => String(file).endsWith('.txt') || exists(file));
    jest.spyOn(fs, 'createReadStream').mockReturnValue(source);
    jest.spyOn(require('../src/utils/frozenMiniSearch'), 'buildFrozenIndexFromAsyncIterable')
      .mockRejectedValue(new Error('index failed'));
    await expect(require('../src/services/dataLoader').loadData()).rejects.toThrow('index failed');
    expect(source.destroyed).toBe(true);
  });
});
