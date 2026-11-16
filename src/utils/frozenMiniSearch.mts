import fs from 'node:fs';
import path from 'node:path';
import {
  FrozenMiniSearch,
  createFrozenIndexBuilder,
  freezeFrozenIndexBuilder,
  type Options
} from '@yoch/frozenminisearch';
import type { SearchIndexLike } from './corpusSearch.mts';

/**
 * Index async (ex. flux CSV) : un document à la fois, sans tableau intermédiaire.
 */
function buildFrozenIndexFromAsyncIterable(
  asyncDocuments: AsyncIterable<Record<string, unknown>>,
  options: Options<Record<string, unknown>>
): Promise<FrozenMiniSearch<Record<string, unknown>>> {
  return FrozenMiniSearch.fromAsyncIterable<
    Record<string, unknown>,
    FrozenMiniSearch<Record<string, unknown>>
  >(asyncDocuments, options);
}

/**
 * Corpus déjà en mémoire (ex. substances dérivées des compositions).
 */
function buildFrozenIndexFromRows<R>(
  rows: readonly R[],
  buildDocument: (row: R, index: number) => Record<string, unknown>,
  options: Options<Record<string, unknown>>
): FrozenMiniSearch<Record<string, unknown>> {
  const builder = createFrozenIndexBuilder(options, {
    estimatedDocumentCount: rows.length
  });
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    builder.add(buildDocument(rows[rowIndex], rowIndex));
  }
  return freezeFrozenIndexBuilder(builder);
}

export interface ExportableFrozenIndex extends SearchIndexLike {
  saveBinarySync?(): Uint8Array;
  documentCount?: number;
  termCount?: number;
}

function saveFrozenIndexToFile(
  frozenIndex: ExportableFrozenIndex,
  filePath: string
): number {
  if (typeof frozenIndex.saveBinarySync !== 'function') {
    throw new TypeError('Index FrozenMiniSearch non sérialisable');
  }
  const buffer = frozenIndex.saveBinarySync();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  return buffer.length;
}

export interface ExportedIndexMeta {
  file: string;
  bytes: number;
  documentCount: number;
  termCount: number;
}

export interface ExportedIndexManifest {
  format: string;
  prefix: string;
  exported_at: string;
  indexes: Record<string, ExportedIndexMeta>;
  [key: string]: unknown;
}

function exportFrozenIndexes(
  indexesByType: Record<string, ExportableFrozenIndex | null | undefined>,
  outDir: string,
  prefix: string,
  manifestExtra: Record<string, unknown> = {}
): ExportedIndexManifest {
  fs.mkdirSync(outDir, { recursive: true });
  const indexes: Record<string, ExportedIndexMeta> = {};

  for (const [type, frozenIndex] of Object.entries(indexesByType)) {
    if (!frozenIndex) continue;
    const filename = `${prefix}_${type}.msbin`;
    const filePath = path.join(outDir, filename);
    const bytes = saveFrozenIndexToFile(frozenIndex, filePath);
    indexes[type] = {
      file: filename,
      bytes,
      documentCount: frozenIndex.documentCount ?? 0,
      termCount: frozenIndex.termCount ?? 0
    };
  }

  const manifest: ExportedIndexManifest = {
    format: 'msv5',
    prefix,
    exported_at: new Date().toISOString(),
    indexes,
    ...manifestExtra
  };

  const manifestPath = path.join(outDir, `${prefix}-manifest.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export {
  buildFrozenIndexFromAsyncIterable,
  buildFrozenIndexFromRows,
  exportFrozenIndexes
};
