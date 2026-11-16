import { cell } from './recordJson.mts';
import { intern } from '../utils/stringPool.mts';

const EMPTY_ARRAY: readonly unknown[] = Object.freeze([]);

export interface DefineCorpusRecordOptions {
  fields: readonly string[];
  numericFields?: readonly string[];
  arrayFields?: readonly string[];
  lowCardinalityFields?: readonly string[];
  omitStoredFields?: readonly string[] | (() => readonly string[]);
  getters?: Record<string, (this: Record<string, unknown>) => unknown>;
  enrichToJson?: ((inst: Record<string, unknown>, o: Record<string, unknown>) => void) | null;
}

export interface CorpusRecordInstance extends Record<string, unknown> {
  toJSON(): Record<string, unknown>;
}

export interface CorpusRecordClass {
  new (...args: unknown[]): CorpusRecordInstance;
  fromCsv(record: Record<string, unknown> | null | undefined): CorpusRecordInstance;
  fromObject(record: Record<string, unknown> | null | undefined): CorpusRecordInstance;
  FIELD_NAMES: string[];
}

/**
 * Classe corpus monomorphe : champs dérivés de `fields` (ex. BDPM_SCHEMAS).
 */
function defineCorpusRecord(
  className: string,
  options: DefineCorpusRecordOptions
): CorpusRecordClass {
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

  function instantiateFromRecord(
    record: Record<string, unknown> | null | undefined
  ): CorpusRecordInstance {
    const inst = Object.create(CorpusRecord.prototype) as CorpusRecordInstance;
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
    static FIELD_NAMES: string[];
    [key: string]: unknown;

    constructor(...args: unknown[]) {
      const values = args[0];
      if (!values) return;
      const vals = Array.isArray(values) ? values : args;
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

    static fromCsv(record: Record<string, unknown> | null | undefined): CorpusRecordInstance {
      return instantiateFromRecord(record);
    }

    static fromObject(record: Record<string, unknown> | null | undefined): CorpusRecordInstance {
      return instantiateFromRecord(record);
    }

    toJSON(): Record<string, unknown> {
      const o: Record<string, unknown> = {};
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

  return CorpusRecord as unknown as CorpusRecordClass;
}

export {
  defineCorpusRecord
};
