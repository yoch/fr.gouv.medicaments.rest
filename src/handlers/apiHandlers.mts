import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.mts';
import { memoryUsageMb } from '../utils/processMemory.mts';
import { buildPagedResponse } from '../utils/corpusPaging.mts';
import { toPagingArg } from '../utils/routeHelpers.mts';
import { shapeSearchResults, normalizeDetail } from '../utils/searchResponseShape.mts';
import { renderSearchMarkdown, normalizeFormat } from '../utils/searchMarkdown.mts';
import { parseDisponibiliteFilters } from '../utils/disponibiliteQuery.mts';
import { executeHybridSearchPage } from '../services/searchOrchestrator.mts';
import {
  getMetadata,
  getSpecialiteByCis,
  getRelatedByCis,
  getGeneriquesForCis,
  isHasAvisLoaded,
  DETAIL_HYDRATE_RELATED_LIMIT
} from '../services/dataLoader.mts';
import {
  listDisponibilitePage,
  listDisponibiliteAlerts,
  getDisponibiliteAlertById
} from '../services/bdpm/disponibiliteService.mts';
import {
  getVetMetadata,
  getMedicamentByNum,
  getRelatedByNum
} from '../services/vetDataLoader.mts';

export interface SearchRouteInput {
  q: unknown;
  page?: unknown;
  limit?: unknown;
  source?: unknown;
  format?: unknown;
  detail?: unknown;
  dosage?: unknown;
  forme?: unknown;
  voie?: unknown;
}

export interface JsonRouteResult {
  status: number;
  json: unknown;
}

export interface SearchRouteResult {
  status: number;
  json?: unknown;
  markdown?: string;
}

const HANDLER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_INDEX_HTML = HANDLER_DIR.startsWith('/$bunfs')
  ? path.join(process.cwd(), 'public/index.html')
  : path.resolve(HANDLER_DIR, '../../public/index.html');

function resolvePublicIndexHtmlPath(): string {
  return PUBLIC_INDEX_HTML;
}

function buildHealthPayload(): Record<string, unknown> {
  const metadata = getMetadata();
  return {
    status: 'ok',
    message: 'API des médicaments française',
    attribution: 'base de données publique des médicaments - gouv.fr',
    metadata: {
      last_updated: metadata.last_updated,
      source: metadata.source
    },
    memory: memoryUsageMb(),
    reload_strategy: config.reloadStrategy,
    uptime_seconds: Math.floor(process.uptime())
  };
}

function pickCriterion(value: unknown): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

function buildActiveCriteria(
  dosage: string | null,
  forme: string | null,
  voie: string | null
): Record<string, string> | undefined {
  if (!dosage && !forme && !voie) return undefined;
  const active: Record<string, string> = {};
  if (dosage) active.dosage = dosage;
  if (forme) active.forme = forme;
  if (voie) active.voie = voie;
  return active;
}

function executeMedicamentSearchRoute(input: SearchRouteInput): SearchRouteResult {
  const { q, page = 1, limit = 50, source, format, detail, dosage, forme, voie } = input;
  if (!q) {
    return { status: 400, json: { error: 'Paramètre de recherche "q" requis' } };
  }

  const dosageValue = pickCriterion(dosage);
  const formeValue = pickCriterion(forme);
  const voieValue = pickCriterion(voie);
  const criteria = {
    dosage: dosageValue,
    forme: formeValue,
    voie: voieValue
  };
  const activeCriteria = buildActiveCriteria(dosageValue, formeValue, voieValue);

  const { results, total, search: searchMeta } = executeHybridSearchPage(
    String(q),
    source,
    page,
    limit,
    criteria,
    activeCriteria
  );
  const shaped = shapeSearchResults(results, { detail: normalizeDetail(detail) });
  const response = buildPagedResponse({
    total,
    page,
    limit,
    metadata: getMetadata(),
    materializePage: () => shaped,
    search: searchMeta
  });

  if (normalizeFormat(format) === 'markdown') {
    return {
      status: 200,
      markdown: renderSearchMarkdown(response.data, response.pagination, searchMeta)
    };
  }

  return { status: 200, json: response };
}

