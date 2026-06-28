#!/usr/bin/env node
/**
 * Taille par "colonne" du corpus vétérinaire (instances classe, index, dict).
 * Usage: node scripts/analyze-vet-cache-size.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  createMemorySampler,
  installLoadMemoryMarks,
  uninstallLoadMemoryMarks
} = require('../src/utils/memorySampler');

function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 1000) / 1000;
}

function kb(bytes) {
  return Math.round((bytes / 1024) * 1000) / 1000;
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
    'num', 'nom', 'titulaire', 'forme_pharmaceutique',
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

/**
 * Empreinte mémoire résidente d'un index frozen 1.6+ en utilisant les
 * primitives publiques de PackedRadixTree + les typed arrays exposés en
 * `protected` (accessibles à l'exécution en JS). Complément indispensable :
 * `saveBinarySync().length` donne la forme sérialisée compacte, proche du
 * résident réel.
 */
function frozenBreakdown(idx) {
  if (!idx) return null;
  const termIndex = idx._index;
  const postings = idx._postings;
  const radixBytes = typeof termIndex?.packedByteLength === 'function'
    ? termIndex.packedByteLength()
    : null;
  const radixNodes = typeof termIndex?.packedNodeCount === 'function'
    ? termIndex.packedNodeCount()
    : null;
  const radixEdges = typeof termIndex?.packedEdgeCount === 'function'
    ? termIndex.packedEdgeCount()
    : null;

  let postingsBytes = null;
  if (postings) {
    postingsBytes = (postings.allDocIds?.byteLength || 0)
      + (postings.allFreqs?.byteLength || 0);
    if (postings.layout === 'dense') {
      postingsBytes += (postings.denseOffsets?.byteLength || 0)
        + (postings.denseLengths?.byteLength || 0);
    } else if (postings.layout === 'sparse') {
      postingsBytes += (postings.sparseTermStarts?.byteLength || 0)
        + (postings.sparseFieldIds?.byteLength || 0)
        + (postings.sparseOffsets?.byteLength || 0)
        + (postings.sparseLengths?.byteLength || 0);
    }
  }

  const fieldLengthBytes = idx._fieldLengthMatrix?.byteLength || null;
  const avgFieldLengthBytes = idx._avgFieldLength?.byteLength || null;
  const externalIdsCount = idx._externalIds?.length ?? null;

  let binarySnapshotBytes = null;
  try {
    if (typeof idx.saveBinarySync === 'function') {
      binarySnapshotBytes = idx.saveBinarySync().length;
    }
  } catch {
    binarySnapshotBytes = null;
  }

  const structuredBytes = (radixBytes || 0)
    + (postingsBytes || 0)
    + (fieldLengthBytes || 0)
    + (avgFieldLengthBytes || 0);

  return {
    documentCount: idx.documentCount,
    termCount: idx.termCount,
    radixBytes,
    radixNodes,
    radixEdges,
    postingsBytes,
    fieldLengthBytes,
    avgFieldLengthBytes,
    externalIdsCount,
    structuredBytes,
    binarySnapshotBytes
  };
}

function formatBytes(b) {
  if (b == null) return 'n/a';
  return `${kb(b)} Ko (${mb(b)} Mo)`;
}

