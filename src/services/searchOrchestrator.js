const {
  search,
  searchKeyMatches,
  getSpecialiteByCis,
  getSpecialiteLabelByCis,
  getRelatedByCis,
  bdpmExtraitUrl,
  HYDRATE_RELATED_LIMIT
} = require('./dataLoader');
const {
  searchVet,
  searchVetKeyMatches,
  getMedicamentByNum,
  getMedicamentLabelByNum,
  getRelatedByNum
} = require('./vetDataLoader');
const { parseListPaging } = require('../utils/corpusPaging');
const {
  isStrongMatchQuality,
  MATCH_QUALITY_RANK,
  MATCH_VIA_RANK
} = require('../utils/searchRanking');
const {
  hasStructuredCriteria,
  scoreStructuredCriteria,
  compareByQualityThenBoost,
  rerankWithStructuredCriteria
} = require('../utils/structuredSearchCriteria');

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

function collectBdpmMatches(q) {
  return mergeSearchHits({
    keyField: 'cis',
    searches: [
      { items: searchKeyMatches('specialites', q), via: 'denomination' },
      { items: searchKeyMatches('presentations', q), via: 'presentation' },
      { items: searchKeyMatches('compositions', q), via: 'composition' }
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
}

function hydrateBdpmResult(cis, qualityByKey, metaByKey) {
  const result = {
    type: 'medicament',
    match_quality: qualityByKey[cis],
    ...(getSpecialiteByCis(cis) || { cis, url_bdpm: bdpmExtraitUrl(cis) }),
    presentations: getRelatedByCis('presentations', cis, HYDRATE_RELATED_LIMIT),
    compositions: getRelatedByCis('compositions', cis, HYDRATE_RELATED_LIMIT)
  };
  attachMatchFields(result, metaByKey[cis]);
  return result;
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

function collectVeterinaryMatches(q) {
  return mergeSearchHits({
    keyField: 'num',
    searches: [
      { items: searchVetKeyMatches('medicaments', q), via: 'denomination' },
      { items: searchVetKeyMatches('compositions', q), via: 'composition' }
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
}

function hydrateVeterinaryResult(num, qualityByKey, metaByKey) {
  const result = {
    type: 'medicament_veterinaire',
    match_quality: qualityByKey[num],
    ...(getMedicamentByNum(num) || { num }),
    presentations: getRelatedByNum('presentations', num),
    compositions: getRelatedByNum('compositions', num)
  };
  attachMatchFields(result, metaByKey[num]);
  return result;
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

function sortResultRefs(refs) {
  return [...refs].sort((a, b) => {
    const rankA = MATCH_QUALITY_RANK[a.match_quality] || 0;
    const rankB = MATCH_QUALITY_RANK[b.match_quality] || 0;
    if (rankB !== rankA) return rankB - rankA;
    return a.label.localeCompare(b.label, 'fr');
  });
}

function bdpmRefs(matches) {
  return Object.keys(matches.qualityByKey).map((cis) => ({
    source: 'bdpm',
    key: cis,
    match_quality: matches.qualityByKey[cis],
    label: getSpecialiteLabelByCis(cis)
  }));
}

function vetRefs(matches) {
  return Object.keys(matches.qualityByKey).map((num) => ({
    source: 'vet',
    key: num,
    match_quality: matches.qualityByKey[num],
    label: getMedicamentLabelByNum(num)
  }));
}

function hydrateResultRef(ref, matchesBySource) {
  let result;
  if (ref.source === 'bdpm') {
    const matches = matchesBySource.bdpm;
    result = hydrateBdpmResult(ref.key, matches.qualityByKey, matches.metaByKey);
  } else {
    const matches = matchesBySource.vet;
    result = hydrateVeterinaryResult(ref.key, matches.qualityByKey, matches.metaByKey);
  }
  if (ref.criteria_match) result.criteria_match = ref.criteria_match;
  return result;
}

/**
 * Construit un enregistrement minimal (dénomination / forme / voie) pour scorer
 * une réf sans hydrater ses relations. Le dosage est évalué sur la dénomination.
 */
function structuredRecordForRef(ref) {
  if (ref.source === 'bdpm') {
    const spec = getSpecialiteByCis(ref.key);
    if (!spec) return null;
    return {
      denomination: spec.denomination,
      forme_pharma: spec.forme_pharma,
      voies_admin: spec.voies_admin
    };
  }
  const med = getMedicamentByNum(ref.key);
  if (!med) return null;
  return {
    denomination: med.nom,
    forme_pharma: med.forme_pharmaceutique,
    voies_admin: ''
  };
}

/**
 * Réordonnancement non destructif des réfs selon dosage/forme/voie.
 * Tier-first : le boost ne réordonne qu'à l'intérieur d'un même `match_quality`,
 * donc aucun résultat sans rapport ne remonte au-dessus d'un match plus fort.
 */
function applyCriteriaToRefs(refs, criteria) {
  if (!hasStructuredCriteria(criteria)) return refs;

  const scored = refs.map((ref, index) => {
    const record = structuredRecordForRef(ref);
    const { boost, criteria_match } = record
      ? scoreStructuredCriteria(record, criteria)
      : { boost: 0, criteria_match: { dosage: false, forme: false, voie: false } };
    return { ...ref, criteria_boost: boost, criteria_match, _index: index };
  });

  scored.sort((a, b) => {
    const byQuality = compareByQualityThenBoost(a, b);
    if (byQuality !== 0) return byQuality;
    return a._index - b._index;
  });

  return scored.map(({ _index, ...ref }) => ref);
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
 *   - 'auto'     : bdpm prioritaire si match fort, sinon vet, puis bdpm faible si vet vide
 */
const SEARCH_PLANS = {
  human:     { bdpm: true,  vet: false, merge: 'replace' },
  veterinary:{ bdpm: false, vet: true,  merge: 'replace' },
  mixed:     { bdpm: true,  vet: true,  merge: 'concat' },
  auto:      { bdpm: true,  vet: true,  merge: 'auto' }
};

function executeHybridSearch(q, source, criteria = {}) {
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
      results: rerankWithStructuredCriteria(bdpmResults, criteria),
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
    // auto : match fort BDPM déjà sorti ; sinon vet si dispo, sinon conserver BDPM faible
    results = vetResults.length > 0 ? vetResults : bdpmResults;
  }

  return {
    results: rerankWithStructuredCriteria(results, criteria),
    search: buildSearchMeta({ q, sourceMode, queried, withResults, explicitSource })
  };
}

function executeHybridSearchPage(q, source, page = 1, limit = 50, criteria = {}) {
  const sourceMode = normalizeSource(source);
  const explicitSource = source != null && String(source).trim() !== '';
  const plan = SEARCH_PLANS[sourceMode];
  const queried = [];
  const withResults = [];
  const matchesBySource = {};

  let refs = [];

  if (plan.bdpm) {
    queried.push('bdpm');
    matchesBySource.bdpm = collectBdpmMatches(q);
    refs = bdpmRefs(matchesBySource.bdpm);
    if (refs.length > 0) withResults.push('bdpm');
  }

  const bdpmStrong =
    refs.length > 0 && refs.some((r) => isStrongMatchQuality(r.match_quality));
  if (plan.merge === 'auto' && bdpmStrong) {
    const finalRefs = applyCriteriaToRefs(refs, criteria);
    const { offset, safeLimit } = parseListPaging(page, limit);
    const pageRefs = finalRefs.slice(offset, offset + safeLimit);
    return {
      total: finalRefs.length,
      results: pageRefs.map((ref) => hydrateResultRef(ref, matchesBySource)),
      search: buildSearchMeta({ q, sourceMode, queried, withResults, explicitSource })
    };
  }

  let vetResultRefs = [];
  if (plan.vet) {
    queried.push('anmv');
    matchesBySource.vet = collectVeterinaryMatches(q);
    vetResultRefs = vetRefs(matchesBySource.vet);
    if (vetResultRefs.length > 0) withResults.push('anmv');
  }

  if (plan.merge === 'concat') {
    refs = sortResultRefs([...refs, ...vetResultRefs]);
  } else if (plan.merge === 'replace') {
    refs = plan.bdpm ? refs : vetResultRefs;
  } else {
    refs = vetResultRefs.length > 0 ? vetResultRefs : refs;
  }

  const finalRefs = applyCriteriaToRefs(refs, criteria);
  const { offset, safeLimit } = parseListPaging(page, limit);
  const pageRefs = finalRefs.slice(offset, offset + safeLimit);
  return {
    total: finalRefs.length,
    results: pageRefs.map((ref) => hydrateResultRef(ref, matchesBySource)),
    search: buildSearchMeta({ q, sourceMode, queried, withResults, explicitSource })
  };
}

module.exports = {
  executeHybridSearch,
  executeHybridSearchPage
};
