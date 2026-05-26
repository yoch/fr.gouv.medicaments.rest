const {
  FrozenMiniSearch,
  createFrozenIndexBuilder,
  freezeFrozenIndexBuilder
} = require('@yoch/minisearch');

/**
 * Index async (ex. flux CSV) : un document à la fois, sans tableau intermédiaire.
 */
function buildFrozenIndexFromAsyncIterable(asyncDocuments, options) {
  return FrozenMiniSearch.fromAsyncIterable(asyncDocuments, options);
}

/**
 * Corpus déjà en mémoire (ex. substances dérivées des compositions).
 */
function buildFrozenIndexFromRows(rows, buildDocument, options) {
  const builder = createFrozenIndexBuilder(options, {
    estimatedDocumentCount: rows.length
  });
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    builder.add(buildDocument(rows[rowIndex], rowIndex));
  }
  return freezeFrozenIndexBuilder(builder);
}

module.exports = {
  FrozenMiniSearch,
  createFrozenIndexBuilder,
  freezeFrozenIndexBuilder,
  buildFrozenIndexFromAsyncIterable,
  buildFrozenIndexFromRows
};
