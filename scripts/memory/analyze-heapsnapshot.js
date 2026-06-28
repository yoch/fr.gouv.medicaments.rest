#!/usr/bin/env node
/**
 * Analyse un .heapsnapshot : agrège self_size par type et par (type, nom),
 * résume les top contributeurs. Format V8 (writeHeapSnapshot).
 *
 * Usage: node scripts/memory/analyze-heapsnapshot.js [path/to/file.heapsnapshot]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const file = process.argv[2] || path.join(__dirname, '..', '..', 'bdpm-peak.heapsnapshot');
if (!fs.existsSync(file)) {
  console.error('Fichier introuvable:', file);
  process.exit(1);
}

console.log(`Lecture de ${path.basename(file)} (${(fs.statSync(file).size / 1048576).toFixed(1)} Mo)...`);
const raw = fs.readFileSync(file, 'utf8');
const snap = JSON.parse(raw);

const meta = snap.snapshot.meta;
const nodeFields = meta.node_fields;           // ex: ["type","name","id","self_size","edge_count","trace_node_id","detachedness"]
const nodeTypes = meta.node_types;              // array de arrays
const strings = snap.strings;
const nodesArr = snap.nodes;
const NF = nodeFields.length;

const idxType = nodeFields.indexOf('type');
const idxName = nodeFields.indexOf('name');
const idxSelf = nodeFields.indexOf('self_size');
const idxEdges = nodeFields.indexOf('edge_count');

// Aplatir node_types pour résoudre l'index de type en nom.
const flatTypes = [];
for (const sub of nodeTypes) {
  if (Array.isArray(sub)) flatTypes.push(...sub);
  else flatTypes.push(sub);
}
function typeName(t) {
  return flatTypes[t] || `(type#${t})`;
}

const nodeCount = snap.snapshot.node_count;
console.log(`Nodes: ${nodeCount}, edges: ${snap.snapshot.edge_count}, strings: ${strings.length}`);

// Agrégations
const byType = new Map();        // type -> {count, selfBytes}
const byTypeAndName = new Map(); // "type|name" -> {count, selfBytes, type, name}
const stringNodes = [];          // {name, selfBytes} pour type string

for (let i = 0, base = 0; i < nodeCount; i++, base += NF) {
  const t = nodesArr[base + idxType];
  const nameIdx = nodesArr[base + idxName];
  const self = nodesArr[base + idxSelf] | 0;
  const tname = typeName(t);
  const name = strings[nameIdx] || '';

  let e = byType.get(tname);
  if (!e) { e = { count: 0, selfBytes: 0 }; byType.set(tname, e); }
  e.count++;
  e.selfBytes += self;

  const key = tname + '|' + name;
  let e2 = byTypeAndName.get(key);
  if (!e2) { e2 = { count: 0, selfBytes: 0, type: tname, name }; byTypeAndName.set(key, e2); }
  e2.count++;
  e2.selfBytes += self;

  if (tname === 'string' && self > 0) {
    stringNodes.push({ name, selfBytes: self });
  }
}

const mb = (b) => (b / 1048576).toFixed(2);

function top(map, n, label) {
  const arr = [...map.values()].sort((a, b) => b.selfBytes - a.selfBytes).slice(0, n);
  console.log(`\n=== ${label} (top ${n}) ===`);
  console.log('  self_Mo  count   type / name');
  console.log('  ' + '─'.repeat(78));
  for (const e of arr) {
    const name = e.name !== undefined ? e.name : '';
    const label2 = e.type !== undefined ? `${e.type} / ${name.slice(0, 50)}` : name.slice(0, 70);
    console.log(`  ${mb(e.selfBytes).padStart(7)}  ${String(e.count).padStart(6)}  ${label2}`);
  }
}

top(byType, 15, 'Par type (coarse)');

// Pour les types non-string, agrégation par (type, nom) est utile (classes, Maps, etc.)
// On filtre les strings (gérées à part) et on prend le top toutes classes confondues.
const nonStringByName = new Map();
for (const [k, v] of byTypeAndName) {
  if (v.type !== 'string') nonStringByName.set(k, v);
}
top(nonStringByName, 25, 'Par (type, nom) — hors strings');

// Strings : total + top 10 individuelles
const stringTotal = stringNodes.reduce((a, s) => a + s.selfBytes, 0);
const stringCount = stringNodes.length;
console.log(`\n=== Strings ===`);
console.log(`  total self: ${mb(stringTotal)} Mo sur ${stringCount} nodes`);
const topStrings = stringNodes.sort((a, b) => b.selfBytes - a.selfBytes).slice(0, 15);
console.log('  top 15 individuelles:');
console.log('  self_KB   type / valeur');
console.log('  ' + '─'.repeat(78));
for (const s of topStrings) {
  const val = s.name.replace(/\n/g, '\\n').slice(0, 70);
  console.log(`  ${(s.selfBytes / 1024).toFixed(1).padStart(7)}  ${val}`);
}

// Total général
let total = 0;
for (const e of byType.values()) total += e.selfBytes;
console.log(`\nTotal self_size: ${mb(total)} Mo`);
