/**
 * Helpers partagés pour les routes de liste : pagination uniforme et factory
 * de handler de liste. La source de métadonnées est injectée pour éviter le
 * couplage dur vers un loader spécifique.
 */

import { buildPagedResponse } from './corpusPaging.mts';

export interface ListLoader {
  getMetadata: () => { last_updated: unknown; source: unknown };
  search: (dataType: string, q: string) => unknown[];
  searchPage?: (dataType: string, q: string, page?: number, limit?: number) => unknown;
  listCorpusPage: (dataType: string, page?: number, limit?: number) => unknown;
}

function toPagingArg(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function createPaginate(getMetadata: ListLoader['getMetadata']) {
  return (data: unknown[], page: number | undefined, limit: number | undefined) =>
    buildPagedResponse({
      total: data.length,
      page,
      limit,
      metadata: getMetadata(),
      materializePage: (offset, end) => data.slice(offset, end)
    });
}

function executeListQuery(
  loader: ListLoader,
  paginateLocal: (data: unknown[], page: number | undefined, limit: number | undefined) => unknown,
  dataType: string,
  q: unknown,
  page: number | undefined,
  limit: number | undefined
): unknown {
  if (q) {
    const queryStr = String(q);
    if (loader.searchPage) {
      return loader.searchPage(dataType, queryStr, page, limit);
    }
    const data = loader.search(dataType, queryStr);
    return paginateLocal(data, page, limit);
  }
  return loader.listCorpusPage(dataType, page, limit);
}

/**
 * Factory d'un handler de liste standard :
 *   - si `q` présent : recherche via `search(dataType, q)` puis pagination
 *   - sinon : `listCorpusPage(dataType, page, limit)` (méthode propre au loader)
 */
function createListHandler({ getMetadata, search, searchPage, listCorpusPage }: ListLoader) {
  const loader: ListLoader = { getMetadata, search, searchPage, listCorpusPage };
  const paginateLocal = createPaginate(getMetadata);
  return function listHandler(dataType: string, defaultLimit = 100) {
    return (req: { query: Record<string, unknown> }, res: { json: (body: unknown) => unknown }) => {
      const { q, page, limit } = req.query;
      return res.json(
        executeListQuery(
          loader,
          paginateLocal,
          dataType,
          q,
          toPagingArg(page) ?? 1,
          toPagingArg(limit) ?? defaultLimit
        )
      );
    };
  };
}

/**
 * Factory sans couplage Express retournant directement la payload paginée d'une liste.
 */
function createListExecutor(loader: ListLoader) {
  const paginateLocal = createPaginate(loader.getMetadata);
  return (dataType: string, q: unknown, page: unknown, limit: unknown, defaultLimit = 100): unknown =>
    executeListQuery(
      loader,
      paginateLocal,
      dataType,
      q,
      toPagingArg(page) ?? 1,
      toPagingArg(limit) ?? defaultLimit
    );
}

export {
  createListHandler,
  createListExecutor,
  toPagingArg
};