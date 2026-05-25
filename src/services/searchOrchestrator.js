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

const MATCH_QUALITY_RANK = { exact: 3, prefix: 2, fuzzy: 1 };

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
  for (const item of [...specialites, ...presentations, ...compositions]) {
    const previous = matchQualityByCis[item.cis];
    if (!previous || MATCH_QUALITY_RANK[item.match_quality] > MATCH_QUALITY_RANK[previous]) {
      matchQualityByCis[item.cis] = item.match_quality;
    }
  }

  const matchedCis = new Set(Object.keys(matchQualityByCis));

  return Array.from(matchedCis).map((cis) => ({
    type: 'medicament',
    match_quality: matchQualityByCis[cis],
    ...(getSpecialiteByCis(cis) || { cis, url_bdpm: bdpmExtraitUrl(cis) }),
    presentations: getRelatedByCis('presentations', cis, HYDRATE_RELATED_LIMIT),
    compositions: getRelatedByCis('compositions', cis, HYDRATE_RELATED_LIMIT)
  }));
}

function searchVeterinary(q) {
  const medicaments = searchVet('medicaments', q);
  const compositions = searchVet('compositions', q);

  const matchQualityByNum = {};
  for (const item of [...medicaments, ...compositions]) {
    const previous = matchQualityByNum[item.num];
    if (!previous || MATCH_QUALITY_RANK[item.match_quality] > MATCH_QUALITY_RANK[previous]) {
      matchQualityByNum[item.num] = item.match_quality;
    }
  }

  const matchedNums = new Set(Object.keys(matchQualityByNum));

  return Array.from(matchedNums).map((num) => ({
    type: 'medicament_veterinaire',
    match_quality: matchQualityByNum[num],
    ...(getMedicamentByNum(num) || { num }),
    presentations: getRelatedByNum('presentations', num),
    compositions: getRelatedByNum('compositions', num)
  }));
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
      if (bdpmResults.length > 0) {
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
