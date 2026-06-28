#!/usr/bin/env node
/**
 * Attribue les string nodes d'un .heapsnapshot à leurs propriétaires (retainers).
 * Pour chaque string, on remonte les arêtes entrantes et on attribue son self_size
 * au (type, name) du retainer direct. Permet de répondre : les strings résidentes
 * sont-elles portées par les CorpusRecord (interning-éligibles) ou par les
 * structures internes de frozenminisearch (termes tokenisés, non internés) ?
 *
 * Usage: node scripts/memory/analyze-heapsnapshot-string-owners.js [file.heapsnapshot]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const file = process.argv[2] || path.join(__dirname, '..', '..', 'bdpm-postload-gc.heapsnapshot');
if (!fs.existsSync(file)) {
  console.error('Fichier introuvable:', file);
  process.exit(1);
}

console.log(`Lecture de ${path.basename(file)} (${(fs.statSync(file).size / 1048576).toFixed(1)} Mo)...`);
const snap = JSON.parse(fs.readFileSync(file, 'utf8'));

const meta = snap.snapshot.meta;
const nodeFields = meta.node_fields;
const nodeTypes = meta.node_types;
const strings = snap.strings;
const nodesArr = snap.nodes;
const edgesArr = snap.edges;
const NF = nodeFields.length;
const EF = meta.edge_fields.length;

const idxType = nodeFields.indexOf('type');
const idxName = nodeFields.indexOf('name');
const idxSelf = nodeFields.indexOf('self_size');
const idxEdgeCount = nodeFields.indexOf('edge_count');
const idxId = nodeFields.indexOf('id');

const flatTypes = [];
for (const sub of nodeTypes) { if (Array.isArray(sub)) flatTypes.push(...sub); else flatTypes.push(sub); }
function typeName(t) { return flatTypes[t] || `(type#${t})`; }

let stringTypeIdx = -1;
for (let i = 0; i < flatTypes.length; i++) if (flatTypes[i] === 'string') { stringTypeIdx = i; break; }

const edgeTypeIdx = meta.edge_fields.indexOf('type');
const edgeNameIdx = meta.edge_fields.indexOf('name_or_index');
const edgeToIdx = meta.edge_fields.indexOf('to_node');
const flatEdgeTypes = [];
for (const sub of meta.edge_types) { if (Array.isArray(sub)) flatEdgeTypes.push(...sub); else flatEdgeTypes.push(sub); }

const nodeCount = snap.snapshot.node_count;

// Passe 1 : index id->offset + collecte string nodes + précalcule (type,name) par node
const nodeType = new Array(nodeCount);
const nodeName = new Array(nodeCount);
const nodeSelf = new Array(nodeCount);
const stringOffsets = [];

for (let i = 0, base = 0; i < nodeCount; i++, base += NF) {
  const t = nodesArr[base + idxType];
  nodeType[i] = typeName(t);
  nodeName[i] = strings[nodesArr[base + idxName]] || '';
  nodeSelf[i] = nodesArr[base + idxSelf] | 0;
  if (t === stringTypeIdx) stringOffsets.push(i);
}

console.log(`String nodes: ${stringOffsets.length}`);
const totalStringSelf = stringOffsets.reduce((a, o) => a + nodeSelf[o], 0);
console.log(`Total self_size strings: ${(totalStringSelf / 1048576).toFixed(2)} Mo`);

// Passe 2 : construire reverse edges (target offset -> [source offset, ...])
// Itère les nodes en séquence, chaque node a edge_count arêtes consécutives.
console.log('Construction reverse edges...');
const reverseEdges = new Map(); // target -> array of source offsets
let edgeOff = 0;
for (let i = 0, base = 0; i < nodeCount; i++, base += NF) {
  const ec = nodesArr[base + idxEdgeCount] | 0;
  for (let e = 0; e < ec; e++) {
    const ebase = edgeOff + e * EF;
    const toNode = edgesArr[ebase + edgeToIdx]; // offset dans nodes (pas id)
    if (toNode == null) continue;
    let list = reverseEdges.get(toNode);
    if (!list) { list = []; reverseEdges.set(toNode, list); }
    list.push(i);
  }
  edgeOff += ec * EF;
}

// Passe 3 : pour chaque string, attribuer self_size à son retainer.
// Stratégie : on prend le premier retainer "intéressant" (type object/hidden/
// array/concatenated string/closure — on exclut (root) et les synthetic weak refs).
// On groupe par (type, name) du retainer.
const ownerBuckets = new Map(); // "type|name" -> {count, bytes, type, name}

function isInterestingRetainer(tname) {
  return tname !== '(root)' && tname !== '(Global handles)' && tname !== '(Strong root)';
}

for (const sOff of stringOffsets) {
  const sources = reverseEdges.get(sOff * NF); // attention: to_node stocke l'OFFSET (base), pas l'index
}

// Correction : to_node dans le format V8 est l'OFFSET (index * NF), pas l'index.
// Reconstruire reverseEdges avec offset -> index.
reverseEdges.clear();
edgeOff = 0;
for (let i = 0, base = 0; i < nodeCount; i++, base += NF) {
  const ec = nodesArr[base + idxEdgeCount] | 0;
  for (let e = 0; e < ec; e++) {
    const ebase = edgeOff + e * EF;
    const toNodeOffset = edgesArr[ebase + edgeToIdx];
    if (toNodeOffset == null) continue;
    let list = reverseEdges.get(toNodeOffset);
    if (!list) { list = []; reverseEdges.set(toNodeOffset, list); }
    list.push(i);
  }
  edgeOff += ec * EF;
}

let unattributed = 0;
let multiOwner = 0;
for (const sOff of stringOffsets) {
  const sOffset = sOff * NF;
  const sources = reverseEdges.get(sOffset);
  if (!sources || sources.length === 0) {
    unattributed++;
    continue;
  }
  // Pick first interesting retainer
  let chosen = -1;
  for (const src of sources) {
    if (isInterestingRetainer(nodeType[src])) { chosen = src; break; }
  }
  if (chosen < 0) chosen = sources[0];
  const key = `${nodeType[chosen]}|${nodeName[chosen]}`;
  let b = ownerBuckets.get(key);
  if (!b) { b = { count: 0, bytes: 0, type: nodeType[chosen], name: nodeName[chosen] }; ownerBuckets.set(key, b); }
  b.count++;
  b.bytes += nodeSelf[sOff];
  if (sources.length > 1) multiOwner++;
}

console.log(`Strings multi-reteneurs: ${multiOwner}`);
console.log(`Strings sans reteneur: ${unattributed}`);

// Top 25 owners
const top = [...ownerBuckets.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 25);
console.log('\nTop 25 propriétaires de strings (par self_size attribué) :');
console.log('  self_Mo   count   type                  name');
console.log('  ' + '─'.repeat(90));
for (const b of top) {
  console.log(`  ${(b.bytes / 1048576).toFixed(2).padStart(7)}  ${String(b.count).padStart(6)}   ${b.type.padEnd(20)}  ${b.name.slice(0, 50)}`);
}

// Regroupement macro : CorpusRecord classes vs frozen/index structures vs intern pool vs autres
const CORPUS_CLASSES = ['Specialite', 'Presentation', 'Composition', 'AvisSmr', 'AvisAsmr',
  'Generique', 'Condition', 'Rupture', 'Mitm', 'Substance',
  'MedicamentVet', 'CompositionVet', 'PresentationVet', 'CorpusRecord'];
function classify(b) {
  if (CORPUS_CLASSES.includes(b.name)) return 'CorpusRecord (corpus dataCache)';
  if (b.name === 'Map' || b.name === 'Set') return 'Map/Set (intern pool / dicts / key indices)';
  if (b.type === 'array' || b.name === 'Array') return 'Array (index structures / postings)';
  if (b.name === 'Object' || b.type === 'object') return 'Object (divers, dont frozen index)';
  if (b.type === 'concatenated string') return 'concatenated string (tokens)';
  if (b.type === 'sliced string') return 'sliced string (tokens)';
  if (b.type === 'code') return 'code/strings internes V8';
  return 'autre';
}
const macro = new Map();
for (const b of ownerBuckets.values()) {
  const k = classify(b);
  let m = macro.get(k);
  if (!m) { m = { count: 0, bytes: 0 }; macro.set(k, m); }
  m.count += b.count;
  m.bytes += b.bytes;
}
console.log('\nAttribution macro (self_size strings par catégorie de propriétaire) :');
console.log('  catégorie                                     self_Mo     count');
console.log('  ' + '─'.repeat(70));
const macroSorted = [...macro.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
for (const [k, m] of macroSorted) {
  console.log(`  ${k.padEnd(46)} ${(m.bytes / 1048576).toFixed(2).padStart(7)}   ${String(m.count).padStart(7)}`);
}
const totalAttributed = macroSorted.reduce((a, [, m]) => a + m.bytes, 0);
console.log(`  ${'TOTAL attribué'.padEnd(46)} ${(totalAttributed / 1048576).toFixed(2).padStart(7)}`);
