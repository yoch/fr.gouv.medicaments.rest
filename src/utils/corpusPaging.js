'use strict';

const MAX_LIST_LIMIT = 1000;

function parseListPaging(page, limit, maxLimit = MAX_LIST_LIMIT) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(maxLimit, Math.max(1, parseInt(limit, 10) || 100));
  const offset = (safePage - 1) * safeLimit;
  return { safePage, safeLimit, offset };
}

module.exports = {
  MAX_LIST_LIMIT,
  parseListPaging
};
