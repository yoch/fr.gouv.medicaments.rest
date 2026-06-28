#!/usr/bin/env node
/**
 * Exporte les documents post-parse (CSV / XML) en JSONL, prêts pour fromDocuments().
 *
 * Usage:
 *   node src/scripts/export-corpus-documents.js
 *   CORPUS_EXPORT_OUT_DIR=data/corpus-export SKIP_VET=1 node src/scripts/export-corpus-documents.js
 */

const { loadData, exportBdpmCorpusDocuments } = require('../services/dataLoader');
const { loadVetData, exportVetCorpusDocuments } = require('../services/vetDataLoader');
const config = require('../config');

const OUT_DIR = config.corpusExportOutDir;
const SKIP_VET = config.skipVet;

async function main() {
  console.log(`Répertoire de sortie: ${OUT_DIR}`);

  await loadData();
  const bdpmManifest = exportBdpmCorpusDocuments(OUT_DIR);
  const bdpmCount = Object.keys(bdpmManifest.datasets).length;
  const bdpmDocs = Object.values(bdpmManifest.datasets).reduce(
    (sum, entry) => sum + entry.documentCount,
    0
  );
  console.log(`BDPM: ${bdpmCount} jeux → ${bdpmDocs.toLocaleString('fr-FR')} documents`);

  if (SKIP_VET) {
    console.log('Vétérinaire ignoré (SKIP_VET)');
    console.log('Manifeste:', `${OUT_DIR}/bdpm-corpus-manifest.json`);
    return;
  }

  await loadVetData();
  const vetManifest = exportVetCorpusDocuments(OUT_DIR);
  const vetCount = Object.keys(vetManifest.datasets).length;
  const vetDocs = Object.values(vetManifest.datasets).reduce(
    (sum, entry) => sum + entry.documentCount,
    0
  );
  console.log(`Vétérinaire: ${vetCount} jeux → ${vetDocs.toLocaleString('fr-FR')} documents`);
  console.log(
    'Manifestes:',
    `${OUT_DIR}/bdpm-corpus-manifest.json`,
    `${OUT_DIR}/vet-corpus-manifest.json`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
