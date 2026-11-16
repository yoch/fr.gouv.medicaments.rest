const MAX_LIST_LIMIT = 1000;

export interface ListPaging {
  safePage: number;
  safeLimit: number;
  offset: number;
}

export interface PagedResponseInput<T = unknown> {
  total: number;
  page?: unknown;
  limit?: unknown;
  metadata: { last_updated: unknown; source: unknown };
  materializePage?: (offset: number, end: number) => T[];
}

export interface PagedResponse<T = unknown> {
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
  search?: Record<string, unknown>;
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
function buildPagedResponse<T = unknown>({
  total,
  page,
  limit,
  metadata,
  materializePage
}: PagedResponseInput<T>): PagedResponse<T> {
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

export {
  parseListPaging,
  buildPagedResponse
};
