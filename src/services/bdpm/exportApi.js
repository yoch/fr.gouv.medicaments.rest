'use strict';

/**
 * Export des index FrozenMiniSearch et documents corpus BDPM.
 * Utilisé par `src/scripts/export-search-indexes.js` et
 * `src/scripts/export-corpus-documents.js` — hors chemin runtime.
 */

const { exportFrozenIndexes } = require('../../utils/frozenMiniSearch');
const { miniSearchIndexConfig } = require('../../utils/miniSearchIndexConfig');
const { exportCorpusDocuments } = require('../../utils/exportCorpusDocuments');
const { rowCount, buildIndexDocument } = require('../../utils/corpusStore');
const { BDPM_INDEX_SPECS } = require('../../search/indexSpecs');
const state = require('./state');

function exportBdpmSearchIndexes(outDir) {
  const { searchIndexes, metadata, loadHasAvis, loadMitm } = state;
  return exportFrozenIndexes(searchIndexes, outDir, 'bdpm', {
    last_updated: metadata.last_updated,
    source: metadata.source,
    load_has_avis: loadHasAvis,
    load_mitm: loadMitm
  });
}

function exportBdpmCorpusDocuments(outDir) {
  const { corpus, searchIndexes, metadata, loadHasAvis, loadMitm } = state;
  const datasets = [];

  for (const [type, spec] of Object.entries(BDPM_INDEX_SPECS)) {
    const rows = corpus[type];
    if (!rows || rowCount(rows) === 0) continue;
    if (!searchIndexes[type]) continue;

    const { fields, boost } = spec;
    datasets.push({
      type,
      rows,
      toDocument: (item, rowIndex) => buildIndexDocument(item, rowIndex, fields),
      indexOptions: miniSearchIndexConfig(fields, boost)
    });
  }

  return exportCorpusDocuments(datasets, outDir, 'bdpm', {
    last_updated: metadata.last_updated,
    source: metadata.source,
    load_has_avis: loadHasAvis,
    load_mitm: loadMitm
  });
}

module.exports = { exportBdpmSearchIndexes, exportBdpmCorpusDocuments };
