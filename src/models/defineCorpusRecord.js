'use strict';

const { cell } = require('./recordJson');
const { intern } = require('../utils/stringPool');

const EMPTY_ARRAY = Object.freeze([]);

/**
 * Classe corpus monomorphe : champs dérivés de `fields` (ex. BDPM_SCHEMAS).
 * @param {string} className
 * @param {{ fields: string[], numericFields?: string[], arrayFields?: string[], lowCardinalityFields?: string[], omitStoredFields?: string[] | (() => string[]), getters?: Record<string, Function>, enrichToJson?: (inst: object, o: object) => void }} options
 */
function defineCorpusRecord(className, options) {
  const {
    fields,
    numericFields = [],
    arrayFields = [],
    lowCardinalityFields = [],
    omitStoredFields = [],
    getters = {},
    enrichToJson = null
  } = options;

  const numericSet = new Set(numericFields);
  const arraySet = new Set(arrayFields);
  const lowCardSet = new Set(lowCardinalityFields);
  const resolvedOmitStoredFields =
    typeof omitStoredFields === 'function' ? omitStoredFields() : omitStoredFields;
  const omitStoredSet = new Set(resolvedOmitStoredFields);

  const TYPE_CELL = 0;
  const TYPE_LOW_CARD = 1;
  const TYPE_ARRAY = 2;
  const TYPE_NUMERIC = 3;
  const TYPE_OMIT = 4;

  const fieldTypes = new Uint8Array(fields.length);
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (omitStoredSet.has(f)) {
      fieldTypes[i] = TYPE_OMIT;
    } else if (arraySet.has(f)) {
      fieldTypes[i] = TYPE_ARRAY;
    } else if (numericSet.has(f)) {
      fieldTypes[i] = TYPE_NUMERIC;
    } else if (lowCardSet.has(f)) {
      fieldTypes[i] = TYPE_LOW_CARD;
    } else {
      fieldTypes[i] = TYPE_CELL;
    }
  }

  function instantiateFromRecord(record) {
    const inst = Object.create(CorpusRecord.prototype);
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const type = fieldTypes[i];
      if (type === TYPE_OMIT) {
        inst[f] = '';
      } else {
        const v = record ? record[f] : undefined;
        if (type === TYPE_ARRAY) {
          inst[f] = v == null || (Array.isArray(v) && v.length === 0) ? EMPTY_ARRAY : v;
        } else if (type === TYPE_NUMERIC) {
          inst[f] = v == null || v === '' ? 0 : Number(v);
        } else if (type === TYPE_LOW_CARD) {
          inst[f] = intern(v);
        } else {
          inst[f] = cell(v);
        }
      }
    }
    return inst;
  }

  class CorpusRecord {
    constructor(values) {
      if (!values) return;
      const vals = Array.isArray(values) ? values : arguments;
      for (let i = 0; i < fields.length; i++) {
        const key = fields[i];
        const v = vals[i];
        const type = fieldTypes[i];
        if (type === TYPE_ARRAY) {
          this[key] = v == null || (Array.isArray(v) && v.length === 0) ? EMPTY_ARRAY : v;
        } else if (type === TYPE_NUMERIC) {
          this[key] = v == null || v === '' ? 0 : Number(v);
        } else {
          this[key] = cell(v);
        }
      }
    }

    static fromCsv(record) {
      return instantiateFromRecord(record);
    }

    static fromObject(record) {
      return instantiateFromRecord(record);
    }

    toJSON() {
      const o = {};
      for (let i = 0; i < fields.length; i++) {
        const key = fields[i];
        const value = this[key];
        if (value == null || value === '') continue;
        if (typeof value === 'number') {
          o[key] = value;
          continue;
        }
        if (Array.isArray(value)) {
          if (value.length > 0) o[key] = value;
          continue;
        }
        o[key] = value;
      }
      if (enrichToJson) enrichToJson(this, o);
      return o;
    }
  }

  Object.defineProperty(CorpusRecord, 'name', { value: className });
  CorpusRecord.FIELD_NAMES = fields.slice();

  for (const [name, getterFn] of Object.entries(getters)) {
    Object.defineProperty(CorpusRecord.prototype, name, {
      get: getterFn,
      enumerable: false,
      configurable: true
    });
  }

  return CorpusRecord;
}

module.exports = {
  defineCorpusRecord
};
