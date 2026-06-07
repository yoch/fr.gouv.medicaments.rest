'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Écrit un tableau de lignes en JSONL (un objet JSON par ligne).
 * @param {string} filePath
 * @param {object[]} rows
 * @param {(row: object, rowIndex: number) => object} mapRow
 * @returns {number} nombre de lignes écrites
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
 * Exporte des jeux de documents post-parse en JSONL + manifeste.
 *
 * Chaque entrée de `datasets` :
 * - `type` : identifiant (ex. specialites)
 * - `rows` : corpus en mémoire après parse
 * - `toDocument(row, rowIndex)` : forme envoyée à MiniSearch (défaut : toJSON())
 * - `indexOptions` : options passées à fromDocuments (optionnel)
 *
 * @param {object[]} datasets
 * @param {string} outDir
 * @param {string} prefix ex. bdpm, vet
 * @param {object} manifestExtra métadonnées (source, last_updated, …)
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
  writeJsonl,
  exportCorpusDocuments
};
