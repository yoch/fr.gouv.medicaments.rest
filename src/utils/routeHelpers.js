'use strict';

/**
 * Helpers partagés pour les routes de liste : pagination uniforme et factory
 * de handler de liste. La source de métadonnées est injectée pour éviter le
 * couplage dur vers un loader spécifique.
 */

const MAX_LIMIT = 1000;

function paginate(data, page = 1, limit = 100, metadata) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(MAX_LIMIT, Math.max(1, parseInt(limit, 10) || 100));
  const offset = (safePage - 1) * safeLimit;
  const paginatedData = data.slice(offset, offset + safeLimit);

  return {
    data: paginatedData,
    pagination: {
      total: data.length,
      page: safePage,
      limit: safeLimit,
      pages: Math.ceil(data.length / safeLimit)
    },
    metadata: {
      last_updated: metadata.last_updated,
      source: metadata.source
    }
  };
}

function createPaginate(getMetadata) {
  return (data, page, limit) => paginate(data, page, limit, getMetadata());
}

/**
 * Factory d'un handler de liste standard :
 *   - si `q` présent : recherche via `search(dataType, q)` puis pagination
 *   - sinon : `listCorpusPage(dataType, page, limit)` (méthode propre au loader)
 */
function createListHandler({ getMetadata, search, listCorpusPage }) {
  const paginateLocal = createPaginate(getMetadata);
  return function listHandler(dataType, defaultLimit = 100) {
    return (req, res) => {
      const { q, page = 1, limit = defaultLimit } = req.query;
      if (q) {
        const data = search(dataType, q);
        return res.json(paginateLocal(data, page, limit));
      }
      res.json(listCorpusPage(dataType, page, limit));
    };
  };
}

module.exports = { createPaginate, createListHandler };
