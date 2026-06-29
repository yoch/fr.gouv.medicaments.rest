'use strict';

/**
 * Export des index FrozenMiniSearch et documents corpus BDPM.
 * Utilisé par `src/scripts/export-search-indexes.js` et
 * `src/scripts/export-corpus-documents.js` — hors chemin runtime.
 */

const { exportFrozenIndexes } = require('../../utils/frozenMiniSearch');
const {
  exportCorpusDocuments,
  buildDatasetsFromSpecs
} = require('../../utils/exportCorpusDocuments');
const { BDPM_INDEX_SPECS } = require('../../search/indexSpecs');
const config = require('../../config');
const state = require('./state');

function exportBdpmSearchIndexes(outDir) {
  return exportFrozenIndexes(state.searchIndexes, outDir, 'bdpm', {
    last_updated: state.metadata.last_updated,
    source: state.metadata.source,
    load_has_avis: config.loadHasAvis,
    load_mitm: config.loadMitm
  });
}

function exportBdpmCorpusDocuments(outDir) {
  const datasets = buildDatasetsFromSpecs(state.corpus, BDPM_INDEX_SPECS, {
    onlyIndexed: true,
    searchIndexes: state.searchIndexes
  });
  return exportCorpusDocuments(datasets, outDir, 'bdpm', {
    last_updated: state.metadata.last_updated,
    source: state.metadata.source,
    load_has_avis: config.loadHasAvis,
    load_mitm: config.loadMitm
  });
}

module.exports = { exportBdpmSearchIndexes, exportBdpmCorpusDocuments };
