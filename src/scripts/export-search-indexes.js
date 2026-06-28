#!/usr/bin/env node
/**
 * Construit les index FrozenMiniSearch (BDPM + vétérinaire) et les exporte en MSv5 (.msbin).
 *
 * Usage:
 *   node src/scripts/export-search-indexes.js
 *   SEARCH_INDEX_OUT_DIR=data/search-indexes SKIP_VET=1 node src/scripts/export-search-indexes.js
 */

const { loadData, exportBdpmSearchIndexes } = require('../services/dataLoader');
const { loadVetData, exportVetSearchIndexes } = require('../services/vetDataLoader');
const config = require('../config');

const OUT_DIR = config.searchIndexOutDir;
const SKIP_VET = config.skipVet;

async function main() {
  console.log(`Répertoire de sortie: ${OUT_DIR}`);

  await loadData();
  const bdpmManifest = exportBdpmSearchIndexes(OUT_DIR);
  const bdpmCount = Object.keys(bdpmManifest.indexes).length;
  const bdpmBytes = Object.values(bdpmManifest.indexes).reduce((s, e) => s + e.bytes, 0);
  console.log(`BDPM: ${bdpmCount} index → ${(bdpmBytes / 1024 / 1024).toFixed(2)} Mo`);

  if (SKIP_VET) {
    console.log('Vétérinaire ignoré (SKIP_VET)');
    return;
  }

  await loadVetData();
  const vetManifest = exportVetSearchIndexes(OUT_DIR);
  const vetCount = Object.keys(vetManifest.indexes).length;
  const vetBytes = Object.values(vetManifest.indexes).reduce((s, e) => s + e.bytes, 0);
  console.log(`Vétérinaire: ${vetCount} index → ${(vetBytes / 1024 / 1024).toFixed(2)} Mo`);

  console.log('Manifestes:', `${OUT_DIR}/bdpm-manifest.json`, `${OUT_DIR}/vet-manifest.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
