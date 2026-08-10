'use strict';

/**
 * Listing / alertes MVP pour le corpus `ruptures` (disponibilité BDPM).
 * Séparé de dataLoader : chargeur + maps d’un côté, projection API de l’autre.
 */

const { buildPagedResponse } = require('../../utils/corpusPaging');
const { materializeIndices, materializeRange, rowCount } = require('../../utils/corpusStore');
const { rankSearchResults } = require('../../utils/corpusSearch');
const { BDPM_INDEX_SPECS } = require('../../search/indexSpecs');
const {
  rowMatchesDisponibiliteFilters,
  isDisponibiliteAlertId,
  mapRowToDisponibiliteAlert,
  compareDisponibiliteRowsByMajDesc
} = require('../../utils/disponibiliteQuery');
const { resolveBdpmCisKeys } = require('../searchOrchestrator');
const config = require('../../config');
const state = require('./state');

const { corpus, metadata, searchIndexes } = state;
const DETAIL_HYDRATE_RELATED_LIMIT = config.detailHydrateRelatedLimit;

/** Borne le nombre de CIS résolus depuis `q` avant projection ruptures. */
const DISPONIBILITE_ALERTS_Q_CIS_LIMIT = 100;

function allRowIndices(rows) {
  const indices = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) indices[i] = i;
  return indices;
}

function rankedRupturesSearch(query) {
  const rows = corpus.ruptures;
  if (!rows || !query || !searchIndexes.ruptures) return [];
  const spec = BDPM_INDEX_SPECS.ruptures;
  return rankSearchResults(rows, searchIndexes.ruptures.search(query), query, {
    primaryField: spec.primaryField,
    idField: spec.idField,
    codeFields: spec.codeFields
  });
}

/**
 * Sélection des indices `ruptures` (recherche texte + filtres / maps).
 * @returns {number[]|null} null = tout le corpus sans filtre (chemin listCorpusPage)
 *
 * Précédence des maps quand plusieurs filtres : `lien_ansm` avant `cis`
 * (les autres filtres restent appliqués ensuite via rowMatches).
 *
 * Note : `q` ici = recherche MiniSearch sur `libelle_statut` (endpoint brut
 * `/disponibilite`). Pour nom/DCI sur `/alerts`, voir `selectAlertRuptureIndices`.
 */
function selectRuptureIndices({ q, filters } = {}) {
  const rows = corpus.ruptures;
  if (!rows) return [];

  if (filters?.lienFilterInvalid) return [];

  const useFilters = filters && filters.hasExactFilters;
  let indices;

  if (q) {
    indices = rankedRupturesSearch(q).map((r) => r.rowIndex);
  } else if (useFilters && filters.lien_ansm && state.cisIndexes?.rupturesByLienAnsm) {
    indices = [...(state.cisIndexes.rupturesByLienAnsm.get(filters.lien_ansm) || [])];
  } else if (useFilters && filters.cis && state.cisIndexes?.rupturesByCis) {
    indices = [...(state.cisIndexes.rupturesByCis.get(filters.cis) || [])];
  } else if (useFilters) {
    indices = allRowIndices(rows);
  } else {
    return null;
  }

  if (useFilters) {
    indices = indices.filter((rowIndex) => rowMatchesDisponibiliteFilters(rows[rowIndex], filters));
  }
  return indices;
}

/**
 * Indices ruptures pour `/disponibilite/alerts`.
 * Si `q` est fourni : résolution CIS (specialites/presentations/compositions)
 * puis union `rupturesByCis` — sans toucher à la sémantique de `/disponibilite?q=`.
 */
function selectAlertRuptureIndices({ q, filters } = {}) {
  const rows = corpus.ruptures;
  if (!rows) return [];
  if (filters?.lienFilterInvalid) return [];

  const query = q != null ? String(q).trim() : '';
  if (!query) {
    let indices = selectRuptureIndices({ filters });
    if (indices === null) indices = allRowIndices(rows);
    return indices;
  }

  const cisKeys = resolveBdpmCisKeys(query, { limit: DISPONIBILITE_ALERTS_Q_CIS_LIMIT });
  const byCis = state.cisIndexes?.rupturesByCis;
  const seen = new Set();
  const indices = [];
  for (const cis of cisKeys) {
    const rowIndices = byCis?.get(cis) || [];
    for (const rowIndex of rowIndices) {
      if (seen.has(rowIndex)) continue;
      seen.add(rowIndex);
      indices.push(rowIndex);
    }
  }

  if (filters?.hasExactFilters) {
    return indices.filter((rowIndex) => rowMatchesDisponibiliteFilters(rows[rowIndex], filters));
  }
  return indices;
}

