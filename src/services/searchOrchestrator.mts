import {
  searchKeyMatches,
  getSpecialiteByCis,
  getSpecialiteLabelByCis,
  getSpecialiteSearchRecordByCis,
  getRelatedByCis,
  bdpmExtraitUrl,
  HYDRATE_RELATED_LIMIT
} from './dataLoader.mts';
import {
  searchVetKeyMatches,
  getMedicamentByNum,
  getMedicamentLabelByNum,
  getMedicamentSearchRecordByNum,
  getRelatedByNum
} from './vetDataLoader.mts';
import { parseListPaging } from '../utils/corpusPaging.mts';
import {
  isStrongMatchQuality,
  MATCH_QUALITY_RANK,
  MATCH_VIA_RANK,
  type MatchQuality,
  type MatchVia
} from '../utils/searchRanking.mts';
import {
  hasStructuredCriteria,
  scoreStructuredCriteria,
  compareByQualityThenBoost,
  rerankWithStructuredCriteria,
  type CriteriaMatchFlags,
  type SearchCriteria
} from '../utils/structuredSearchCriteria.mts';

interface KeyQualityItem {
  cis?: unknown;
  num?: unknown;
  match_quality: MatchQuality;
  [key: string]: unknown;
}

interface MatchMeta {
  quality: MatchQuality;
  via: MatchVia;
}

interface MatchCollection {
  qualityByKey: Map<string, MatchQuality>;
  metaByKey: Map<string, MatchMeta>;
}

interface SearchHitGroup {
  items: KeyQualityItem[];
  via: MatchVia;
}

interface ResultRef {
  source: 'bdpm' | 'vet';
  key: string;
  match_quality: MatchQuality;
  label: string;
  criteria_boost?: number;
  criteria_match?: CriteriaMatchFlags;
}

interface ScoredResultRef extends ResultRef {
  criteria_boost: number;
  criteria_match: CriteriaMatchFlags;
  _dosageExtra: number | null;
  _index: number;
}

type SourceMode = 'auto' | 'human' | 'veterinary' | 'mixed';

function recordMatchMeta(
  metaByKey: Map<string, MatchMeta>,
  key: string,
  quality: MatchQuality,
  via: MatchVia
): void {
  if (!key) return;
  const candidate: MatchMeta = { quality, via };
  const previous = metaByKey.get(key);
  if (!previous) {
    metaByKey.set(key, candidate);
    return;
  }
  const rankNew = MATCH_QUALITY_RANK[candidate.quality] || 0;
  const rankOld = MATCH_QUALITY_RANK[previous.quality] || 0;
  if (rankNew > rankOld) {
    metaByKey.set(key, candidate);
    return;
  }
  if (rankNew === rankOld && MATCH_VIA_RANK[via] > MATCH_VIA_RANK[previous.via]) {
    metaByKey.set(key, candidate);
  }
}

function attachMatchFields(target: Record<string, unknown>, meta: MatchMeta | undefined): void {
  if (!meta) return;
  target.match_via = meta.via;
}

function normalizeSource(source: unknown): SourceMode {
  const value = String(source || 'auto').toLowerCase();
  if (value === 'auto' || value === 'human' || value === 'veterinary' || value === 'mixed') {
    return value;
  }
  return 'auto';
}

function mergeSearchHits(
  keyField: 'cis' | 'num',
  searches: SearchHitGroup[],
  onExactKey?: (collection: MatchCollection) => void
): MatchCollection {
  const qualityByKey = new Map<string, MatchQuality>();
  const metaByKey = new Map<string, MatchMeta>();

  for (let s = 0; s < searches.length; s++) {
    const { items, via } = searches[s];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const rawKey = keyField === 'cis' ? item.cis : item.num;
      if (rawKey == null || rawKey === '') continue;
      const key = String(rawKey);
      recordMatchMeta(metaByKey, key, item.match_quality, via);
      const previous = qualityByKey.get(key);
      if (!previous || MATCH_QUALITY_RANK[item.match_quality] > MATCH_QUALITY_RANK[previous]) {
        qualityByKey.set(key, item.match_quality);
      }
    }
  }

  const collection: MatchCollection = { qualityByKey, metaByKey };
  if (onExactKey) {
    onExactKey(collection);
  }

  return collection;
}

