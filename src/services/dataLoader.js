'use strict';

/**
 * Domaine BDPM — chargement, recherche, hydratation, export.
 *
 * État partagé dans `./bdpm/state.js` ; exports (hors runtime) dans
 * `./bdpm/exportApi.js`. Ce module reste le point d'export public
 * (conservé inchangé pour les callers existants).
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const {
  buildFrozenIndexFromAsyncIterable,
  buildFrozenIndexFromRows
} = require('../utils/frozenMiniSearch');
const { loadMemoryMark } = require('../utils/memorySampler');
const { buildPagedResponse } = require('../utils/corpusPaging');
const { miniSearchIndexConfig } = require('../utils/miniSearchIndexConfig');
const { BDPM_SCHEMAS } = require('../utils/corpusSchemas');
const { rankAndMaterializeSearch } = require('../utils/corpusSearch');
const {
  clearCorpus,
  push,
  rowCount,
  materializeRange,
  materializeIndices,
  buildKeyIndex,
  buildIndexDocument
} = require('../utils/corpusStore');
const { FROM_CSV, bdpmExtraitUrl, Substance } = require('../models/bdpm');
const { BDPM_INDEX_SPECS } = require('../search/indexSpecs');
const config = require('../config');
const state = require('./bdpm/state');
const { exportBdpmSearchIndexes, exportBdpmCorpusDocuments } = require('./bdpm/exportApi');

const DATA_DIR = config.dataDir;

const { corpus, metadata, searchIndexes, RELATED_BY_CIS_MAPS } = state;
const HYDRATE_RELATED_LIMIT = config.searchHydrateRelatedLimit;
const DETAIL_HYDRATE_RELATED_LIMIT = config.detailHydrateRelatedLimit;
const LOAD_HAS_AVIS = config.loadHasAvis;
const LOAD_MITM = config.loadMitm;

/* ------------------------------------------------------------------ *
 * Pipeline de chargement
 * ------------------------------------------------------------------ */

function csvParserOptions(columns) {
  return {
    delimiter: '\t',
    columns,
    skip_empty_lines: true,
    trim: true,
    quote: false,
    escape: false,
    relax_quotes: true,
    relax_column_count: true
  };
}

async function loadParseAndIndex(type, filename, fields, boost = null) {
  const filepath = path.join(DATA_DIR, filename);
  console.log(`Chargement et indexation de ${type}...`);

  const rows = corpus[type];
  clearCorpus(rows);
  const fromCsv = FROM_CSV[type];
  const options = miniSearchIndexConfig(fields, boost);

  if (!fs.existsSync(filepath)) {
    console.warn(`Fichier ${filename} non trouvé`);
    searchIndexes[type] = null;
    return;
  }

  async function* documents() {
    const parser = fs
      .createReadStream(filepath, { encoding: 'utf8' })
      .pipe(parse(csvParserOptions(BDPM_SCHEMAS[type])));

    let rowIndex = 0;
    for await (const record of parser) {
      push(rows, fromCsv(record));
      yield buildIndexDocument(rows[rowIndex], rowIndex, fields);
      rowIndex++;
    }
  }

  searchIndexes[type] = await buildFrozenIndexFromAsyncIterable(documents(), options);
}

async function indexInMemoryCorpus(type, fields, boost = null) {
  console.log(`Indexation de ${type}...`);
  const rows = corpus[type];
  const options = miniSearchIndexConfig(fields, boost);
  searchIndexes[type] = buildFrozenIndexFromRows(
    rows,
    (item, rowIndex) => buildIndexDocument(item, rowIndex, fields),
    options
  );
}

function buildCisIndexes() {
  state.cisIndexes = {
    specialitesByCis: buildKeyIndex(corpus.specialites, 'cis', { unique: true }),
    presentationsByCis: buildKeyIndex(corpus.presentations, 'cis'),
    compositionsByCis: buildKeyIndex(corpus.compositions, 'cis'),
    avisSmrByCis: buildKeyIndex(corpus.avis_smr, 'cis'),
    avisAsmrByCis: buildKeyIndex(corpus.avis_asmr, 'cis'),
    conditionsByCis: buildKeyIndex(corpus.conditions, 'cis'),
    generiquesByCis: buildKeyIndex(corpus.generiques, 'cis'),
    generiquesByGroupe: buildKeyIndex(corpus.generiques, 'id_groupe')
  };
}

function clearLoadedData() {
  state.reset();
  for (const type of Object.keys(corpus)) {
    clearCorpus(corpus[type]);
  }
}

async function loadOne(type, markLabel) {
  const spec = BDPM_INDEX_SPECS[type];
  await loadParseAndIndex(type, spec.file, spec.fields, spec.boost);
  if (markLabel) loadMemoryMark(markLabel, { rows: rowCount(corpus[type]) });
}

