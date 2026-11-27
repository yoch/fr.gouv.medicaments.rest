'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Un 7za absent ne doit ni télécharger l'archive ni enregistrer son hash : sinon le
// cycle suivant la croirait à jour et ne l'extrairait plus jamais.
describe('vetDataDownloader sans 7za', () => {
  const env = { ...process.env };
  let dir;

  afterEach(() => {
    process.env = { ...env };
    jest.resetModules();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ne télécharge pas l\'archive et ne touche pas meta.json', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vet-7za-'));
    process.env.DATA_DIR = dir;
    process.env.VET_DATA_DIR = dir;
    process.env.SEVEN_ZIP_PATH = path.join(dir, 'absent', '7za');

    const downloadFile = jest.fn(async () => 'hash');
    const saveJsonMeta = jest.fn(async () => {});
    jest.doMock('../src/services/download/syncHelpers', () => ({
      hashFile: jest.fn(),
      loadJsonMeta: jest.fn(async () => ({})),
      saveJsonMeta,
      downloadFile,
      probeRemote: jest.fn(async () => null),
      remoteUnchanged: jest.fn(() => false),
      touchChecked: jest.fn()
    }));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { downloadVetDataIfNeeded } = require('../src/services/vetDataDownloader');
    await downloadVetDataIfNeeded();

    const archiveCalls = downloadFile.mock.calls.filter(([url]) => url.endsWith('.7z'));
    expect(archiveCalls).toHaveLength(0);
    for (const [, metadata] of saveJsonMeta.mock.calls) {
      expect(metadata).not.toHaveProperty(['amm-vet-fr-v2-v.7z']);
    }
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('amm-vet-fr-v2-v.7z'),
      expect.stringMatching(/7za introuvable ou non exécutable/)
    );
  });
});