type HydratedResult = Record<string, unknown> & { match_quality: MatchQuality };

function searchBdpm(q: string): HydratedResult[] {
  const { qualityByKey, metaByKey } = collectBdpmMatches(q);
  const out: HydratedResult[] = [];
  for (const cis of qualityByKey.keys()) {
    out.push(hydrateBdpmResult(cis, qualityByKey, metaByKey));
  }
  return out;
}

function collectBdpmMatches(q: string): MatchCollection {
  return mergeSearchHits(
    'cis',
    [
      { items: searchKeyMatches('specialites', q) as KeyQualityItem[], via: 'denomination' },
      { items: searchKeyMatches('presentations', q) as KeyQualityItem[], via: 'presentation' },
      { items: searchKeyMatches('compositions', q) as KeyQualityItem[], via: 'composition' }
    ],
    ({ qualityByKey, metaByKey }) => {
      const normalizedQuery = String(q).trim();
      if (/^\d+$/.test(normalizedQuery) && qualityByKey.get(normalizedQuery) === 'exact') {
        recordMatchMeta(metaByKey, normalizedQuery, 'exact', 'cis');
      }
    }
  );
}

function resolveBdpmCisKeys(q: unknown, { limit = 100 }: { limit?: number } = {}): string[] {
  const trimmed = String(q || '').trim();
  if (!trimmed) return [];

  const max = Math.max(1, Number(limit) || 100);
  const { qualityByKey } = collectBdpmMatches(trimmed);
  const keys = Array.from(qualityByKey.keys());
  keys.sort((a, b) => {
    const rankA = MATCH_QUALITY_RANK[qualityByKey.get(a) || ''] || 0;
    const rankB = MATCH_QUALITY_RANK[qualityByKey.get(b) || ''] || 0;
    if (rankB !== rankA) return rankB - rankA;
    return a.localeCompare(b);
  });
  return keys.slice(0, max);
}

function hydrateBdpmResult(
  cis: string,
  qualityByKey: Map<string, MatchQuality>,
  metaByKey: Map<string, MatchMeta>
): HydratedResult {
  const result: HydratedResult = {
    type: 'medicament',
    match_quality: qualityByKey.get(cis) || 'fuzzy',
    ...(getSpecialiteByCis(cis) || { cis, url_bdpm: bdpmExtraitUrl(cis) }),
    presentations: getRelatedByCis('presentations', cis, HYDRATE_RELATED_LIMIT),
    compositions: getRelatedByCis('compositions', cis, HYDRATE_RELATED_LIMIT)
  };
  attachMatchFields(result, metaByKey.get(cis));
  return result;
}

function searchVeterinary(q: string): HydratedResult[] {
  const { qualityByKey, metaByKey } = collectVeterinaryMatches(q);
  const out: HydratedResult[] = [];
  for (const num of qualityByKey.keys()) {
    out.push(hydrateVeterinaryResult(num, qualityByKey, metaByKey));
  }
  return out;
}

function collectVeterinaryMatches(q: string): MatchCollection {
  return mergeSearchHits(
    'num',
    [
      { items: searchVetKeyMatches('medicaments', q) as KeyQualityItem[], via: 'denomination' },
      { items: searchVetKeyMatches('compositions', q) as KeyQualityItem[], via: 'composition' }
    ],
    ({ qualityByKey, metaByKey }) => {
      const normalizedQuery = String(q).trim();
      if (/^\d+$/.test(normalizedQuery)) {
        const num = normalizedQuery.padStart(7, '0');
        if (qualityByKey.get(num) === 'exact') {
          recordMatchMeta(metaByKey, num, 'exact', 'num');
        }
      }
    }
  );
}

function hydrateVeterinaryResult(
  num: string,
  qualityByKey: Map<string, MatchQuality>,
  metaByKey: Map<string, MatchMeta>
): HydratedResult {
  const result: HydratedResult = {
    type: 'medicament_veterinaire',
    match_quality: qualityByKey.get(num) || 'fuzzy',
    ...(getMedicamentByNum(num) || { num }),
    presentations: getRelatedByNum('presentations', num),
    compositions: getRelatedByNum('compositions', num)
  };
  attachMatchFields(result, metaByKey.get(num));
  return result;
}

