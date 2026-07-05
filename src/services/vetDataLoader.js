'use strict';

/**
 * Domaine vétérinaire (ANMV) — façade API.
 *
 * Pipeline de chargement (parsing XML + indexation) dans `./loadPipeline.js` ;
 * état mutable partagé dans `./state.js` ; exports hors runtime dans
 * `./exportApi.js`. Ce module reste le point d'export public (conservé
 * inchangé pour les callers existants).
 */

const {
  rankSearchResults,
  materializeRankedSearchRange,
  rankAndMaterializeSearch
} = require('../utils/corpusSearch');
const {
  rowCount,
  materializeRange,
  materializeIndices
} = require('../utils/corpusStore');
const { normalizeSearchText } = require('../utils/searchRanking');
const { buildPagedResponse } = require('../utils/corpusPaging');
const { buildLienRcpFromNom, ANMV_RCP_URL_PREFIX } = require('../models/vet/rcp');
const config = require('../config');
const { VET_INDEX_SPECS } = require('../search/indexSpecs');
const state = require('./vet/state');
const { loadVetData, normalizeNum } = require('./vet/loadPipeline');
const { exportVetSearchIndexes, exportVetCorpusDocuments } = require('./vet/exportApi');

const { corpus, metadata, searchIndexes, RELATED_BY_NUM_MAPS } = state;

/* ------------------------------------------------------------------ *
 * API de recherche et d'hydratation
 * ------------------------------------------------------------------ */

function searchVet(type, query) {
  if (!query) return [];
  if (type === 'presentations') {
    // Pas d'index FrozenMiniSearch sur les présentations vet : scan linéaire
    // (libellé + GTIN). L'API paginée matérialise seulement la page demandée.
    const indices = collectPresentationMatchIndices(query);
    return materializeIndices(corpus.presentations, indices);
  }
  if (!searchIndexes[type]) return [];

  const rows = corpus[type];
  const spec = VET_INDEX_SPECS[type];
  const results = searchIndexes[type].search(query);
  return rankAndMaterializeSearch(rows, results, query, {
    primaryField: spec.primaryField,
    idField: spec.idField
  });
}

function rankedSearchVet(type, query) {
  if (!query) return [];
  if (!searchIndexes[type]) return [];

  const rows = corpus[type];
  const spec = VET_INDEX_SPECS[type];
  return rankSearchResults(rows, searchIndexes[type].search(query), query, {
    primaryField: spec.primaryField,
    idField: spec.idField
  });
}

function searchVetPage(type, query, page = 1, limit = 100) {
  if (type === 'presentations') {
    const indices = query ? collectPresentationMatchIndices(query) : [];
    return buildPagedResponse({
      total: indices.length,
      page,
      limit,
      metadata,
      materializePage: (offset, end) =>
        materializeIndices(corpus.presentations, indices.slice(offset, end))
    });
  }

  const rows = corpus[type];
  const ranked = rankedSearchVet(type, query);
  return buildPagedResponse({
    total: ranked.length,
    page,
    limit,
    metadata,
    materializePage: (offset, end) =>
      materializeRankedSearchRange(rows, ranked, offset, end)
  });
}

function searchVetKeyMatches(type, query) {
  const rows = corpus[type];
  const spec = VET_INDEX_SPECS[type];
  if (!spec || !spec.idField) return [];
  const ranked = rankedSearchVet(type, query);
  const out = new Array(ranked.length);
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    out[i] = {
      [spec.idField]: rows[r.rowIndex][spec.idField],
      match_quality: r.match_quality
    };
  }
  return out;
}

function collectPresentationMatchIndices(query) {
  const presentations = corpus.presentations;
  const normalizedQuery = normalizeSearchText(query);
  const indices = [];
  for (let i = 0; i < presentations.length; i++) {
    const row = presentations[i];
    const libelle = normalizeSearchText(row.libelle);
    const gtin = row.gtin;
    if (libelle.includes(normalizedQuery) || gtin.includes(query)) {
      indices.push(i);
    }
  }
  return indices;
}

function listVetCorpusPage(type, page = 1, limit = 100) {
  const rows = corpus[type];
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

function getVetMetadata() {
  return metadata;
}

function getMedicamentByNum(num) {
  const numIndexes = state.numIndexes;
  if (!numIndexes) return undefined;
  const rowIndex = numIndexes.medicamentsByNum.get(normalizeNum(num));
  if (rowIndex === undefined) return undefined;
  return corpus.medicaments[rowIndex].toJSON();
}

function getMedicamentLabelByNum(num) {
  const numIndexes = state.numIndexes;
  if (!numIndexes) return '';
  const rowIndex = numIndexes.medicamentsByNum.get(normalizeNum(num));
  if (rowIndex === undefined) return '';
  return corpus.medicaments[rowIndex].nom || '';
}

function getMedicamentSearchRecordByNum(num) {
  const numIndexes = state.numIndexes;
  if (!numIndexes) return null;
  const rowIndex = numIndexes.medicamentsByNum.get(normalizeNum(num));
  if (rowIndex === undefined) return null;
  const row = corpus.medicaments[rowIndex];
  return {
    denomination: row.nom,
    forme_pharmaceutique: row.forme_pharmaceutique,
    voies_admin: ''
  };
}

function getRelatedByNum(type, num, limit = config.searchHydrateRelatedLimit) {
  if (!num) return [];
  const normalized = normalizeNum(num);
  if (type === 'temps_attente') {
    const entries = state.tempsAttente.get(normalized) || [];
    return entries.map((e) => e.toJSON());
  }
  const numIndexes = state.numIndexes;
  if (!numIndexes) return [];
  const mapKey = RELATED_BY_NUM_MAPS[type];
  if (!mapKey) return [];
  const rows = corpus[type];
  const indices = numIndexes[mapKey].get(normalized) || [];
  const slice = limit > 0 ? indices.slice(0, limit) : indices;
  return materializeIndices(rows, slice);
}

function getVetCorpusStats() {
  const byType = {};
  for (const type of Object.keys(corpus)) {
    byType[type] = { rows: rowCount(corpus[type]) };
  }
  return { byType, corpus };
}

function getVetSearchIndexes() {
  return { medicaments: searchIndexes.medicaments, compositions: searchIndexes.compositions };
}

module.exports = {
  loadVetData,
  exportVetSearchIndexes,
  exportVetCorpusDocuments,
  searchVet,
  searchVetPage,
  searchVetKeyMatches,
  listVetCorpusPage,
  getVetMetadata,
  getMedicamentByNum,
  getMedicamentLabelByNum,
  getMedicamentSearchRecordByNum,
  getRelatedByNum,
  buildLienRcpFromNom,
  ANMV_RCP_URL_PREFIX,
  getVetCorpusStats,
  getVetSearchIndexes
};
