'use strict';

/**
 * Empreinte mémoire résidente d'un index frozen 1.6+ via les primitives
 * publiques de PackedRadixTree + les typed arrays exposés en `protected`.
 * Complément : `saveBinarySync().length` donne la forme sérialisée compacte,
 * proche du résident réel.
 *
 * Partagé entre analyze-bdpm-cache-size et analyze-vet-cache-size.
 */

function frozenBreakdown(idx) {
  if (!idx) return null;
  const termIndex = idx._index;
  const postings = idx._postings;

  const radixBytes = typeof termIndex?.packedByteLength === 'function'
    ? termIndex.packedByteLength()
    : null;
  const radixNodes = typeof termIndex?.packedNodeCount === 'function'
    ? termIndex.packedNodeCount()
    : null;
  const radixEdges = typeof termIndex?.packedEdgeCount === 'function'
    ? termIndex.packedEdgeCount()
    : null;

  let postingsBytes = null;
  if (postings) {
    postingsBytes = (postings.allDocIds?.byteLength || 0)
      + (postings.allFreqs?.byteLength || 0);
    if (postings.layout === 'dense') {
      postingsBytes += (postings.denseOffsets?.byteLength || 0)
        + (postings.denseLengths?.byteLength || 0);
    } else if (postings.layout === 'sparse') {
      postingsBytes += (postings.sparseTermStarts?.byteLength || 0)
        + (postings.sparseFieldIds?.byteLength || 0)
        + (postings.sparseOffsets?.byteLength || 0)
        + (postings.sparseLengths?.byteLength || 0);
    }
  }

  const fieldLengthBytes = idx._fieldLengthMatrix?.byteLength || null;
  const avgFieldLengthBytes = idx._avgFieldLength?.byteLength || null;
  const externalIdsCount = idx._externalIds?.length ?? null;

  let binarySnapshotBytes = null;
  try {
    if (typeof idx.saveBinarySync === 'function') {
      binarySnapshotBytes = idx.saveBinarySync().length;
    }
  } catch {
    binarySnapshotBytes = null;
  }

  const structuredBytes = (radixBytes || 0)
    + (postingsBytes || 0)
    + (fieldLengthBytes || 0)
    + (avgFieldLengthBytes || 0);

  return {
    documentCount: idx.documentCount,
    termCount: idx.termCount,
    radixBytes,
    radixNodes,
    radixEdges,
    postingsBytes,
    fieldLengthBytes,
    avgFieldLengthBytes,
    externalIdsCount,
    structuredBytes,
    binarySnapshotBytes
  };
}

module.exports = { frozenBreakdown };
