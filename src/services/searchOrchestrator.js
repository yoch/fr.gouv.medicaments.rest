const {
  search,
  getSpecialiteByCis,
  getRelatedByCis,
  bdpmExtraitUrl,
  HYDRATE_RELATED_LIMIT
} = require('./dataLoader');
const {
  searchVet,
  getMedicamentByNum,
  getRelatedByNum
} = require('./vetDataLoader');
const {
  isStrongMatchQuality,
  MATCH_QUALITY_RANK,
  MATCH_VIA_RANK
} = require('../utils/searchRanking');

function recordMatchMeta(metaByKey, key, item, via) {
  if (!key) return;
  const candidate = { quality: item.match_quality, via };
  const previous = metaByKey[key];
  if (!previous) {
    metaByKey[key] = candidate;
    return;
  }
  const rankNew = MATCH_QUALITY_RANK[candidate.quality] || 0;
  const rankOld = MATCH_QUALITY_RANK[previous.quality] || 0;
  if (rankNew > rankOld) {
    metaByKey[key] = candidate;
    return;
  }
  if (rankNew === rankOld && MATCH_VIA_RANK[via] > MATCH_VIA_RANK[previous.via]) {
    metaByKey[key] = candidate;
  }
}

function attachMatchFields(target, meta) {
  if (!meta) return;
  target.match_via = meta.via;
}

function normalizeSource(source) {
  const value = (source || 'auto').toLowerCase();
  if (['auto', 'human', 'veterinary', 'mixed'].includes(value)) return value;
  return 'auto';
}

/**
 * Fusionne plusieurs listes de hits de recherche par clé (cis / num).
 *
 * - `keyField` : champ d'identifiant sur lequel dédoublonner
 * - `searches` : liste de `{ items, via }` (ex. spécialités via `denomination`)
 * - `onExactKey` : callback optionnel pour marquer un match exact sur l'identifiant
 *   quand la requête est numérique (cis/num)
 *
 * Retourne `{ qualityByKey, metaByKey }` — l'appelant matérialise les résultats.
 */
function mergeSearchHits({ keyField, searches, onExactKey }) {
  const qualityByKey = {};
  const metaByKey = {};

  for (const { items, via } of searches) {
    for (const item of items) {
      const key = item[keyField];
      recordMatchMeta(metaByKey, key, item, via);
      const previous = qualityByKey[key];
      if (!previous || MATCH_QUALITY_RANK[item.match_quality] > MATCH_QUALITY_RANK[previous]) {
        qualityByKey[key] = item.match_quality;
      }
    }
  }

  if (onExactKey) {
    onExactKey({ qualityByKey, metaByKey, recordMatchMeta });
  }

  return { qualityByKey, metaByKey };
}

function searchBdpm(q) {
  const { qualityByKey, metaByKey } = mergeSearchHits({
    keyField: 'cis',
    searches: [
      { items: search('specialites', q), via: 'denomination' },
      { items: search('presentations', q), via: 'presentation' },
      { items: search('compositions', q), via: 'composition' }
    ],
    onExactKey: ({ qualityByKey, metaByKey, recordMatchMeta }) => {
      const normalizedQuery = String(q).trim();
      if (/^\d+$/.test(normalizedQuery) && qualityByKey[normalizedQuery] === 'exact') {
        recordMatchMeta(metaByKey, normalizedQuery, {
          cis: normalizedQuery,
          match_quality: 'exact'
        }, 'cis');
      }
    }
  });

  return Object.keys(qualityByKey).map((cis) => {
    const result = {
      type: 'medicament',
      match_quality: qualityByKey[cis],
      ...(getSpecialiteByCis(cis) || { cis, url_bdpm: bdpmExtraitUrl(cis) }),
      presentations: getRelatedByCis('presentations', cis, HYDRATE_RELATED_LIMIT),
      compositions: getRelatedByCis('compositions', cis, HYDRATE_RELATED_LIMIT)
    };
    attachMatchFields(result, metaByKey[cis]);
    return result;
  });
}

