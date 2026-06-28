'use strict';

/**
 * Export des index FrozenMiniSearch et documents corpus vétérinaire.
 * Utilisé par `src/scripts/export-search-indexes.js` et
 * `src/scripts/export-corpus-documents.js` — hors chemin runtime.
 */

const { exportFrozenIndexes } = require('../../utils/frozenMiniSearch');
const { miniSearchIndexConfig } = require('../../utils/miniSearchIndexConfig');
const { exportCorpusDocuments } = require('../../utils/exportCorpusDocuments');
const { rowCount, buildIndexDocument } = require('../../utils/corpusStore');
const { VET_INDEX_SPECS } = require('../../search/indexSpecs');
const state = require('./state');

function exportVetSearchIndexes(outDir) {
  const { searchIndexes, metadata } = state;
  return exportFrozenIndexes(searchIndexes, outDir, 'vet', {
    last_updated: metadata.last_updated,
    source: metadata.source
  });
}

function exportVetCorpusDocuments(outDir) {
  const { corpus, metadata } = state;
  const datasets = [];

  for (const [type, spec] of Object.entries(VET_INDEX_SPECS)) {
    const rows = corpus[type];
    if (!rows || rowCount(rows) === 0) continue;

    const { fields, boost } = spec;
    datasets.push({
      type,
      rows,
      toDocument: (item, rowIndex) => buildIndexDocument(item, rowIndex, fields),
      indexOptions: miniSearchIndexConfig(fields, boost)
    });
  }

  if (rowCount(corpus.presentations) > 0) {
    datasets.push({
      type: 'presentations',
      rows: corpus.presentations
    });
  }

  return exportCorpusDocuments(datasets, outDir, 'vet', {
    last_updated: metadata.last_updated,
    source: metadata.source
  });
}

module.exports = { exportVetSearchIndexes, exportVetCorpusDocuments };