async function loadData() {
  const mainFilePath = path.join(DATA_DIR, 'CIS_bdpm.txt');
  try {
    const stats = fs.statSync(mainFilePath);
    metadata.last_updated = stats.mtime.toISOString();
  } catch {
    metadata.last_updated = new Date().toISOString();
  }

  console.log('Chargement des données...');
  clearLoadedData();
  loadMemoryMark('bdpm_start');

  await loadOne('specialites', 'bdpm_after_specialites');
  await loadOne('presentations', 'bdpm_after_presentations');
  await loadOne('compositions', 'bdpm_after_compositions');

  if (LOAD_HAS_AVIS) {
    await loadOne('avis_smr', 'bdpm_after_avis_smr');
    await loadOne('avis_asmr', 'bdpm_after_avis_asmr');
  }
  // else : corpus + index déjà nuls via clearLoadedData()

  await loadOne('generiques', 'bdpm_after_generiques');
  await loadOne('conditions', 'bdpm_after_conditions');
  await loadOne('ruptures', 'bdpm_after_ruptures');

  if (LOAD_MITM) {
    await loadOne('mitm', 'bdpm_after_mitm');
  }

  deriveSubstances();
  await indexInMemoryCorpus(
    'substances',
    BDPM_INDEX_SPECS.substances.fields,
    BDPM_INDEX_SPECS.substances.boost
  );
  loadMemoryMark('bdpm_after_substances', { rows: rowCount(corpus.substances) });

  buildCisIndexes();
  loadMemoryMark('bdpm_done', { specialites: rowCount(corpus.specialites) });
  console.log(`Données chargées et indexées: ${rowCount(corpus.specialites)} spécialités`);
}

function deriveSubstances() {
  const substancesMap = new Map();
  for (const comp of corpus.compositions) {
    if (comp.code_substance && comp.denomination_substance) {
      if (!substancesMap.has(comp.code_substance)) {
        substancesMap.set(
          comp.code_substance,
          new Substance(comp.code_substance, comp.denomination_substance, 0)
        );
      }
      substancesMap.get(comp.code_substance).medicaments_count++;
    }
  }
  clearCorpus(corpus.substances);
  for (const sub of substancesMap.values()) {
    push(corpus.substances, sub);
  }
}

/* ------------------------------------------------------------------ *
 * API de recherche et d'hydratation
 * ------------------------------------------------------------------ */

function search(type, query) {
  const rows = corpus[type];
  if (!rows || !query) return [];
  if (!searchIndexes[type]) return [];

  const spec = BDPM_INDEX_SPECS[type];
  const results = searchIndexes[type].search(query);
  return rankAndMaterializeSearch(rows, results, query, {
    primaryField: spec.primaryField,
    idField: spec.idField
  });
}

function listCorpusPage(type, page = 1, limit = 100) {
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

function getSpecialiteByCis(cis) {
  const cisIndexes = state.cisIndexes;
  if (!cisIndexes) return undefined;
  const rowIndex = cisIndexes.specialitesByCis.get(cis);
  if (rowIndex === undefined) return undefined;
  return corpus.specialites[rowIndex].toJSON();
}

function getRelatedByCis(type, cis, limit = HYDRATE_RELATED_LIMIT) {
  const cisIndexes = state.cisIndexes;
  if (!cisIndexes || !cis) return [];
  const mapKey = RELATED_BY_CIS_MAPS[type];
  if (!mapKey) return [];
  const rows = corpus[type];
  const indices = cisIndexes[mapKey].get(cis) || [];
  const slice = limit > 0 ? indices.slice(0, limit) : indices;
  return materializeIndices(rows, slice);
}

function getGeneriquesForCis(cis) {
  const cisIndexes = state.cisIndexes;
  if (!cisIndexes || !cis) return null;
  const indices = cisIndexes.generiquesByCis.get(cis);
  if (!indices || indices.length === 0) return null;

  const first = corpus.generiques[indices[0]].toJSON();
  const id_groupe = first.id_groupe;
  const groupeIndices = cisIndexes.generiquesByGroupe.get(id_groupe) || [];
  return {
    id_groupe,
    libelle_groupe: first.libelle_groupe,
    items: materializeIndices(corpus.generiques, groupeIndices)
  };
}

function getMetadata() {
  return metadata;
}

function isHasAvisLoaded() {
  return LOAD_HAS_AVIS;
}

function isMitmLoaded() {
  return LOAD_MITM;
}

function getBdpmCorpusStats() {
  const byType = {};
  for (const type of Object.keys(corpus)) {
    byType[type] = { rows: rowCount(corpus[type]) };
  }
  return { byType, corpus };
}

function getBdpmSearchIndexes() {
  const out = {};
  for (const type of Object.keys(searchIndexes)) {
    out[type] = searchIndexes[type];
  }
  return out;
}

module.exports = {
  loadData,
  exportBdpmSearchIndexes,
  exportBdpmCorpusDocuments,
  listCorpusPage,
  search,
  getMetadata,
  isHasAvisLoaded,
  isMitmLoaded,
  getSpecialiteByCis,
  getRelatedByCis,
  getGeneriquesForCis,
  bdpmExtraitUrl,
  HYDRATE_RELATED_LIMIT,
  DETAIL_HYDRATE_RELATED_LIMIT,
  getBdpmCorpusStats,
  getBdpmSearchIndexes
};
