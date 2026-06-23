const fs = require('fs');
const path = require('path');
const {
  FrozenMiniSearch,
  createFrozenIndexBuilder,
  freezeFrozenIndexBuilder
} = require('@yoch/frozenminisearch');

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

function saveFrozenIndexToFile(frozenIndex, filePath) {
  const buffer = frozenIndex.saveBinarySync();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  return buffer.length;
}

function loadFrozenIndexFromFile(filePath, options) {
  const buffer = fs.readFileSync(filePath);
  return FrozenMiniSearch.loadBinarySync(buffer, options);
}

function exportFrozenIndexes(indexesByType, outDir, prefix, manifestExtra = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = {
    format: 'msv5',
    prefix,
    exported_at: new Date().toISOString(),
    indexes: {},
    ...manifestExtra
  };

  for (const [type, frozenIndex] of Object.entries(indexesByType)) {
    if (!frozenIndex) continue;
    const filename = `${prefix}_${type}.msbin`;
    const filePath = path.join(outDir, filename);
    const bytes = saveFrozenIndexToFile(frozenIndex, filePath);
    manifest.indexes[type] = {
      file: filename,
      bytes,
      documentCount: frozenIndex.documentCount,
      termCount: frozenIndex.termCount
    };
  }

  const manifestPath = path.join(outDir, `${prefix}-manifest.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

module.exports = {
  FrozenMiniSearch,
  createFrozenIndexBuilder,
  freezeFrozenIndexBuilder,
  buildFrozenIndexFromAsyncIterable,
  buildFrozenIndexFromRows,
  saveFrozenIndexToFile,
  loadFrozenIndexFromFile,
  exportFrozenIndexes
};
