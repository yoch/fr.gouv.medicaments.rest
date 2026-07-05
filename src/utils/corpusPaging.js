'use strict';

const MAX_LIST_LIMIT = 1000;

function parseListPaging(page, limit, maxLimit = MAX_LIST_LIMIT) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(maxLimit, Math.max(1, parseInt(limit, 10) || 100));
  const offset = (safePage - 1) * safeLimit;
  return { safePage, safeLimit, offset };
}

/**
 * Construit l'enveloppe de réponse paginée standard `{ data, pagination, metadata }`.
 * Source unique pour les routes de liste et les loaders — supprime la duplication
 * entre `routeHelpers.paginate` (slice JS) et `listCorpusPage` (materializeRange).
 *
 * `materializePage(offset, end)` produit le tableau `data` pour la page courante
 * (slice JS, `materializeRange`, `materializeIndices` — selon la nature du corpus).
 */
function buildPagedResponse({ total, page, limit, metadata, materializePage }) {
  const { safePage, safeLimit, offset } = parseListPaging(page, limit);
  const safeTotal = Math.max(0, total | 0);
  const end = Math.min(offset + safeLimit, safeTotal);
  const data = materializePage ? materializePage(offset, end) : [];

  return {
    data,
    pagination: {
      total: safeTotal,
      page: safePage,
      limit: safeLimit,
      pages: Math.ceil(safeTotal / safeLimit) || 0
    },
    metadata: {
      last_updated: metadata.last_updated,
      source: metadata.source
    }
  };
}

module.exports = {
  parseListPaging,
  buildPagedResponse
};
