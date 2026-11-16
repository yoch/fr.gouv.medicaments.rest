/**
 * Export des index FrozenMiniSearch et documents corpus BDPM.
 * Utilisé par `src/scripts/export-search-indexes.js` et
 * `src/scripts/export-corpus-documents.js` — hors chemin runtime.
 */

import __cjs_______utils_frozenMiniSearch from '../../utils/frozenMiniSearch.js';
const { exportFrozenIndexes } = __cjs_______utils_frozenMiniSearch;
import {
  exportCorpusDocuments,
  buildDatasetsFromSpecs
} from '../../utils/exportCorpusDocuments.mts';
import { BDPM_INDEX_SPECS } from '../../search/indexSpecs.mts';
import config from '../../config.js';
import { state } from './state.mts';

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

export {
exportBdpmSearchIndexes, exportBdpmCorpusDocuments
};