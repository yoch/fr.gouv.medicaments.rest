'use strict';

describe('runtimeConfig', () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
    jest.resetModules();
  });

  function loadConfig() {
    jest.resetModules();
    return require('../src/runtimeConfig').getRuntimeConfig();
  }

  it('expose les feature flags et la version', () => {
    process.env.LOAD_HAS_AVIS = 'false';
    process.env.LOAD_MITM = 'false';
    process.env.CORPUS_LIGHT_PROFILE = 'true';
    process.env.RELOAD_STRATEGY = 'restart';
    process.env.VET_LOAD_DEFERRED = 'true';
    process.env.VET_LOAD_DELAY_MS = '15000';

    const config = loadConfig();

    expect(config.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(config.reload_strategy).toBe('restart');
    expect(config.features).toEqual({
      load_has_avis: false,
      load_mitm: false,
      corpus_light_profile: true,
      vet_load_deferred: true,
      enable_rate_limit: false
    });
    expect(config.limits.vet_load_delay_ms).toBe(15000);
    expect(config.corpus_light_omit_fields.presentations).toContain('indications');
    expect(config.presentation_index_fields).not.toContain('indications');
  });

  it('corpus_light_profile est indépendant de LOAD_HAS_AVIS', () => {
    process.env.LOAD_HAS_AVIS = 'false';
    delete process.env.CORPUS_LIGHT_PROFILE;

    const config = loadConfig();

    expect(config.features.load_has_avis).toBe(false);
    expect(config.features.corpus_light_profile).toBe(false);
    expect(config.corpus_light_omit_fields).toBeNull();
    expect(config.presentation_index_fields).toContain('indications');
  });
});
