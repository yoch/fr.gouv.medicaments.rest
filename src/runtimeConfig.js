'use strict';

const { version } = require('../package.json');
const config = require('./config');
const {
  isCorpusLightProfile,
  presentationIndexFields,
  OMIT_STORED_FIELDS_BY_TYPE
} = require('./utils/corpusLightProfile');
const { internPoolSize } = require('./utils/stringPool');

/**
 * Expose une vue sluggée (snake_case) de la config runtime via GET /config.
 * Garde la même forme que depuis l'origine pour ne pas casser le contrat API.
 */
function getRuntimeConfig() {
  const corpusLight = isCorpusLightProfile();

  return {
    version,
    node_env: config.nodeEnv,
    reload_strategy: config.reloadStrategy,
    features: {
      load_has_avis: config.loadHasAvis,
      load_mitm: config.loadMitm,
      corpus_light_profile: corpusLight,
      vet_load_deferred: config.vetLoadDeferred,
      post_load_gc: config.postLoadGc,
      enable_rate_limit: config.enableRateLimit
    },
    intervals_hours: {
      bdpm_check: config.bdpmCheckIntervalHours,
      vet_check: config.vetCheckIntervalHours
    },
    limits: {
      search_hydrate_related: config.searchHydrateRelatedLimit,
      detail_hydrate_related: config.detailHydrateRelatedLimit,
      vet_load_delay_ms: config.vetLoadDelayMs,
      rate_limit_window_ms: config.rateLimitWindowMs,
      rate_limit_max: config.rateLimitMax
    },
    corpus_light_omit_fields: corpusLight ? { ...OMIT_STORED_FIELDS_BY_TYPE } : null,
    presentation_index_fields: presentationIndexFields(),
    string_pool_size: internPoolSize()
  };
}

module.exports = { getRuntimeConfig };
