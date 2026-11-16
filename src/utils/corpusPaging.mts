const MAX_LIST_LIMIT = 1000;

export interface ListPaging {
  safePage: number;
  safeLimit: number;
  offset: number;
}

export interface PagedResponseInput<T = unknown, S = unknown> {
  total: number;
  page?: unknown;
  limit?: unknown;
  metadata: { last_updated: unknown; source: unknown };
  materializePage?: (offset: number, end: number) => T[];
  search?: S;
}

export interface PagedResponse<T = unknown, S = unknown> {
  data: T[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
  metadata: {
    last_updated: unknown;
    source: unknown;
  };
  search?: S;
}

function parseListPaging(page: unknown, limit: unknown, maxLimit = MAX_LIST_LIMIT): ListPaging {
  const safePage = Math.max(1, parseInt(String(page ?? ''), 10) || 1);
  const safeLimit = Math.min(maxLimit, Math.max(1, parseInt(String(limit ?? ''), 10) || 100));
  const offset = (safePage - 1) * safeLimit;
  return { safePage, safeLimit, offset };
}

/**
 * Construit l'enveloppe de réponse paginée standard `{ data, pagination, metadata }`.
 */
function buildPagedResponse<T = unknown, S = unknown>({
  total,
  page,
  limit,
  metadata,
  materializePage,
  search
}: PagedResponseInput<T, S>): PagedResponse<T, S> {
  const { safePage, safeLimit, offset } = parseListPaging(page, limit);
  const safeTotal = Math.max(0, total | 0);
  const end = Math.min(offset + safeLimit, safeTotal);
  const data = materializePage ? materializePage(offset, end) : [];

  const pagination = {
    total: safeTotal,
    page: safePage,
    limit: safeLimit,
    pages: Math.ceil(safeTotal / safeLimit) || 0
  };
  const responseMetadata = {
    last_updated: metadata.last_updated,
    source: metadata.source
  };

  return search !== undefined
    ? { data, pagination, metadata: responseMetadata, search }
    : { data, pagination, metadata: responseMetadata };
}

export {
  parseListPaging,
  buildPagedResponse
};
