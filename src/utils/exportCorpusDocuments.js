'use strict';

const fs = require('fs');
const path = require('path');
const { buildIndexDocument } = require('./corpusStore');
const { miniSearchIndexConfig } = require('./miniSearchIndexConfig');

/**
 * Écrit un tableau de lignes en JSONL (un objet JSON par ligne).
 */
function writeJsonl(filePath, rows, mapRow) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'w');
  try {
    for (let i = 0; i < rows.length; i++) {
      fs.writeSync(fd, `${JSON.stringify(mapRow(rows[i], i))}\n`);
    }
  } finally {
    fs.closeSync(fd);
  }
  return rows.length;
}

/**
 * Construit la liste de `datasets` à exporter à partir des specs d'index.
 * Source unique pour BDPM et vet — supprime la duplication des exportApi.
 *
 * @param {object} corpus map type → rows
 * @param {object} specs map type → { fields, boost } (BDPM_INDEX_SPECS / VET_INDEX_SPECS)
 * @param {object} options
 *   - `onlyIndexed` : sauter les types dont l'index frozen est absent (BDPM
 *     n'exporte que les types indexés ; vet exporte aussi presentations non-indexé)
 *   - `searchIndexes` : requis si `onlyIndexed` (map type → frozen index)
 */
function buildDatasetsFromSpecs(corpus, specs, options = {}) {
  const { onlyIndexed = false, searchIndexes = {} } = options;
  const datasets = [];

  for (const [type, spec] of Object.entries(specs)) {
    const rows = corpus[type];
    if (!rows || rows.length === 0) continue;
    if (onlyIndexed && !searchIndexes[type]) continue;

    const { fields, boost } = spec;
    datasets.push({
      type,
      rows,
      toDocument: (item, rowIndex) => buildIndexDocument(item, rowIndex, fields),
      indexOptions: miniSearchIndexConfig(fields, boost)
    });
  }

  return datasets;
}

/**
 * Exporte des jeux de documents post-parse en JSONL + manifeste.
 */
function exportCorpusDocuments(datasets, outDir, prefix, manifestExtra = {}) {
  fs.mkdirSync(outDir, { recursive: true });

  const manifest = {
    format: 'corpus-jsonl-v1',
    description:
      'Documents post-parse en JSONL. Les jeux avec indexOptions sont prêts pour FrozenMiniSearch.fromDocuments().',
    prefix,
    exported_at: new Date().toISOString(),
    ...manifestExtra,
    datasets: {}
  };

  for (const dataset of datasets) {
    const { type, rows, toDocument, indexOptions } = dataset;
    if (!rows || rows.length === 0) continue;

    const filename = `${prefix}_${type}.jsonl`;
    const filePath = path.join(outDir, filename);
    const mapRow =
      toDocument ||
      ((row) => (typeof row.toJSON === 'function' ? row.toJSON() : row));
    const documentCount = writeJsonl(filePath, rows, mapRow);

    manifest.datasets[type] = {
      file: filename,
      documentCount,
      ...(indexOptions ? { indexOptions } : {})
    };
  }

  const manifestPath = path.join(outDir, `${prefix}-corpus-manifest.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

module.exports = {
  buildDatasetsFromSpecs,
  exportCorpusDocuments
};