function getSpecialiteDetailResult(cis: string): JsonRouteResult {
  const specialite = getSpecialiteByCis(cis);
  if (!specialite) {
    return { status: 404, json: { error: 'Spécialité non trouvée' } };
  }

  const detailLimit = DETAIL_HYDRATE_RELATED_LIMIT;
  const payload: Record<string, unknown> = {
    ...specialite,
    presentations: getRelatedByCis('presentations', cis, detailLimit),
    compositions: getRelatedByCis('compositions', cis, detailLimit),
    conditions: getRelatedByCis('conditions', cis, detailLimit),
    ruptures: getRelatedByCis('ruptures', cis, detailLimit),
    generiques: getGeneriquesForCis(cis)
  };

  if (isHasAvisLoaded()) {
    payload.avis_smr = getRelatedByCis('avis_smr', cis, detailLimit);
    payload.avis_asmr = getRelatedByCis('avis_asmr', cis, detailLimit);
  }

  const metadata = getMetadata();
  payload.metadata = {
    last_updated: metadata.last_updated,
    source: metadata.source
  };

  return { status: 200, json: payload };
}

function getVeterinaireDetailResult(num: string): JsonRouteResult {
  const medicament = getMedicamentByNum(num);
  if (!medicament) {
    return { status: 404, json: { error: 'Médicament vétérinaire non trouvé' } };
  }

  const metadata = getVetMetadata();
  return {
    status: 200,
    json: {
      ...medicament,
      presentations: getRelatedByNum('presentations', num, config.detailHydrateRelatedLimit),
      compositions: getRelatedByNum('compositions', num, config.detailHydrateRelatedLimit),
      temps_attente: getRelatedByNum('temps_attente', num, config.detailHydrateRelatedLimit),
      metadata: {
        last_updated: metadata.last_updated,
        source: metadata.source
      }
    }
  };
}

function getDisponibiliteAlertsResult(query: Record<string, unknown>): JsonRouteResult {
  const qStr = query.q != null ? String(query.q) : undefined;
  const pageNum = toPagingArg(query.page) ?? 1;
  const limitNum = toPagingArg(query.limit) ?? 30;
  const filters = parseDisponibiliteFilters(query);
  if (filters.lienFilterInvalid) {
    return { status: 400, json: { error: 'Paramètre lien_ansm invalide ou non normalisable' } };
  }
  return { status: 200, json: listDisponibiliteAlerts({ q: qStr, filters, page: pageNum, limit: limitNum }) };
}

function getDisponibiliteAlertDetailResult(alertId: string): JsonRouteResult {
  const detail = getDisponibiliteAlertById(alertId);
  if (!detail) {
    return { status: 404, json: { error: 'Alerte de disponibilité non trouvée' } };
  }
  return { status: 200, json: detail };
}

function getDisponibiliteListResult(query: Record<string, unknown>): JsonRouteResult {
  const qStr = query.q != null ? String(query.q) : undefined;
  const pageNum = toPagingArg(query.page) ?? 1;
  const limitNum = toPagingArg(query.limit) ?? 100;
  const filters = parseDisponibiliteFilters(query);
  if (filters.lienFilterInvalid) {
    return { status: 400, json: { error: 'Paramètre lien_ansm invalide ou non normalisable' } };
  }
  return { status: 200, json: listDisponibilitePage({ q: qStr, filters, page: pageNum, limit: limitNum }) };
}

export {
  resolvePublicIndexHtmlPath,
  buildHealthPayload,
  executeMedicamentSearchRoute,
  getSpecialiteDetailResult,
  getVeterinaireDetailResult,
  getDisponibiliteAlertsResult,
  getDisponibiliteAlertDetailResult,
  getDisponibiliteListResult
};
