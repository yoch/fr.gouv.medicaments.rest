'use strict';

/**
 * Stockage tuple : rows[i][j] aligné sur keys[j].
 * Matérialisation objet réservée à la frontière API.
 */

function createStore(keys) {
  return { keys, rows: [] };
}

function clearStore(store) {
  store.rows.length = 0;
}

function rowCount(store) {
  return store.rows.length;
}

function keyIndex(store, key) {
  return store.keys.indexOf(key);
}

/** Indices des colonnes utilisées pour l’index MiniSearch (calculé une fois par type). */
function indexFieldIndices(store, fields) {
  return fields.map((f) => keyIndex(store, f));
}

function cellFromRecord(record, key) {
  const v = record[key];
  if (v == null || v === '') return '';
  return v;
}

function pushRow(store, values) {
  store.rows.push(values);
  return store.rows.length - 1;
}

function pushFromRecord(store, record) {
  const row = store.keys.map((k) => cellFromRecord(record, k));
  return pushRow(store, row);
}

function getRowValue(store, rowIndex, columnIndex) {
  const row = store.rows[rowIndex];
  if (!row) return '';
  const v = row[columnIndex];
  return v == null || v === '' ? '' : v;
}

function toObject(store, rowIndex) {
  const row = store.rows[rowIndex];
  if (!row) return null;
  const obj = {};
  for (let j = 0; j < store.keys.length; j++) {
    const v = row[j];
    if (v == null || v === '') continue;
    obj[store.keys[j]] = v;
  }
  return obj;
}

function toObjects(store, rowIndices) {
  const out = new Array(rowIndices.length);
  for (let i = 0; i < rowIndices.length; i++) {
    out[i] = toObject(store, rowIndices[i]);
  }
  return out;
}

/** Matérialise une plage [start, end) sans toucher au reste du corpus. */
function materializeRowRange(store, start, end, mapRow = null) {
  const out = new Array(Math.max(0, end - start));
  let j = 0;
  for (let i = start; i < end; i++) {
    const obj = toObject(store, i);
    out[j++] = mapRow ? mapRow(obj, i) : obj;
  }
  return out;
}

function buildIndexDocumentFromRow(store, rowIndex, fieldIndices) {
  const doc = { id: rowIndex };
  const row = store.rows[rowIndex];
  for (let i = 0; i < fieldIndices.length; i++) {
    const idx = fieldIndices[i];
    const value = row[idx];
    if (value != null && value !== '') {
      doc[store.keys[idx]] = value;
    }
  }
  return doc;
}

function appendToKeyList(map, key, rowIndex) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(rowIndex);
}

/**
 * Index Map clé → rowIndex (unique) ou clé → rowIndex[] (one-to-many).
 */
function buildKeyIndex(store, keyName, { unique = false } = {}) {
  const col = keyIndex(store, keyName);
  const map = new Map();
  for (let i = 0; i < store.rows.length; i++) {
    const k = getRowValue(store, i, col);
    if (!k) continue;
    if (unique) {
      map.set(k, i);
    } else {
      appendToKeyList(map, k, i);
    }
  }
  return map;
}

module.exports = {
  createStore,
  clearStore,
  rowCount,
  keyIndex,
  indexFieldIndices,
  pushRow,
  pushFromRecord,
  getRowValue,
  toObject,
  toObjects,
  materializeRowRange,
  buildIndexDocumentFromRow,
  appendToKeyList,
  buildKeyIndex
};