function sortMergedResults<T extends Record<string, unknown>>(results: T[]): T[] {
  return [...results].sort((a, b) => {
    const rankA = MATCH_QUALITY_RANK[String(a.match_quality || '')] || 0;
    const rankB = MATCH_QUALITY_RANK[String(b.match_quality || '')] || 0;
    if (rankB !== rankA) return rankB - rankA;
    const labelA = String(a.denomination || a.nom || '');
    const labelB = String(b.denomination || b.nom || '');
    return labelA.localeCompare(labelB, 'fr');
  });
}

function sortResultRefs(refs: ResultRef[]): ResultRef[] {
  return [...refs].sort((a, b) => {
    const rankA = MATCH_QUALITY_RANK[a.match_quality] || 0;
    const rankB = MATCH_QUALITY_RANK[b.match_quality] || 0;
    if (rankB !== rankA) return rankB - rankA;
    return a.label.localeCompare(b.label, 'fr');
  });
}

function bdpmRefs(matches: MatchCollection): ResultRef[] {
  const refs: ResultRef[] = [];
  for (const [cis, match_quality] of matches.qualityByKey) {
    refs.push({
      source: 'bdpm',
      key: cis,
      match_quality,
      label: String(getSpecialiteLabelByCis(cis) || '')
    });
  }
  return refs;
}

function vetRefs(matches: MatchCollection): ResultRef[] {
  const refs: ResultRef[] = [];
  for (const [num, match_quality] of matches.qualityByKey) {
    refs.push({
      source: 'vet',
      key: num,
      match_quality,
      label: String(getMedicamentLabelByNum(num) || '')
    });
  }
  return refs;
}

function hydrateResultRef(
  ref: ResultRef,
  matchesBySource: { bdpm?: MatchCollection; vet?: MatchCollection }
): Record<string, unknown> {
  let result: Record<string, unknown>;
  if (ref.source === 'bdpm' && matchesBySource.bdpm) {
    const matches = matchesBySource.bdpm;
    result = hydrateBdpmResult(ref.key, matches.qualityByKey, matches.metaByKey);
  } else if (matchesBySource.vet) {
    const matches = matchesBySource.vet;
    result = hydrateVeterinaryResult(ref.key, matches.qualityByKey, matches.metaByKey);
  } else {
    result = {};
  }
  if (ref.criteria_match) result.criteria_match = ref.criteria_match;
  return result;
}

function structuredRecordForRef(ref: ResultRef): Record<string, unknown> | null {
  if (ref.source === 'bdpm') {
    return getSpecialiteSearchRecordByCis(ref.key);
  }
  return getMedicamentSearchRecordByNum(ref.key);
}

function applyCriteriaToRefs(refs: ResultRef[], criteria: SearchCriteria): ResultRef[] {
  if (!hasStructuredCriteria(criteria)) return refs;

  const scored: ScoredResultRef[] = refs.map((ref, index) => {
    const record = structuredRecordForRef(ref);
    const { boost, criteria_match, dosage_extra } = record
      ? scoreStructuredCriteria(record, criteria)
      : { boost: 0, criteria_match: { dosage: false, forme: false, voie: false }, dosage_extra: null };
    return {
      source: ref.source,
      key: ref.key,
      match_quality: ref.match_quality,
      label: ref.label,
      criteria_boost: boost,
      criteria_match,
      _dosageExtra: dosage_extra,
      _index: index
    };
  });

  scored.sort((a, b) => {
    const byQuality = compareByQualityThenBoost(a, b);
    if (byQuality !== 0) return byQuality;
    return a._index - b._index;
  });

  return scored.map(({ _index, _dosageExtra, ...ref }) => ref);
}

