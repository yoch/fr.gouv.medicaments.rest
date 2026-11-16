/**
 * Export des index FrozenMiniSearch et documents corpus vétérinaire.
 * Utilisé par `src/scripts/export-search-indexes.js` et
 * `src/scripts/export-corpus-documents.js` — hors chemin runtime.
 */

import { exportFrozenIndexes } from '../../utils/frozenMiniSearch.mts';
import {
  exportCorpusDocuments,
  buildDatasetsFromSpecs
} from '../../utils/exportCorpusDocuments.mts';
import { VET_INDEX_SPECS } from '../../search/indexSpecs.mts';
import { state as state } from './state.mts';

function exportVetSearchIndexes(outDir) {
  return exportFrozenIndexes(state.searchIndexes, outDir, 'vet', {
    last_updated: state.metadata.last_updated,
    source: state.metadata.source
  });
}

function exportVetCorpusDocuments(outDir: string) {
  const datasets: Array<Record<string, unknown>> = buildDatasetsFromSpecs(state.corpus, VET_INDEX_SPECS);
  // Presentations vet : non indexées (pas dans VET_INDEX_SPECS), exportées
  // sans indexOptions pour reindexation côté consommateur.
  if (state.corpus.presentations.length > 0) {
    datasets.push({ type: 'presentations', rows: state.corpus.presentations });
  }
  return exportCorpusDocuments(datasets as any, outDir, 'vet', {
    last_updated: state.metadata.last_updated,
    source: state.metadata.source
  });
}

export {
exportVetSearchIndexes, exportVetCorpusDocuments
};