/**
 * Source unique de vérité pour la configuration runtime.
 *
 * Toute lecture de `process.env` hors de ce module est un smell — la config
 * est figée au démarrage et consommée sous forme d'objet gelé. Les variables
 * documentées dans `.env.example` doivent toutes apparaître ici.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIntervalHours } from './utils/remoteFileProbe.mts';
import { validateTimerDelay } from './utils/periodicTask.mts';

export type ReloadStrategy = 'in-process' | 'restart' | 'exit';

export interface AppConfig {
  readonly port: number;
  readonly nodeEnv: string;
  readonly reloadStrategy: ReloadStrategy;
  readonly vetLoadDeferred: boolean;
  readonly vetLoadDelayMs: number;
  readonly postLoadGc: boolean;
  readonly enableRateLimit: boolean;
  readonly trustProxy: boolean;
  readonly rateLimitWindowMs: number;
  readonly rateLimitMax: number;
  readonly loadHasAvis: boolean;
  readonly loadMitm: boolean;
  readonly corpusLightProfile: boolean;
  readonly searchHydrateRelatedLimit: number;
  readonly detailHydrateRelatedLimit: number;
  readonly bdpmCheckIntervalHours: number;
  readonly vetCheckIntervalHours: number;
  readonly dataDir: string;
  readonly vetDataDir: string;
  readonly vetProductsFile: string;
  readonly vetDictFile: string;
  readonly searchIndexOutDir: string;
  readonly corpusExportOutDir: string;
  readonly skipVet: boolean;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? String(fallback), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBoolFlag(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw == null || raw === '') return defaultValue;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return defaultValue;
}

function parseReloadStrategy(raw: string | undefined): ReloadStrategy {
  const value = String(raw || 'in-process').toLowerCase();
  if (value === 'in-process' || value === 'restart' || value === 'exit') {
    return value;
  }
  return 'in-process';
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = MODULE_DIR.startsWith('/$bunfs')
  ? process.cwd()
  : path.resolve(MODULE_DIR, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(PROJECT_ROOT, 'data');
const VET_DATA_DIR = process.env.VET_DATA_DIR || path.join(DATA_DIR, 'veterinaires');

function readRuntimeEnv(key: string): string | undefined {
  // Évite le constant-folding de `process.env.NODE_ENV` lors de `bun build --compile`.
  return process.env[key];
}

const config: AppConfig = Object.freeze({
  // Serveur
  port: parseInt(process.env.PORT ?? '', 10) || 3000,
  nodeEnv: readRuntimeEnv('NODE_ENV') || 'development',

  // Cycle de vie / rechargement
  reloadStrategy: parseReloadStrategy(process.env.RELOAD_STRATEGY),
  vetLoadDeferred: parseBoolFlag(process.env.VET_LOAD_DEFERRED, false),
  vetLoadDelayMs: validateTimerDelay(parsePositiveInt(process.env.VET_LOAD_DELAY_MS, 0), 'VET_LOAD_DELAY_MS', true),
  postLoadGc: parseBoolFlag(process.env.POST_LOAD_GC, false),

  // Rate limiting
  enableRateLimit: parseBoolFlag(process.env.ENABLE_RATE_LIMIT, false),
  trustProxy: parseBoolFlag(process.env.TRUST_PROXY, false),
  rateLimitWindowMs: validateTimerDelay(parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60000), 'RATE_LIMIT_WINDOW_MS'),
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

export default config;