function buildSearchMeta({
  q,
  sourceMode,
  queried,
  withResults,
  explicitSource
}: {
  q: string;
  sourceMode: SourceMode;
  queried: string[];
  withResults: string[];
  explicitSource: boolean;
}): Record<string, unknown> {
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

const SEARCH_PLANS: Record<SourceMode, { bdpm: boolean; vet: boolean; merge: 'replace' | 'concat' | 'auto' }> = {
  human:      { bdpm: true,  vet: false, merge: 'replace' },
  veterinary: { bdpm: false, vet: true,  merge: 'replace' },
  mixed:      { bdpm: true,  vet: true,  merge: 'concat' },
  auto:       { bdpm: true,  vet: true,  merge: 'auto' }
};

function executeHybridSearch(q: string, source?: unknown, criteria: SearchCriteria = {}) {
  const sourceMode = normalizeSource(source);
  const explicitSource = source != null && String(source).trim() !== '';
  const plan = SEARCH_PLANS[sourceMode];
  const queried: string[] = [];
  const withResults: string[] = [];

  let bdpmResults: HydratedResult[] = [];
  let vetResults: HydratedResult[] = [];

  if (plan.bdpm) {
    queried.push('bdpm');
    bdpmResults = searchBdpm(q);
    if (bdpmResults.length > 0) withResults.push('bdpm');
  }

  const bdpmStrong =
    bdpmResults.length > 0 && bdpmResults.some((r) => isStrongMatchQuality(String(r.match_quality || '')));
  if (plan.merge === 'auto' && bdpmStrong) {
    return {
      results: rerankWithStructuredCriteria(sortMergedResults(bdpmResults), criteria),
      search: buildSearchMeta({ q, sourceMode, queried, withResults, explicitSource })
    };
  }

  if (plan.vet) {
    queried.push('anmv');
    vetResults = searchVeterinary(q);
    if (vetResults.length > 0) withResults.push('anmv');
  }

  let results: HydratedResult[];
  if (plan.merge === 'concat') {
    results = [...bdpmResults, ...vetResults];
  } else if (plan.merge === 'replace') {
    results = plan.bdpm ? bdpmResults : vetResults;
  } else {
    results = vetResults.length > 0 ? vetResults : bdpmResults;
  }

  return {
    results: rerankWithStructuredCriteria(sortMergedResults(results), criteria),
    search: buildSearchMeta({ q, sourceMode, queried, withResults, explicitSource })
  };
}

function executeHybridSearchPage(
  q: string,
  source?: unknown,
  page: unknown = 1,
  limit: unknown = 50,
  criteria: SearchCriteria = {}
) {
  const sourceMode = normalizeSource(source);
  const explicitSource = source != null && String(source).trim() !== '';
  const plan = SEARCH_PLANS[sourceMode];
  const queried: string[] = [];
  const withResults: string[] = [];
  const matchesBySource: { bdpm?: MatchCollection; vet?: MatchCollection } = {};
  let bdpmRefList: ResultRef[] = [];
  let vetRefList: ResultRef[] = [];

  if (plan.bdpm) {
    queried.push('bdpm');
    matchesBySource.bdpm = collectBdpmMatches(q);
    if (matchesBySource.bdpm.qualityByKey.size > 0) {
      withResults.push('bdpm');
      bdpmRefList = bdpmRefs(matchesBySource.bdpm);
    }
  }

  const bdpmStrong = bdpmRefList.some((ref) => isStrongMatchQuality(ref.match_quality));
  let refs: ResultRef[];
  if (plan.merge === 'auto' && bdpmStrong) {
    refs = sortResultRefs(bdpmRefList);
  } else {
    if (plan.vet) {
      queried.push('anmv');
      matchesBySource.vet = collectVeterinaryMatches(q);
      if (matchesBySource.vet.qualityByKey.size > 0) {
        withResults.push('anmv');
        vetRefList = vetRefs(matchesBySource.vet);
      }
    }

    if (plan.merge === 'concat') {
      refs = sortResultRefs([...bdpmRefList, ...vetRefList]);
    } else if (plan.merge === 'replace') {
      refs = sortResultRefs(plan.bdpm ? bdpmRefList : vetRefList);
    } else {
      refs = sortResultRefs(vetRefList.length > 0 ? vetRefList : bdpmRefList);
    }
  }

  refs = applyCriteriaToRefs(refs, criteria);
  const { safeLimit, offset } = parseListPaging(page, limit);
  const pageRefs = refs.slice(offset, offset + safeLimit);
  return {
    total: refs.length,
    results: pageRefs.map((ref) => hydrateResultRef(ref, matchesBySource)),
    search: buildSearchMeta({ q, sourceMode, queried, withResults, explicitSource })
  };
}

export {
  executeHybridSearch,
  executeHybridSearchPage,
  resolveBdpmCisKeys,
  collectBdpmMatches
};
