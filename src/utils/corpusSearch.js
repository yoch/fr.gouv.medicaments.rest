'use strict';

const { computeMatchPriority, matchQualityFromPriority } = require('./searchRanking');

/**
 * Classe les hits MiniSearch, matérialise via toJSON() (getters inclus).
 * @param {object[]} corpus
 * @param {Function} [mapRow] - (instance, rowIndex, match_quality) => réponse API
 */
function rankSearchResults(corpus, searchResults, query, { primaryField, idField = null }) {
  const ranked = new Array(searchResults.length);
  for (let i = 0; i < searchResults.length; i++) {
    const res = searchResults[i];
    const row = corpus[res.id];
    const primaryValue = row[primaryField] != null && row[primaryField] !== '' ? row[primaryField] : '';
    const idValue =
      idField && row[idField] != null && row[idField] !== '' ? row[idField] : '';
    const priority = computeMatchPriority(primaryValue, query, { idValue });

    ranked[i] = {
      rowIndex: res.id,
      score: res.score,
      priority,
      match_quality: matchQualityFromPriority(priority)
    };
  }

  ranked.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.score - a.score;
  });

  return ranked;
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
  { primaryField, idField = null },
  mapRow = null
) {
  const ranked = rankSearchResults(corpus, searchResults, query, { primaryField, idField });
  return materializeRankedSearchRange(corpus, ranked, 0, ranked.length, mapRow);
}

module.exports = {
  rankSearchResults,
  materializeRankedSearchRange,
  rankAndMaterializeSearch
};
