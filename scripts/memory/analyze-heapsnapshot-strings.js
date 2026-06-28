#!/usr/bin/env node
/**
 * Analyse focalisée sur les strings d'un .heapsnapshot :
 *  - distribution par taille (buckets)
 *  - duplication : combien de nodes partagent la même valeur (opportunité d'interning)
 *  - top strings par taille ET par nombre de copies
 *  - reteneurs des plus grosses strings (quels objets les référencent)
 *
 * Usage: node scripts/memory/analyze-heapsnapshot-strings.js [file.heapsnapshot]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const file = process.argv[2] || path.join(__dirname, '..', '..', 'bdpm-peak-end.heapsnapshot');
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
const idxEdges = nodeFields.indexOf('edge_count');

const flatTypes = [];
for (const sub of nodeTypes) { if (Array.isArray(sub)) flatTypes.push(...sub); else flatTypes.push(sub); }
function typeName(t) { return flatTypes[t] || `(type#${t})`; }

const nodeCount = snap.snapshot.node_count;

// String type index
let stringTypeIdx = -1;
for (let i = 0; i < flatTypes.length; i++) if (flatTypes[i] === 'string') { stringTypeIdx = i; break; }

// Première passe : collecter les string nodes (id, name, self) + construire index id->nodeOffset
const stringNodes = []; // {off, id, name, self}
const idToOffset = new Map();
for (let i = 0, base = 0; i < nodeCount; i++, base += NF) {
  const t = nodesArr[base + idxType];
  const id = nodesArr[base + nodeFields.indexOf('id')];
  idToOffset.set(id, base);
  if (t === stringTypeIdx) {
    const nameIdx = nodesArr[base + idxName];
    const self = nodesArr[base + idxSelf] | 0;
    stringNodes.push({ off: base, id, name: strings[nameIdx] || '', self });
  }
}

const mb = (b) => (b / 1048576).toFixed(2);
const kb = (b) => (b / 1024).toFixed(1);

console.log(`\nString nodes: ${stringNodes.length}`);
const totalSelf = stringNodes.reduce((a, s) => a + s.self, 0);
console.log(`Total self_size strings: ${mb(totalSelf)} Mo`);

// Distribution par bucket de taille
const buckets = [
  { label: '<= 32 o', min: 0, max: 33, count: 0, bytes: 0 },
  { label: '33-128 o', min: 33, max: 129, count: 0, bytes: 0 },
  { label: '129-512 o', min: 129, max: 513, count: 0, bytes: 0 },
  { label: '513-2 Ko', min: 513, max: 2049, count: 0, bytes: 0 },
  { label: '2-16 Ko', min: 2049, max: 16385, count: 0, bytes: 0 },
  { label: '> 16 Ko', min: 16385, max: Infinity, count: 0, bytes: 0 }
];
for (const s of stringNodes) {
  for (const b of buckets) {
    if (s.self >= b.min && s.self < b.max) { b.count++; b.bytes += s.self; break; }
  }
}
console.log('\nDistribution par taille:');
console.log('  bucket        count       self_Mo');
for (const b of buckets) {
  console.log(`  ${b.label.padEnd(12)}  ${String(b.count).padStart(7)}   ${mb(b.bytes).padStart(8)}`);
}

// Duplication : regrouper par valeur
const byValue = new Map(); // value -> {count, bytes}
for (const s of stringNodes) {
  let e = byValue.get(s.name);
  if (!e) { e = { count: 0, bytes: 0 }; byValue.set(s.name, e); }
  e.count++;
  e.bytes += s.self;
}
console.log(`\nValeurs distinctes: ${byValue.size} sur ${stringNodes.length} nodes`);
const dupBytes = [...byValue.values()].reduce((a, e) => a + (e.count > 1 ? e.bytes : 0), 0);
const dupNodes = [...byValue.values()].reduce((a, e) => a + (e.count > 1 ? e.count : 0), 0);
console.log(`Nodes avec valeur dupliquée: ${dupNodes} (${mb(dupBytes)} Mo)`);
console.log(`Si on internait (1 node par valeur): économie ~${mb(dupBytes - byValue.size * 40)} Mo (estimé grossier)`);

// Top 15 par nombre de copies
console.log('\nTop 15 strings par nombre de copies (opportunité interning):');
console.log('  copies   self_Mo   valeur');
const topByCopies = [...byValue.entries()]
  .map(([v, e]) => ({ v, count: e.count, bytes: e.bytes }))
  .sort((a, b) => b.count * b.bytes - a.count * a.bytes)
  .slice(0, 15);
for (const e of topByCopies) {
  console.log(`  ${String(e.count).padStart(6)}  ${mb(e.bytes).padStart(7)}   ${e.v.replace(/\n/g, '\\n').slice(0, 60)}`);
}

// Top 15 par taille individuelle
console.log('\nTop 15 strings par taille individuelle:');
console.log('  self_KB   valeur');
const topBySize = [...stringNodes].sort((a, b) => b.self - a.self).slice(0, 15);
for (const s of topBySize) {
  console.log(`  ${kb(s.self).padStart(8)}   ${s.name.replace(/\n/g, '\\n').slice(0, 70)}`);
}
