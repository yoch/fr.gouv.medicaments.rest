#!/usr/bin/env node
/**
 * Taille par "colonne" du corpus vétérinaire (vetStores tuple, index, dict).
 * Usage: node scripts/analyze-vet-cache-size.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 1000) / 1000;
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function fieldBytes(rows, field) {
  let n = 0;
  for (const row of rows) {
    const v = row[field];
    if (v == null) continue;
    if (Array.isArray(v)) {
      n += jsonBytes(v);
    } else {
      n += Buffer.byteLength(String(v), 'utf8');
    }
  }
  return n;
}

function mapToObject(map) {
  return Object.fromEntries(map);
}

function breakdownMedicaments(rows) {
  const fields = [
    'num', 'nom', 'num_amm', 'date_amm', 'titulaire', 'forme_pharmaceutique',
    'statut_amm', 'codes_atcvet', 'especes', 'maj_rcp'
  ];
  const out = {};
  for (const f of fields) {
    out[f] = { bytes: fieldBytes(rows, f), mb: mb(fieldBytes(rows, f)) };
  }
  return out;
}

function breakdownCompositions(rows) {
  const fields = ['num', 'substance', 'quantite', 'unite'];
  const out = {};
  for (const f of fields) {
    out[f] = { bytes: fieldBytes(rows, f), mb: mb(fieldBytes(rows, f)) };
  }
  return out;
}

function breakdownPresentations(rows) {
  const fields = ['num', 'libelle', 'gtin', 'conditions_delivrance'];
  const out = {};
  for (const f of fields) {
    out[f] = { bytes: fieldBytes(rows, f), mb: mb(fieldBytes(rows, f)) };
  }
  return out;
}

async function main() {
  const { frozenMemoryBreakdown } = require('@yoch/minisearch');
  const {
    VET_DATA_DIR,
    PRODUCTS_XML_NAME,
    DICT_XML_NAME
  } = require('../src/services/vetDataDownloader');

  const dataDir = process.env.VET_DATA_DIR || VET_DATA_DIR;
  const productsPath = path.join(dataDir, PRODUCTS_XML_NAME);
  const dictPath = path.join(dataDir, DICT_XML_NAME);
  const archivePath = path.join(dataDir, 'amm-vet-fr-v2-v.7z');

  const files = {
    xml_products_mb: mb(fs.statSync(productsPath).size),
    dict_xml_mb: mb(fs.statSync(dictPath).size),
    archive_7z_mb: fs.existsSync(archivePath) ? mb(fs.statSync(archivePath).size) : null
  };

  console.log('=== Fichiers disque (pas en RAM après extract) ===');
  console.log(JSON.stringify(files, null, 2));
  console.log(
    '\n→ La décompression 7z est faite au download/extract une fois ; au boot on lit le .xml déjà décompressé (~'
    + files.xml_products_mb +
    ' Mo fichier). Peu probable que le pic runtime = décompression.\n'
  );

  const {
    loadVetData,
    getVetMetadata,
    getVetCorpusStats,
    getRelatedByNum
  } = require('../src/services/vetDataLoader');
  const { materializeRowRange, rowCount, getRowValue, keyIndex } = require('../src/utils/rowStore');

  if (typeof global.gc === 'function') global.gc();
  const memBefore = process.memoryUsage();

  await loadVetData();

  const { stores } = getVetCorpusStats();
  const medicaments = materializeRowRange(
    stores.medicaments,
    0,
    rowCount(stores.medicaments)
  );
  const compositions = materializeRowRange(
    stores.compositions,
    0,
    rowCount(stores.compositions)
  );
  const presentations = materializeRowRange(
    stores.presentations,
    0,
    rowCount(stores.presentations)
  );
  const metadata = getVetMetadata();

  const medNumIdx = keyIndex(stores.medicaments, 'num');
  let tempsAttenteRows = 0;
  let tempsAttenteBytes = 0;
  for (let i = 0; i < rowCount(stores.medicaments); i++) {
    const num = getRowValue(stores.medicaments, i, medNumIdx);
    const rows = getRelatedByNum('temps_attente', num, 0);
    tempsAttenteRows += rows.length;
    tempsAttenteBytes += jsonBytes(rows);
  }

  const corpus = {
    medicaments: { count: medicaments.length, json_mb: mb(jsonBytes(medicaments)) },
    compositions: { count: compositions.length, json_mb: mb(jsonBytes(compositions)) },
    presentations: { count: presentations.length, json_mb: mb(jsonBytes(presentations)) },
    temps_attente: {
      count_rows: tempsAttenteRows,
      json_mb: mb(tempsAttenteBytes),
      note: 'lignes agrégées via getRelatedByNum (Map interne)'
    },
    metadata: { json_mb: mb(jsonBytes(metadata)) },
    dict_at_load_mb: mb(fs.readFileSync(dictPath).length)
  };

  const corpusTotalMb =
    corpus.medicaments.json_mb +
    corpus.compositions.json_mb +
    corpus.presentations.json_mb +
    corpus.temps_attente.json_mb;

  console.log('=== vetStores — taille JSON (proxy heap corpus matérialisé) ===');
  console.log(JSON.stringify({ corpus_total_json_mb: Math.round(corpusTotalMb * 1000) / 1000, ...corpus }, null, 2));

  console.log('\n=== Par champ (somme des octets stringifiés par colonne) ===');

  const medFields = breakdownMedicaments(medicaments);
  const medTotal = Object.values(medFields).reduce((s, x) => s + x.bytes, 0);
  console.log('\nmedicaments (' + medicaments.length + ' lignes, ~' + mb(medTotal) + ' Mo champs):');
  for (const [k, v] of Object.entries(medFields).sort((a, b) => b.bytes - a.bytes)) {
    console.log(`  ${k.padEnd(22)} ${String(v.mb).padStart(8)} Mo  (${((v.bytes / medTotal) * 100).toFixed(1)}%)`);
  }

  const compFields = breakdownCompositions(compositions);
  const compTotal = Object.values(compFields).reduce((s, x) => s + x.bytes, 0);
  console.log('\ncompositions (' + compositions.length + ' lignes, ~' + mb(compTotal) + ' Mo champs):');
  for (const [k, v] of Object.entries(compFields).sort((a, b) => b.bytes - a.bytes)) {
    console.log(`  ${k.padEnd(22)} ${String(v.mb).padStart(8)} Mo  (${((v.bytes / compTotal) * 100).toFixed(1)}%)`);
  }

  const presFields = breakdownPresentations(presentations);
  const presTotal = Object.values(presFields).reduce((s, x) => s + x.bytes, 0);
  console.log('\npresentations (' + presentations.length + ' lignes, ~' + mb(presTotal) + ' Mo champs):');
  for (const [k, v] of Object.entries(presFields).sort((a, b) => b.bytes - a.bytes)) {
    console.log(`  ${k.padEnd(22)} ${String(v.mb).padStart(8)} Mo  (${((v.bytes / presTotal) * 100).toFixed(1)}%)`);
  }

  const { buildFrozenIndexFromRows } = require('../src/utils/frozenMiniSearch');
  const { miniSearchOptions } = require('../src/utils/searchRanking');

  function vetIndexConfig(fields, boost) {
    const c = { fields, storeFields: ['id'], ...miniSearchOptions };
    if (boost) c.boost = boost;
    return c;
  }

  function buildVetIndexDocument(item, rowIndex, fields) {
    const doc = { id: rowIndex };
    for (const field of fields) {
      const value = item[field];
      if (value != null && value !== '') doc[field] = value;
    }
    return doc;
  }

  const medFieldsIdx = ['nom', 'num'];
  const compFieldsIdx = ['substance', 'num'];

  const idxMed = buildFrozenIndexFromRows(
    medicaments,
    (item, i) => buildVetIndexDocument(item, i, medFieldsIdx),
    vetIndexConfig(medFieldsIdx, { nom: 3, num: 2 })
  );
  const idxComp = buildFrozenIndexFromRows(
    compositions,
    (item, i) => buildVetIndexDocument(item, i, compFieldsIdx),
    vetIndexConfig(compFieldsIdx, { substance: 3, num: 1 })
  );

  const indexBreakdown = {
    medicaments: frozenMemoryBreakdown(idxMed),
    compositions: frozenMemoryBreakdown(idxComp)
  };

  console.log('\n=== Index frozen (estimation @yoch/minisearch) ===');
  for (const [name, b] of Object.entries(indexBreakdown)) {
    const structured = b.estimatedStructuredBytes / 1024 / 1024;
    console.log(
      `  ${name}: docs=${b.documentCount} terms=${b.termCount} structured≈${structured.toFixed(2)} Mo storedJson≈${(b.storedFieldsJsonBytes / 1024).toFixed(0)} Ko`
    );
  }

  const memAfter = process.memoryUsage();
  console.log('\n=== Process après loadVetData ===');
  console.log(
    JSON.stringify(
      {
        heapUsed_mb: mb(memAfter.heapUsed),
        rss_mb: mb(memAfter.rss),
        heap_delta_mb: mb(memAfter.heapUsed - memBefore.heapUsed),
        corpus_json_mb: corpusTotalMb,
        note: 'RSS >> corpus JSON = arènes V8 + index + parse transitoire non compacté'
      },
      null,
      2
    )
  );

  console.log('\n=== Synthèse ===');
  const sorted = [
    ['presentations', corpus.presentations.json_mb],
    ['compositions', corpus.compositions.json_mb],
    ['medicaments', corpus.medicaments.json_mb],
    ['temps_attente', corpus.temps_attente.json_mb],
    ['dict (lecture sync)', corpus.dict_at_load_mb]
  ].sort((a, b) => b[1] - a[1]);
  for (const [name, size] of sorted) {
    console.log(`  ${name}: ${size} Mo (JSON)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