function searchVeterinary(q) {
  const { qualityByKey, metaByKey } = mergeSearchHits({
    keyField: 'num',
    searches: [
      { items: searchVet('medicaments', q), via: 'denomination' },
      { items: searchVet('compositions', q), via: 'composition' }
    ],
    onExactKey: ({ qualityByKey, metaByKey, recordMatchMeta }) => {
      const normalizedQuery = String(q).trim();
      if (/^\d+$/.test(normalizedQuery)) {
        const num = normalizedQuery.padStart(7, '0');
        if (qualityByKey[num] === 'exact') {
          recordMatchMeta(metaByKey, num, { num, match_quality: 'exact' }, 'num');
        }
      }
    }
  });

  return Object.keys(qualityByKey).map((num) => {
    const result = {
      type: 'medicament_veterinaire',
      match_quality: qualityByKey[num],
      ...(getMedicamentByNum(num) || { num }),
      presentations: getRelatedByNum('presentations', num),
      compositions: getRelatedByNum('compositions', num)
    };
    attachMatchFields(result, metaByKey[num]);
    return result;
  });
}

function sortMergedResults(results) {
  return [...results].sort((a, b) => {
    const rankA = MATCH_QUALITY_RANK[a.match_quality] || 0;
    const rankB = MATCH_QUALITY_RANK[b.match_quality] || 0;
    if (rankB !== rankA) return rankB - rankA;
    const labelA = a.denomination || a.nom || '';
    const labelB = b.denomination || b.nom || '';
    return labelA.localeCompare(labelB, 'fr');
  });
}

function buildSearchMeta({ q, sourceMode, queried, withResults, explicitSource }) {
  if (!explicitSource && sourceMode === 'auto' && withResults.length === 1 && withResults[0] === 'bdpm') {
    return { query: q };
  }

  return {
    query: q,
    source: sourceMode,
    referentiels: {
      queried,
      with_results: withResults
    }
  };
}

/**
 * Plans de recherche par `source` — supprime les branches conditionnelles
 * redondantes dans `executeHybridSearch`. `merge`:
 *   - 'replace'  : un seul référentiel retenu (human ou veterinary)
 *   - 'concat'   : union triée (mixed)
 *   - 'auto'     : bdpm prioritaire si match fort, sinon vet
 */
const SEARCH_PLANS = {
  human:     { bdpm: true,  vet: false, merge: 'replace' },
  veterinary:{ bdpm: false, vet: true,  merge: 'replace' },
  mixed:     { bdpm: true,  vet: true,  merge: 'concat' },
  auto:      { bdpm: true,  vet: true,  merge: 'auto' }
};

function executeHybridSearch(q, source) {
  const sourceMode = normalizeSource(source);
  const explicitSource = source != null && String(source).trim() !== '';
  const plan = SEARCH_PLANS[sourceMode];
  const queried = [];
  const withResults = [];

  let bdpmResults = [];
  let vetResults = [];

  if (plan.bdpm) {
    queried.push('bdpm');
    bdpmResults = searchBdpm(q);
    if (bdpmResults.length > 0) withResults.push('bdpm');
  }

  // auto : early-exit si bdpm a un match fort (ne query pas vet)
  const bdpmStrong =
    bdpmResults.length > 0 && bdpmResults.some((r) => isStrongMatchQuality(r.match_quality));
  if (plan.merge === 'auto' && bdpmStrong) {
    return {
      results: bdpmResults,
      search: buildSearchMeta({ q, sourceMode, queried, withResults, explicitSource })
    };
  }

  if (plan.vet) {
    queried.push('anmv');
    vetResults = searchVeterinary(q);
    if (vetResults.length > 0) withResults.push('anmv');
  }

  let results;
  if (plan.merge === 'concat') {
    results = sortMergedResults([...bdpmResults, ...vetResults]);
  } else if (plan.merge === 'replace') {
    results = plan.bdpm ? bdpmResults : vetResults;
  } else {
    results = vetResults;
  }

  return {
    results,
    search: buildSearchMeta({ q, sourceMode, queried, withResults, explicitSource })
  };
}

module.exports = {
  executeHybridSearch
};
