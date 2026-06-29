'use strict';

/**
 * Export des index FrozenMiniSearch et documents corpus vétérinaire.
 * Utilisé par `src/scripts/export-search-indexes.js` et
 * `src/scripts/export-corpus-documents.js` — hors chemin runtime.
 */

const { exportFrozenIndexes } = require('../../utils/frozenMiniSearch');
const {
  exportCorpusDocuments,
  buildDatasetsFromSpecs
} = require('../../utils/exportCorpusDocuments');
const { VET_INDEX_SPECS } = require('../../search/indexSpecs');
const state = require('./state');

function exportVetSearchIndexes(outDir) {
  return exportFrozenIndexes(state.searchIndexes, outDir, 'vet', {
    last_updated: state.metadata.last_updated,
    source: state.metadata.source
  });
}

function exportVetCorpusDocuments(outDir) {
  const datasets = buildDatasetsFromSpecs(state.corpus, VET_INDEX_SPECS);
  // Presentations vet : non indexées (pas dans VET_INDEX_SPECS), exportées
  // sans indexOptions pour reindexation côté consommateur.
  if (state.corpus.presentations.length > 0) {
    datasets.push({ type: 'presentations', rows: state.corpus.presentations });
  }
  return exportCorpusDocuments(datasets, outDir, 'vet', {
    last_updated: state.metadata.last_updated,
    source: state.metadata.source
  });
}

module.exports = { exportVetSearchIndexes, exportVetCorpusDocuments };
