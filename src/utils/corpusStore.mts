export interface CorpusRecordLike {
  toJSON(): Record<string, unknown>;
  [key: string]: unknown;
}

export type Corpus<T extends CorpusRecordLike = CorpusRecordLike> = T[];

function createCorpus<T extends CorpusRecordLike = CorpusRecordLike>(): Corpus<T> {
  return [];
}

function clearCorpus<T extends CorpusRecordLike>(corpus: Corpus<T>): void {
  corpus.length = 0;
}

function push<T extends CorpusRecordLike>(corpus: Corpus<T>, instance: T): number {
  corpus.push(instance);
  return corpus.length - 1;
}

function rowCount<T extends CorpusRecordLike>(corpus: Corpus<T>): number {
  return corpus.length;
}

function materializeRange<T extends CorpusRecordLike>(corpus: Corpus<T>, start: number, end: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = new Array(Math.max(0, end - start));
  let j = 0;
  for (let i = start; i < end; i++) {
    out[j++] = corpus[i].toJSON();
  }
  return out;
}

function materializeIndices<T extends CorpusRecordLike>(corpus: Corpus<T>, indices: number[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = new Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    out[i] = corpus[indices[i]].toJSON();
  }
  return out;
}

function appendToKeyList(map: Map<string, number[]>, key: string, rowIndex: number): void {
  if (!key) return;
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  list.push(rowIndex);
}

function buildKeyIndex(
  corpus: CorpusRecordLike[],
  keyName: string,
  options: { unique: true }
): Map<string, number>;
function buildKeyIndex(
  corpus: CorpusRecordLike[],
  keyName: string,
  options?: { unique?: false }
): Map<string, number[]>;
function buildKeyIndex(
  corpus: CorpusRecordLike[],
  keyName: string,
  options: { unique?: boolean } = {}
): Map<string, number | number[]> {
  const unique = Boolean(options.unique);
  const map = new Map<string, number | number[]>();
  for (let i = 0; i < corpus.length; i++) {
    const k = corpus[i][keyName];
    if (k == null || k === '') continue;
    const keyStr = String(k);
    if (unique) {
      map.set(keyStr, i);
    } else {
      appendToKeyList(map as Map<string, number[]>, keyStr, i);
    }
  }
  return map;
}

function buildIndexDocument(
  instance: CorpusRecordLike,
  rowIndex: number,
  fields: string[]
): Record<string, unknown> {
  const doc: Record<string, unknown> = { id: rowIndex };
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

export {
  createCorpus,
  clearCorpus,
  push,
  rowCount,
  materializeRange,
  materializeIndices,
  appendToKeyList,
  buildKeyIndex,
  buildIndexDocument
};
