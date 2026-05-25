const { FrozenMiniSearch } = require('@yoch/minisearch');

const DOCUMENT_BATCH_SIZE = 2000;

/**
 * Construit un FrozenMiniSearch en une passe (sans index MiniSearch mutable).
 * Les documents sont matérialisés par lots puis passés à fromDocuments.
 */
function buildFrozenIndexFromRows(rows, buildDocument, options) {
  const documents = [];
  for (let start = 0; start < rows.length; start += DOCUMENT_BATCH_SIZE) {
    const end = Math.min(start + DOCUMENT_BATCH_SIZE, rows.length);
    for (let rowIndex = start; rowIndex < end; rowIndex++) {
      documents.push(buildDocument(rows[rowIndex], rowIndex));
    }
  }

  const frozen = FrozenMiniSearch.fromDocuments(documents, options);
  documents.length = 0;
  return frozen;
}

module.exports = {
  FrozenMiniSearch,
  buildFrozenIndexFromRows
};
