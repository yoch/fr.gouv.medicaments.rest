'use strict';

const path = require('path');

// MEDICAMENTS_STANDALONE vaut "1" dans l'exécutable compilé (--define de build:aot).
describe('config de l\'exécutable compilé', () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
    jest.resetModules();
  });

  function loadConfig() {
    jest.resetModules();
    return require('../src/config');
  }

  it('sous Node, garde les défauts relatifs au dépôt et le 7za de 7zip-bin', () => {
    delete process.env.MEDICAMENTS_STANDALONE;
    delete process.env.DATA_DIR;
    delete process.env.SEVEN_ZIP_PATH;

    const config = loadConfig();

    expect(config.standalone).toBe(false);
    expect(config.dataDir).toBe(path.join(__dirname, '../data'));
    expect(config.sevenZipPath).toBeNull();
  });

  it('exige DATA_DIR', () => {
    process.env.MEDICAMENTS_STANDALONE = '1';
    delete process.env.DATA_DIR;

    expect(() => loadConfig()).toThrow(/DATA_DIR est obligatoire/);
  });

  it('cherche 7za à côté de l\'exécutable par défaut', () => {
    process.env.MEDICAMENTS_STANDALONE = '1';
    process.env.DATA_DIR = '/srv/medicaments/data';
    delete process.env.VET_DATA_DIR;
    delete process.env.SEVEN_ZIP_PATH;

    const config = loadConfig();

    expect(config.standalone).toBe(true);
    expect(config.dataDir).toBe('/srv/medicaments/data');
    expect(config.vetDataDir).toBe(path.join('/srv/medicaments/data', 'veterinaires'));
    expect(config.sevenZipPath).toBe(path.join(path.dirname(process.execPath), '7za'));
  });

  it('respecte SEVEN_ZIP_PATH', () => {
    process.env.MEDICAMENTS_STANDALONE = '1';
    process.env.DATA_DIR = '/srv/medicaments/data';
    process.env.SEVEN_ZIP_PATH = '/usr/bin/7za';

    expect(loadConfig().sevenZipPath).toBe('/usr/bin/7za');
  });
});
