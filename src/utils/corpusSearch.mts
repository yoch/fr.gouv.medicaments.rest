import {
  createMatchPriorityClassifier,
  matchQualityFromPriority,
  type MatchPriority,
  type MatchPriorityClassifier,
  type MatchQuality
} from './searchRanking.mts';
import { parseListPaging } from './corpusPaging.mts';

export interface SearchSpec {
  primaryField: string;
  idField?: string | null;
  codeFields?: string[] | null;
}

export interface MiniSearchHit {
  id: number;
  score: number;
}

export interface SearchIndexLike {
  search(query: string, options?: Record<string, unknown>): MiniSearchHit[];
  matchIds(query: string): ArrayLike<any>;
}

export interface RankedHit {
  rowIndex: number;
  score: number;
  priority: MatchPriority;
  match_quality: MatchQuality;
}

export type KeyQualityItem = Record<string, unknown> & {
  match_quality: MatchQuality;
};

interface CachedPageSearch {
  query: string;
  corpus: Array<Record<string, unknown>>;
  spec: SearchSpec;
  total: number;
  priorities: Uint8Array;
  counts: [number, number, number];
}

// Une seule requête par index immuable : mémoire bornée, et invalidation
// automatique quand un loader remplace son instance FrozenMiniSearch au rechargement.
const pageSearchCache = new WeakMap<SearchIndexLike, CachedPageSearch>();

function collectCodeValues(row: Record<string, unknown>, codeFields?: string[] | null): Array<string | number> {
  if (!codeFields || codeFields.length === 0) return [];
  const values: Array<string | number> = [];
  for (let i = 0; i < codeFields.length; i++) {
    const value = row[codeFields[i]];
    if (value != null && value !== '') values.push(value as string | number);
  }
  return values;
}

/** Correspondances triées par score ; l'application ne lit ni `terms` ni `match`. */
function scoredSearch(index: SearchIndexLike, query: string, options?: Record<string, unknown>): MiniSearchHit[] {
  if (!options) return index.search(query, { matchInfo: false });
  const searchOpts = Object.assign({}, options);
  searchOpts.matchInfo = false;
  return index.search(query, searchOpts);
}

function classifyRow(
  row: Record<string, unknown>,
  matchPriority: MatchPriorityClassifier,
  spec: SearchSpec
): MatchPriority {
  const primaryField = spec.primaryField;
  const idField = spec.idField;
  const codeFields = spec.codeFields;
  const primaryValue = row[primaryField] != null && row[primaryField] !== '' ? row[primaryField] : '';
  const idValue = idField && row[idField] != null && row[idField] !== '' ? row[idField] : '';
  return matchPriority(primaryValue, idValue, collectCodeValues(row, codeFields));
}

function rankSearchHit(
  corpus: Array<Record<string, unknown>>,
  res: MiniSearchHit,
  matchPriority: MatchPriorityClassifier,
  spec: SearchSpec
): RankedHit {
  const priority = classifyRow(corpus[res.id], matchPriority, spec);
  return {
    rowIndex: res.id,
    score: res.score,
    priority,
    match_quality: matchQualityFromPriority(priority)
  };
}

/**
 * Identifiant (`spec.idField`) et qualité de chaque correspondance, dans l'ordre
 * du corpus et sans score : pour les fusions par clé qui ordonnent elles-mêmes.
 */
function searchKeyQualities(
  corpus: Array<Record<string, unknown>>,
  index: SearchIndexLike,
  query: string,
  spec: SearchSpec
): KeyQualityItem[] {
  const matchPriority = createMatchPriorityClassifier(query);
  const ids = index.matchIds(query);
  const idField = spec.idField || '';
  const out: KeyQualityItem[] = new Array(ids.length);
  if (idField === 'cis') {
    for (let i = 0; i < ids.length; i++) {
      const row = corpus[ids[i]];
      out[i] = {
        cis: row.cis,
        match_quality: matchQualityFromPriority(classifyRow(row, matchPriority, spec))
      };
    }
    return out;
  }
  if (idField === 'num') {
    for (let i = 0; i < ids.length; i++) {
      const row = corpus[ids[i]];
      out[i] = {
        num: row.num,
        match_quality: matchQualityFromPriority(classifyRow(row, matchPriority, spec))
      };
    }
    return out;
  }
  for (let i = 0; i < ids.length; i++) {
    const row = corpus[ids[i]];
    out[i] = {
      [idField]: row[idField],
      match_quality: matchQualityFromPriority(classifyRow(row, matchPriority, spec))
    };
  }
  return out;
}