function listCorpusRupturesPage(page = 1, limit = 100) {
  const rows = corpus.ruptures;
  if (!rows) {
    return buildPagedResponse({
      total: 0,
      page: 1,
      limit: 100,
      metadata,
      materializePage: () => []
    });
  }
  return buildPagedResponse({
    total: rowCount(rows),
    page,
    limit,
    metadata,
    materializePage: (offset, end) => materializeRange(rows, offset, end)
  });
}

function listDisponibilitePage({ q, filters, page = 1, limit = 100 } = {}) {
  const rows = corpus.ruptures;
  if (!rows) {
    return buildPagedResponse({
      total: 0,
      page: 1,
      limit: 100,
      metadata,
      materializePage: () => []
    });
  }

  const indices = selectRuptureIndices({ q, filters });
  if (indices === null) {
    return listCorpusRupturesPage(page, limit);
  }

  return buildPagedResponse({
    total: indices.length,
    page,
    limit,
    metadata,
    materializePage: (offset, end) => materializeIndices(rows, indices.slice(offset, end))
  });
}

function getSpecialiteJson(cis) {
  if (!cis || !state.cisIndexes) return null;
  const rowIndex = state.cisIndexes.specialitesByCis.get(cis);
  if (rowIndex === undefined) return null;
  return corpus.specialites[rowIndex].toJSON();
}

function getRupturesForCis(cis) {
  if (!cis || !state.cisIndexes) return [];
  const rows = corpus.ruptures;
  const indices = state.cisIndexes.rupturesByCis.get(cis) || [];
  const limit = DETAIL_HYDRATE_RELATED_LIMIT;
  const slice = limit > 0 ? indices.slice(0, limit) : indices;
  return materializeIndices(rows, slice);
}

function listDisponibiliteAlerts({ q, filters, page = 1, limit = 30 } = {}) {
  const rows = corpus.ruptures;
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(500, Math.max(1, Number(limit) || 30));

  const empty = {
    generated_at: new Date().toISOString(),
    data_last_updated_at: metadata.last_updated,
    alerts_count: 0,
    alerts: [],
    pagination: { total: 0, page: pageNum, limit: limitNum, pages: 0 }
  };

  if (!rows || rows.length === 0) return empty;

  const indices = selectAlertRuptureIndices({ q, filters });

  indices.sort((ia, ib) => compareDisponibiliteRowsByMajDesc(rows[ia], rows[ib]));

  const total = indices.length;
  const pages = total === 0 ? 0 : Math.ceil(total / limitNum);
  const offset = (pageNum - 1) * limitNum;
  const alerts = indices.slice(offset, offset + limitNum).map((rowIndex) => {
    const row = rows[rowIndex].toJSON();
    const specialite = getSpecialiteJson(row.cis);
    return mapRowToDisponibiliteAlert(row, specialite?.denomination || null);
  });

  return {
    generated_at: new Date().toISOString(),
    data_last_updated_at: metadata.last_updated,
    alerts_count: alerts.length,
    alerts,
    pagination: { total, page: pageNum, limit: limitNum, pages }
  };
}

function getDisponibiliteAlertById(alertId) {
  const id = String(alertId || '').trim();
  if (!isDisponibiliteAlertId(id) || !state.cisIndexes?.rupturesByAlertId) return null;

  const matchIndex = state.cisIndexes.rupturesByAlertId.get(id);
  if (matchIndex === undefined) return null;

  const row = corpus.ruptures[matchIndex].toJSON();
  const specialite = getSpecialiteJson(row.cis);

  return {
    alert_id: id,
    cis: row.cis || null,
    medicine_name: specialite?.denomination || null,
    specialite,
    ruptures: getRupturesForCis(row.cis),
    detail_url: row.lien_ansm ? String(row.lien_ansm).trim() || null : null,
    source: 'bdpm'
  };
}

module.exports = {
  selectRuptureIndices,
  selectAlertRuptureIndices,
  listDisponibilitePage,
  listDisponibiliteAlerts,
  getDisponibiliteAlertById,
  DISPONIBILITE_ALERTS_Q_CIS_LIMIT
};
