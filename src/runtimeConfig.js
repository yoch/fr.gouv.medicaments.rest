'use strict';

const { version } = require('../package.json');
const { CHECK_INTERVAL_HOURS: BDPM_CHECK_INTERVAL_HOURS } = require('./services/dataDownloader');
const { CHECK_INTERVAL_HOURS: VET_CHECK_INTERVAL_HOURS } = require('./services/vetDataDownloader');
const {
  isHasAvisLoaded,
  isMitmLoaded,
  HYDRATE_RELATED_LIMIT: SEARCH_HYDRATE_RELATED_LIMIT,
  DETAIL_HYDRATE_RELATED_LIMIT
} = require('./services/dataLoader');
const {
  isCorpusLightProfile,
  presentationIndexFields,
  OMIT_STORED_FIELDS_BY_TYPE
} = require('./utils/corpusLightProfile');
const { internPoolSize } = require('./utils/stringPool');

function getRuntimeConfig() {
  const corpusLight = isCorpusLightProfile();

  return {
    version,
    node_env: process.env.NODE_ENV || 'development',
    reload_strategy: String(process.env.RELOAD_STRATEGY || 'in-process').toLowerCase(),
    features: {
      load_has_avis: isHasAvisLoaded(),
      load_mitm: isMitmLoaded(),
      corpus_light_profile: corpusLight,
      vet_load_deferred: process.env.VET_LOAD_DEFERRED === 'true',
      enable_rate_limit: process.env.ENABLE_RATE_LIMIT === 'true'
    },
    intervals_hours: {
      bdpm_check: BDPM_CHECK_INTERVAL_HOURS,
      vet_check: VET_CHECK_INTERVAL_HOURS
    },
    limits: {
      search_hydrate_related: SEARCH_HYDRATE_RELATED_LIMIT,
      detail_hydrate_related: DETAIL_HYDRATE_RELATED_LIMIT,
      vet_load_delay_ms: Math.max(0, parseInt(process.env.VET_LOAD_DELAY_MS || '0', 10)),
      rate_limit_window_ms: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
      rate_limit_max: parseInt(process.env.RATE_LIMIT_MAX || '500', 10)
    },
    corpus_light_omit_fields: corpusLight ? { ...OMIT_STORED_FIELDS_BY_TYPE } : null,
    presentation_index_fields: presentationIndexFields(),
    string_pool_size: internPoolSize()
  };
}

module.exports = { getRuntimeConfig };
