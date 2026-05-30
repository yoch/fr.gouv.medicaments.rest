'use strict';

function createCorpus() {
  return [];
}

function clearCorpus(corpus) {
  corpus.length = 0;
}

function push(corpus, instance) {
  corpus.push(instance);
  return corpus.length - 1;
}

function rowCount(corpus) {
  return corpus.length;
}

function materializeRange(corpus, start, end) {
  const out = new Array(Math.max(0, end - start));
  let j = 0;
  for (let i = start; i < end; i++) {
    out[j++] = corpus[i].toJSON();
  }
  return out;
}

function materializeIndices(corpus, indices) {
  const out = new Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    out[i] = corpus[indices[i]].toJSON();
  }
  return out;
}

function appendToKeyList(map, key, rowIndex) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(rowIndex);
}

/**
 * @param {object[]} corpus
 * @param {string} keyName - propriété own (ex. 'cis', 'num')
 */
function buildKeyIndex(corpus, keyName, { unique = false } = {}) {
  const map = new Map();
  for (let i = 0; i < corpus.length; i++) {
    const k = corpus[i][keyName];
    if (k == null || k === '') continue;
    if (unique) {
      map.set(k, i);
    } else {
      appendToKeyList(map, k, i);
    }
  }
  return map;
}

function buildIndexDocument(instance, rowIndex, fields) {
  const doc = { id: rowIndex };
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const value = instance[field];
    if (value == null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) doc[field] = value;
      continue;
    }
    doc[field] = value;
  }
  return doc;
}

module.exports = {
  createCorpus,
  clearCorpus,
  push,
  rowCount,
  materializeRange,
  materializeIndices,
  buildKeyIndex,
  buildIndexDocument
};
