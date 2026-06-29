'use strict';

/**
 * Source unique de vérité pour la configuration runtime.
 *
 * Toute lecture de `process.env` hors de ce module est un smell — la config
 * est figée au démarrage et consommée sous forme d'objet gelé. Les variables
 * documentées dans `.env.example` doivent toutes apparaître ici.
 */

const path = require('path');
const { parseIntervalHours } = require('./utils/remoteFileProbe');

function parsePositiveInt(raw, fallback) {
  const parsed = parseInt(raw ?? String(fallback), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBoolFlag(raw, defaultValue) {
  if (raw == null || raw === '') return defaultValue;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return defaultValue;
}

function parseReloadStrategy(raw) {
  const value = String(raw || 'in-process').toLowerCase();
  const accepted = new Set(['in-process', 'restart', 'exit']);
  return accepted.has(value) ? value : 'in-process';
}

const DATA_DIR = path.join(__dirname, '../data');
const VET_DATA_DIR = path.join(DATA_DIR, 'veterinaires');

const config = Object.freeze({
  // Serveur
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  // Cycle de vie / rechargement
  reloadStrategy: parseReloadStrategy(process.env.RELOAD_STRATEGY),
  vetLoadDeferred: parseBoolFlag(process.env.VET_LOAD_DEFERRED, false),
  vetLoadDelayMs: parsePositiveInt(process.env.VET_LOAD_DELAY_MS, 0),

  // Rate limiting
  enableRateLimit: parseBoolFlag(process.env.ENABLE_RATE_LIMIT, false),
  rateLimitWindowMs: parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60000),
  rateLimitMax: parsePositiveInt(process.env.RATE_LIMIT_MAX, 500),

  // Corpus BDPM
  loadHasAvis: parseBoolFlag(process.env.LOAD_HAS_AVIS, true),
  loadMitm: parseBoolFlag(process.env.LOAD_MITM, true),
  corpusLightProfile: parseBoolFlag(process.env.CORPUS_LIGHT_PROFILE, false),

  // Hydratation recherche
  searchHydrateRelatedLimit: Math.max(
    1,
    parseInt(process.env.SEARCH_HYDRATE_RELATED_LIMIT || '50', 10)
  ),
  detailHydrateRelatedLimit: Math.max(
    0,
    parseInt(process.env.DETAIL_HYDRATE_RELATED_LIMIT || '0', 10)
  ),

  // Intervalles de rafraîchissement
  bdpmCheckIntervalHours: parseIntervalHours(process.env.BDPM_CHECK_INTERVAL_HOURS, 72),
  vetCheckIntervalHours: parseIntervalHours(process.env.VET_CHECK_INTERVAL_HOURS, 72),

  // Chemins données
  dataDir: DATA_DIR,
  vetDataDir: process.env.VET_DATA_DIR || VET_DATA_DIR,
  vetProductsFile: process.env.VET_PRODUCTS_FILE || 'amm-vet-fr-v2-v.xml',
  vetDictFile: process.env.VET_DICT_FILE || 'amm-vet-fr-v2-d.xml',

  // Chemins d'export (scripts)
  searchIndexOutDir:
    process.env.SEARCH_INDEX_OUT_DIR || path.join(DATA_DIR, 'search-indexes'),
  corpusExportOutDir:
    process.env.CORPUS_EXPORT_OUT_DIR || path.join(DATA_DIR, 'corpus-export'),
  skipVet: parseBoolFlag(process.env.SKIP_VET, false)
});

module.exports = config;
