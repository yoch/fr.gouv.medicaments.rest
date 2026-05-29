'use strict';

const { getRowValue, toObject } = require('./rowStore');
const { computeMatchPriority, matchQualityFromPriority } = require('./searchRanking');

/**
 * Classe les hits MiniSearch sur le corpus tuple, matérialise uniquement les lignes retournées.
 * @param {Function} [mapRow] - (obj, rowIndex, match_quality) => réponse API
 */
function rankAndMaterializeSearch(store, searchResults, query, { primaryIdx, idIdx = -1 }, mapRow) {
  const ranked = new Array(searchResults.length);
  for (let i = 0; i < searchResults.length; i++) {
    const res = searchResults[i];
    const primaryValue = getRowValue(store, res.id, primaryIdx);
    const idValue = idIdx >= 0 ? getRowValue(store, res.id, idIdx) : '';
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

  const materialize = mapRow
    ? (r) => mapRow(toObject(store, r.rowIndex), r.rowIndex, r.match_quality)
    : (r) => Object.assign({}, toObject(store, r.rowIndex), { match_quality: r.match_quality });

  const out = new Array(ranked.length);
  for (let i = 0; i < ranked.length; i++) {
    out[i] = materialize(ranked[i]);
  }
  return out;
}

module.exports = {
  rankAndMaterializeSearch
};
