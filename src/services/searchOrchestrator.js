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
const { isStrongMatchQuality } = require('../utils/searchRanking');

const MATCH_QUALITY_RANK = { exact: 3, prefix: 2, fuzzy: 1 };
const MATCH_VIA_RANK = { cis: 4, num: 4, denomination: 3, presentation: 2, composition: 1 };

function recordMatchMeta(metaByKey, key, item, via) {
  if (!key) return;
  const quality = item.match_quality;
  const candidate = {
    quality,
    via
  };
  const previous = metaByKey[key];
  if (!previous) {
    metaByKey[key] = candidate;
    return;
  }
  const rankNew = MATCH_QUALITY_RANK[quality] || 0;
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

function searchBdpm(q) {
  const specialites = search('specialites', q);
  const presentations = search('presentations', q);
  const compositions = search('compositions', q);

  const matchQualityByCis = {};
  const matchMetaByCis = {};

  for (const item of specialites) {
    recordMatchMeta(matchMetaByCis, item.cis, item, 'denomination');
    const previous = matchQualityByCis[item.cis];
    if (!previous || MATCH_QUALITY_RANK[item.match_quality] > MATCH_QUALITY_RANK[previous]) {
      matchQualityByCis[item.cis] = item.match_quality;
    }
  }
  for (const item of presentations) {
    recordMatchMeta(matchMetaByCis, item.cis, item, 'presentation');
    const previous = matchQualityByCis[item.cis];
    if (!previous || MATCH_QUALITY_RANK[item.match_quality] > MATCH_QUALITY_RANK[previous]) {
      matchQualityByCis[item.cis] = item.match_quality;
    }
  }
  for (const item of compositions) {
    recordMatchMeta(matchMetaByCis, item.cis, item, 'composition');
    const previous = matchQualityByCis[item.cis];
    if (!previous || MATCH_QUALITY_RANK[item.match_quality] > MATCH_QUALITY_RANK[previous]) {
      matchQualityByCis[item.cis] = item.match_quality;
    }
  }

  // CIS recherché numériquement : marquer via cis si match exact sur l'identifiant
  const normalizedQuery = String(q).trim();
  if (/^\d+$/.test(normalizedQuery) && matchQualityByCis[normalizedQuery] === 'exact') {
    recordMatchMeta(matchMetaByCis, normalizedQuery, {
      cis: normalizedQuery,
      match_quality: 'exact'
    }, 'cis');
  }

  const matchedCis = new Set(Object.keys(matchQualityByCis));

  return Array.from(matchedCis).map((cis) => {
    const result = {
      type: 'medicament',
      match_quality: matchQualityByCis[cis],
      ...(getSpecialiteByCis(cis) || { cis, url_bdpm: bdpmExtraitUrl(cis) }),
      presentations: getRelatedByCis('presentations', cis, HYDRATE_RELATED_LIMIT),
      compositions: getRelatedByCis('compositions', cis, HYDRATE_RELATED_LIMIT)
    };
    attachMatchFields(result, matchMetaByCis[cis]);
    return result;
  });
}

function searchVeterinary(q) {
  const medicaments = searchVet('medicaments', q);
  const compositions = searchVet('compositions', q);

  const matchQualityByNum = {};
  const matchMetaByNum = {};

  for (const item of medicaments) {
    recordMatchMeta(matchMetaByNum, item.num, item, 'denomination');
    const previous = matchQualityByNum[item.num];
    if (!previous || MATCH_QUALITY_RANK[item.match_quality] > MATCH_QUALITY_RANK[previous]) {
      matchQualityByNum[item.num] = item.match_quality;
    }
  }
  for (const item of compositions) {
    recordMatchMeta(matchMetaByNum, item.num, item, 'composition');
    const previous = matchQualityByNum[item.num];
    if (!previous || MATCH_QUALITY_RANK[item.match_quality] > MATCH_QUALITY_RANK[previous]) {
      matchQualityByNum[item.num] = item.match_quality;
    }
  }

  const normalizedQuery = String(q).trim();
  if (/^\d+$/.test(normalizedQuery)) {
    const num = normalizedQuery.padStart(7, '0');
    if (matchQualityByNum[num] === 'exact') {
      recordMatchMeta(matchMetaByNum, num, { num, match_quality: 'exact' }, 'num');
    }
  }

  const matchedNums = new Set(Object.keys(matchQualityByNum));

  return Array.from(matchedNums).map((num) => {
    const result = {
      type: 'medicament_veterinaire',
      match_quality: matchQualityByNum[num],
      ...(getMedicamentByNum(num) || { num }),
      presentations: getRelatedByNum('presentations', num),
      compositions: getRelatedByNum('compositions', num)
    };
    attachMatchFields(result, matchMetaByNum[num]);
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

function executeHybridSearch(q, source) {
  const sourceMode = normalizeSource(source);
  const explicitSource = source != null && String(source).trim() !== '';
  const queried = [];
  const withResults = [];
  let results = [];

  if (sourceMode === 'human' || sourceMode === 'auto' || sourceMode === 'mixed') {
    queried.push('bdpm');
    const bdpmResults = searchBdpm(q);
    if (bdpmResults.length > 0) {
      withResults.push('bdpm');
    }

    if (sourceMode === 'auto') {
      const bdpmStrong = bdpmResults.some((r) => isStrongMatchQuality(r.match_quality));
      if (bdpmResults.length > 0 && bdpmStrong) {
        return {
          results: bdpmResults,
          search: buildSearchMeta({
            q,
            sourceMode,
            queried,
            withResults,
            explicitSource
          })
        };
      }
    } else {
      results = results.concat(bdpmResults);
    }
  }

  if (sourceMode === 'veterinary' || sourceMode === 'auto' || sourceMode === 'mixed') {
    if (!queried.includes('anmv')) queried.push('anmv');
    const vetResults = searchVeterinary(q);
    if (vetResults.length > 0) {
      withResults.push('anmv');
    }

    if (sourceMode === 'veterinary') {
      results = vetResults;
    } else if (sourceMode === 'auto') {
      results = vetResults;
    } else {
      results = results.concat(vetResults);
    }
  }

  if (sourceMode === 'mixed') {
    results = sortMergedResults(results);
  }

  return {
    results,
    search: buildSearchMeta({
      q,
      sourceMode,
      queried,
      withResults,
      explicitSource
    })
  };
}

module.exports = {
  executeHybridSearch,
  searchBdpm,
  searchVeterinary
};
