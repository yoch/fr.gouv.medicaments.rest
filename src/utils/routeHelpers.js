'use strict';

/**
 * Helpers partagés pour les routes de liste : pagination uniforme et factory
 * de handler de liste. La source de métadonnées est injectée pour éviter le
 * couplage dur vers un loader spécifique.
 */

const { buildPagedResponse } = require('./corpusPaging');

function createPaginate(getMetadata) {
  return (data, page, limit) =>
    buildPagedResponse({
      total: data.length,
      page,
      limit,
      metadata: getMetadata(),
      materializePage: (offset, end) => data.slice(offset, end)
    });
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
