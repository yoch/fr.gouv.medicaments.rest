'use strict';

const { cell } = require('./recordJson');

const EMPTY_ARRAY = Object.freeze([]);

/**
 * Classe corpus monomorphe : champs dérivés de `fields` (ex. BDPM_SCHEMAS).
 * @param {string} className
 * @param {{ fields: string[], numericFields?: string[], arrayFields?: string[], getters?: Record<string, Function>, enrichToJson?: (inst: object, o: object) => void }} options
 */
function defineCorpusRecord(className, options) {
  const {
    fields,
    numericFields = [],
    arrayFields = [],
    getters = {},
    enrichToJson = null
  } = options;

  const numericSet = new Set(numericFields);
  const arraySet = new Set(arrayFields);

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
      return new CorpusRecord(...fields.map((f) => record[f]));
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
