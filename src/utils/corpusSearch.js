'use strict';

const { createMatchPriorityClassifier, matchQualityFromPriority } = require('./searchRanking');
const { parseListPaging } = require('./corpusPaging');

// One query per immutable index: bounded memory and automatic invalidation
// when a loader replaces its FrozenMiniSearch instance on reload.
const pageSearchCache = new WeakMap();

function collectCodeValues(row, codeFields) {
  if (!codeFields || codeFields.length === 0) return [];
  const values = [];
  for (const field of codeFields) {
    const value = row[field];
    if (value != null && value !== '') values.push(value);
  }
  return values;
}

function rankSearchHit(corpus, res, matchPriority, { primaryField, idField = null, codeFields = null }) {
  const row = corpus[res.id];
  const primaryValue = row[primaryField] != null && row[primaryField] !== '' ? row[primaryField] : '';
  const idValue =
    idField && row[idField] != null && row[idField] !== '' ? row[idField] : '';
  const priority = matchPriority(primaryValue, {
    idValue,
    codeValues: collectCodeValues(row, codeFields)
  });

  return {
    rowIndex: res.id,
    score: res.score,
    priority,
    match_quality: matchQualityFromPriority(priority)
  };
}

function compareRankedHits(a, b) {
  return b.priority - a.priority || b.score - a.score;
}

function rankSearchResults(corpus, searchResults, query, spec) {
  const matchPriority = createMatchPriorityClassifier(query);
  const ranked = searchResults.map((res) => rankSearchHit(corpus, res, matchPriority, spec));
  ranked.sort(compareRankedHits);

  return ranked;
}

/**
 * Preserve exact totals and quality-before-score ranking. The first request
 * computes all matches; repeated pages reuse only counts and quality-by-id,
 * selecting a score prefix with limit when the page lies within one tier.
 */
function searchRankedPage(corpus, index, query, spec, page, limit) {
  if (!corpus || !index || !query) return { total: 0, ranked: [] };
  const { offset, safeLimit } = parseListPaging(page, limit);
  const end = offset + safeLimit;
  const cached = pageSearchCache.get(index);
  const sameQuery = cached && cached.query === query && cached.corpus === corpus && cached.spec === spec;

  if (sameQuery) {
    if (offset >= cached.total) return { total: cached.total, ranked: [] };
    let tierStart = 0;
    for (let priority = 2; priority >= 0; priority--) {
      const tierEnd = tierStart + cached.counts[priority];
      if (offset >= tierStart && Math.min(end, cached.total) <= tierEnd) {
        const hits = index.search(query, {
          limit: Math.min(end, cached.total) - tierStart,
          filter: (hit) => cached.priorities[hit.id] === priority
        });
        const ranked = hits.slice(offset - tierStart).map((hit) => ({
          rowIndex: hit.id,
          score: hit.score,
          priority,
          match_quality: matchQualityFromPriority(priority)
        }));
        return { total: cached.total, ranked };
      }
      tierStart = tierEnd;
    }
    // A page spanning tiers needs the complete quality-before-score ordering.
  }

  const ranked = rankSearchResults(corpus, index.search(query), query, spec);
  if (!sameQuery) {
    const priorities = new Uint8Array(corpus.length);
    const counts = [0, 0, 0];
    for (const hit of ranked) {
      priorities[hit.rowIndex] = hit.priority;
      counts[hit.priority]++;
    }
    pageSearchCache.set(index, { query, corpus, spec, total: ranked.length, priorities, counts });
  }
  return { total: ranked.length, ranked: ranked.slice(offset, end) };
}

function materializeRankedSearchRange(corpus, ranked, start, end, mapRow = null) {
  const out = new Array(Math.max(0, end - start));
  let j = 0;
  for (let i = start; i < end; i++) {
    const r = ranked[i];
    if (mapRow) {
      out[j++] = mapRow(corpus[r.rowIndex], r.rowIndex, r.match_quality);
    } else {
      out[j++] = { ...corpus[r.rowIndex].toJSON(), match_quality: r.match_quality };
    }
  }
  return out;
}

/**
 * Classe les hits MiniSearch, matérialise via toJSON() (getters inclus).
 * @param {object[]} corpus
 * @param {Function} [mapRow] - (instance, rowIndex, match_quality) => réponse API
 */
function rankAndMaterializeSearch(
  corpus,
  searchResults,
  query,
  { primaryField, idField = null, codeFields = null },
  mapRow = null
) {
  const ranked = rankSearchResults(corpus, searchResults, query, { primaryField, idField, codeFields });
  return materializeRankedSearchRange(corpus, ranked, 0, ranked.length, mapRow);
}

module.exports = {
  rankSearchResults,
  searchRankedPage,
  materializeRankedSearchRange,
  rankAndMaterializeSearch
};