function rankSearchResults(
  corpus: Array<Record<string, unknown>>,
  searchResults: MiniSearchHit[],
  query: string,
  spec: SearchSpec
): RankedHit[] {
  const matchPriority = createMatchPriorityClassifier(query);
  const ranked = searchResults.map((res) => rankSearchHit(corpus, res, matchPriority, spec));
  ranked.sort((a, b) => b.priority - a.priority || b.score - a.score);
  return ranked;
}

/**
 * Page classée qualité puis score, avec un total exact.
 */
function searchRankedPage(
  corpus: Array<Record<string, unknown>>,
  index: SearchIndexLike,
  query: string,
  spec: SearchSpec,
  page: unknown,
  limit: unknown
): { total: number; ranked: RankedHit[] } {
  if (!corpus || !index || !query) return { total: 0, ranked: [] };
  const { offset, safeLimit } = parseListPaging(page, limit);
  const end = offset + safeLimit;
  const cached = pageSearchCache.get(index);
  const sameQuery = Boolean(cached && cached.query === query && cached.corpus === corpus && cached.spec === spec);

  if (sameQuery && cached) {
    if (offset >= cached.total) return { total: cached.total, ranked: [] };
    let tierStart = 0;
    for (let p = 2; p >= 0; p--) {
      const priority = p as MatchPriority;
      const tierEnd = tierStart + cached.counts[priority];
      if (offset >= tierStart && Math.min(end, cached.total) <= tierEnd) {
        const hits = scoredSearch(index, query, {
          limit: Math.min(end, cached.total) - tierStart,
          filter: (hit: MiniSearchHit) => cached.priorities[hit.id] === priority
        });
        const ranked: RankedHit[] = hits.slice(offset - tierStart).map((hit) => ({
          rowIndex: hit.id,
          score: hit.score,
          priority,
          match_quality: matchQualityFromPriority(priority)
        }));
        return { total: cached.total, ranked };
      }
      tierStart = tierEnd;
    }
  }

  const ranked = rankSearchResults(corpus, scoredSearch(index, query), query, spec);
  if (!sameQuery && ranked.length > end) {
    const priorities = new Uint8Array(corpus.length);
    const counts: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < ranked.length; i++) {
      const hit = ranked[i];
      priorities[hit.rowIndex] = hit.priority;
      counts[hit.priority]++;
    }
    pageSearchCache.set(index, { query, corpus, spec, total: ranked.length, priorities, counts });
  }
  return { total: ranked.length, ranked: ranked.slice(offset, end) };
}

export interface CorpusRowWithToJson extends Record<string, unknown> {
  toJSON(): Record<string, unknown>;
}

function materializeRankedSearchRange(
  corpus: CorpusRowWithToJson[],
  ranked: RankedHit[],
  start: number,
  end: number,
  mapRow: ((row: CorpusRowWithToJson, rowIndex: number, matchQuality: MatchQuality) => Record<string, unknown>) | null = null
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = new Array(Math.max(0, end - start));
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

function rankAndMaterializeSearch(
  corpus: CorpusRowWithToJson[],
  searchResults: MiniSearchHit[],
  query: string,
  spec: SearchSpec,
  mapRow: ((row: CorpusRowWithToJson, rowIndex: number, matchQuality: MatchQuality) => Record<string, unknown>) | null = null
): Record<string, unknown>[] {
  const ranked = rankSearchResults(corpus, searchResults, query, {
    primaryField: spec.primaryField,
    idField: spec.idField ?? null,
    codeFields: spec.codeFields ?? null
  });
  return materializeRankedSearchRange(corpus, ranked, 0, ranked.length, mapRow);
}

export {
  scoredSearch,
  searchKeyQualities,
  rankSearchResults,
  searchRankedPage,
  materializeRankedSearchRange,
  rankAndMaterializeSearch
};