async function main() {
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
    getVetSearchIndexes,
    getRelatedByNum
  } = require('../src/services/vetDataLoader');
  const { materializeRange, rowCount } = require('../src/utils/corpusStore');

  if (typeof global.gc === 'function') global.gc();
  const memBefore = process.memoryUsage();

  const sampler = createMemorySampler({ intervalMs: 100 });
  installLoadMemoryMarks(sampler);
  sampler.start();

  await loadVetData();

  sampler.stop();
  uninstallLoadMemoryMarks();

  if (typeof global.gc === 'function') global.gc();
  const memAfterLoad = process.memoryUsage();

  const marks = sampler.getMarks();
  const samples = sampler.getSamples();

  console.log('\n=== Pic mémoire par phase (sampler 100 ms, sans GC) ===');
  console.log(
    `  phase                              t_ms    peak_heap_mb   peak_rss_mb   delta_heap_mb`
  );
  let prevHeapMb = mb(memBefore.heapUsed);
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    const next = marks[i + 1];
    const tEnd = next ? next.t_ms : m.t_ms + 200;
    const peak = sampler.peakInWindow(m.t_ms, tEnd);
    const peakHeapMb = peak.heapUsed_mb || 0;
    const peakRssMb = peak.rss_mb || 0;
    const delta = peakHeapMb - prevHeapMb;
    const phaseLabel = (m.phase || '(sample)').padEnd(34);
    console.log(
      `  ${phaseLabel} ${String(m.t_ms).padStart(6)}   ${String(peakHeapMb).padStart(12)}   ${String(peakRssMb).padStart(11)}   ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`
    );
    prevHeapMb = peakHeapMb;
  }

  let peakHeap = 0;
  let peakRss = 0;
  let peakPhase = null;
  for (const s of samples) {
    if (s.heapUsed_mb > peakHeap) {
      peakHeap = s.heapUsed_mb;
      peakRss = s.rss_mb;
      peakPhase = s.phase || null;
    }
  }
  console.log(
    `\n  PIC GLOBAL : heap=${peakHeap} Mo rss=${peakRss} Mo${peakPhase ? ` (@${peakPhase})` : ''}`
  );

  const { corpus: stores } = getVetCorpusStats();
  const { medicaments: idxMed, compositions: idxComp } = getVetSearchIndexes();
  const medicaments = materializeRange(
    stores.medicaments,
    0,
    rowCount(stores.medicaments)
  );
  const compositions = materializeRange(
    stores.compositions,
    0,
    rowCount(stores.compositions)
  );
  const presentations = materializeRange(
    stores.presentations,
    0,
    rowCount(stores.presentations)
  );
  const metadata = getVetMetadata();

  let tempsAttenteRows = 0;
  let tempsAttenteBytes = 0;
  for (let i = 0; i < rowCount(stores.medicaments); i++) {
    const num = stores.medicaments[i].num;
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

  console.log('=== corpus vétérinaire — taille JSON (proxy heap corpus matérialisé) ===');
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

  // On mesure les index RÉELS construits par loadVetData (via getVetSearchIndexes).
  // Plus de rebuild duplicataire qui faussait le pic et le résident.
  const indexBreakdown = {
    medicaments: frozenBreakdown(idxMed),
    compositions: frozenBreakdown(idxComp)
  };

  console.log('\n=== Index frozen résidents (primitives 1.6+) ===');
  for (const [name, b] of Object.entries(indexBreakdown)) {
    if (!b) {
      console.log(`  ${name}: non construit`);
      continue;
    }
    console.log(
      `  ${name}: docs=${b.documentCount} terms=${b.termCount} radix(nodes=${b.radixNodes},edges=${b.radixEdges})`
    );
    console.log(
      `    radix=${formatBytes(b.radixBytes)} postings=${formatBytes(b.postingsBytes)} fieldLen=${formatBytes(b.fieldLengthBytes)} avgFieldLen=${formatBytes(b.avgFieldLengthBytes)}`
    );
    console.log(
      `    structured_total=${formatBytes(b.structuredBytes)} binary_snapshot=${formatBytes(b.binarySnapshotBytes)} externalIds=${b.externalIdsCount}`
    );
  }

  const memAfter = process.memoryUsage();
  console.log('\n=== Process après loadVetData (+ GC final) ===');
  console.log(
    JSON.stringify(
      {
        heapUsed_mb: mb(memAfter.heapUsed),
        rss_mb: mb(memAfter.rss),
        heap_delta_mb: mb(memAfter.heapUsed - memBefore.heapUsed),
        corpus_json_mb: corpusTotalMb
      },
      null,
      2
    )
  );

  const residentIndexMb = mb(
    (indexBreakdown.medicaments?.binarySnapshotBytes || 0)
    + (indexBreakdown.compositions?.binarySnapshotBytes || 0)
  );
  const structuredIndexMb = mb(
    (indexBreakdown.medicaments?.structuredBytes || 0)
    + (indexBreakdown.compositions?.structuredBytes || 0)
  );

  console.log('\n=== Synthèse pic build vs résident ===');
  console.log(`  pic heap pendant loadVetData : ${peakHeap} Mo${peakPhase ? ` (@${peakPhase})` : ''}`);
  console.log(`  heap résident après GC       : ${mb(memAfter.heapUsed)} Mo`);
  console.log(`  surcoût transitoire (pic - résident) : ~${Math.max(0, peakHeap - mb(memAfter.heapUsed)).toFixed(2)} Mo`);
  console.log(`  index frozen — snapshot binaire (résident ≈) : ${residentIndexMb} Mo`);
  console.log(`  index frozen — structured (radix+postings+fieldLen) : ${structuredIndexMb} Mo`);
  console.log('  note : le snapshot binaire est l\'empreinte compactée ; le pic de build');
  console.log('         englobe en plus les structures grossissantes du FrozenIndexBuilder.');

  console.log('\n=== Corpus (proxy JSON) ===');
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
