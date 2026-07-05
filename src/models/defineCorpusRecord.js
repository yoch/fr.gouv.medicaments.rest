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

  class CorpusRecord {
    constructor(...values) {
      for (let i = 0; i < fields.length; i++) {
        const key = fields[i];
        const v = values[i];
        if (arraySet.has(key)) {
          this[key] = v == null || (Array.isArray(v) && v.length === 0) ? EMPTY_ARRAY : v;
        } else if (numericSet.has(key)) {
          this[key] = v == null || v === '' ? 0 : Number(v);
        } else {
          this[key] = cell(v);
        }
      }
    }

    static fromCsv(record) {
      const args = new Array(fields.length);
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        let v = record[f];
        if (omitStoredSet.has(f)) v = '';
        args[i] = lowCardSet.has(f) ? intern(v) : v;
      }
      return new CorpusRecord(...args);
    }

    static fromObject(record) {
      const args = new Array(fields.length);
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        let v = record ? record[f] : undefined;
        if (omitStoredSet.has(f)) v = '';
        args[i] = lowCardSet.has(f) ? intern(v) : v;
      }
      return new CorpusRecord(...args);
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
