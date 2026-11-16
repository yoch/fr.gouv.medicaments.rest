import { normalizeSearchText, MATCH_QUALITY_RANK } from './searchRanking.mts';

export interface DosageToken {
  amount: number;
  unit: string;
}

export interface SearchCriteria {
  dosage?: string | null;
  forme?: string | null;
  voie?: string | null;
}

export interface CriteriaMatchFlags {
  dosage: boolean;
  forme: boolean;
  voie: boolean;
}

export interface CriteriaScoreResult {
  boost: number;
  criteria_match: CriteriaMatchFlags;
  dosage_extra: number | null;
}

// Facteur de conversion vers l'unité canonique (mg, ml, ui, %).
const UNITS: Record<string, [number, string]> = {
  mg: [1, 'mg'],
  g: [1000, 'mg'],
  gramme: [1000, 'mg'],
  grammes: [1000, 'mg'],
  ug: [0.001, 'mg'],
  µg: [0.001, 'mg'],
  μg: [0.001, 'mg'],
  mcg: [0.001, 'mg'],
  microgramme: [0.001, 'mg'],
  microgrammes: [0.001, 'mg'],
  ml: [1, 'ml'],
  l: [1000, 'ml'],
  ui: [1, 'ui'],
  u: [1, 'ui'],
  iu: [1, 'ui'],
  unite: [1, 'ui'],
  unites: [1, 'ui'],
  '%': [1, '%'],
  'pour cent': [1, '%']
};

const UI_THOUSANDS = String.raw`(?<![\p{L}\d.,])\d{1,3}(?:[ \u00a0]\d{3})+(?=\s*(?:ui|iu|u|unites?)(?![\p{L}]))`;
const DECIMAL = String.raw`\d+(?:[.,]\d+)?`;
const UNIT = String.raw`mg|g|grammes?|ml|l|ui|iu|u|µg|μg|ug|mcg|microgrammes?|unites?|pour cent|%`;
const DOSAGE_TOKEN_RE = new RegExp(
  String.raw`(${UI_THOUSANDS}|${DECIMAL})\s*(${UNIT})(?![\p{L}])(?:\s*\/\s*(ml|l)(?![\p{L}\d]))?`,
  'giu'
);

function parseDosageTokens(value: unknown): DosageToken[] {
  const text = normalizeSearchText(String(value ?? ''));
  if (!text) return [];

  const tokens: DosageToken[] = [];
  for (const match of text.matchAll(DOSAGE_TOKEN_RE)) {
    const amount = Number.parseFloat(match[1].replace(/[\s\u00a0]/g, '').replace(',', '.'));
    const unit = UNITS[match[2].normalize('NFD').replace(/[\u0300-\u036f]/g, '')];
    if (!Number.isFinite(amount) || !unit) continue;
    const [factor, canonical] = unit;
    if (match[3]) {
      const perFactor = match[3] === 'l' ? 1000 : 1;
      tokens.push({ amount: (amount * factor) / perFactor, unit: `${canonical}/ml` });
    } else {
      tokens.push({ amount: amount * factor, unit: canonical });
    }
  }
  return tokens;
}

function matchDosageTokens(
  requested: DosageToken[],
  candidate: DosageToken[],
  { toleranceRatio = 0.02 }: { toleranceRatio?: number } = {}
): { matched: number; extra: number } {
  const used = new Set<number>();
  let matched = 0;
  for (let r = 0; r < requested.length; r++) {
    const req = requested[r];
    const index = candidate.findIndex((cand, i) =>
      !used.has(i) &&
      cand.unit === req.unit &&
      Math.abs(req.amount - cand.amount) <= Math.max(req.amount, cand.amount) * toleranceRatio
    );
    if (index >= 0) {
      used.add(index);
      matched += 1;
    }
  }
  return { matched, extra: candidate.length - matched };
}

function tokenSet(value: unknown): Set<string> {
  return new Set(
    normalizeSearchText(value)
      .split(/[\s/;,+()-]+/u)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3)
  );
}

function textOverlapScore(needle: unknown, haystack: unknown): number {
  const n = normalizeSearchText(needle);
  const h = normalizeSearchText(haystack);
  if (!n || !h) return 0;
  if (h.includes(n)) return 1;
  const needleTokens = tokenSet(n);
  if (needleTokens.size === 0) return 0;
  const hayTokens = tokenSet(h);
  let hits = 0;
  for (const t of needleTokens) {
    if (hayTokens.has(t)) hits += 1;
  }
  return hits / needleTokens.size;
}

function hasStructuredCriteria(criteria?: SearchCriteria | null): boolean {
  return Boolean(criteria && (criteria.dosage || criteria.forme || criteria.voie));
}

function getStructuredDenomination(hit: Record<string, unknown>): string {
  return String(hit.denomination || hit.nom || '');
}

function getStructuredForme(hit: Record<string, unknown>): string {
  return String(hit.forme_pharma || hit.forme_pharmaceutique || '');
}

function scoreStructuredCriteria(hit: Record<string, unknown>, criteria: SearchCriteria = {}): CriteriaScoreResult {
  const { dosage = null, forme = null, voie = null } = criteria;
  const match: CriteriaMatchFlags = { dosage: false, forme: false, voie: false };
  let boost = 0;
  let dosageExtra: number | null = null;

  if (dosage) {
    const requested = parseDosageTokens(dosage);
    if (requested.length > 0) {
      const { matched, extra } = matchDosageTokens(
        requested,
        parseDosageTokens(getStructuredDenomination(hit))
      );
      match.dosage = matched === requested.length;
      if (matched > 0) {
        boost += (2 * matched) / requested.length;
        dosageExtra = extra;
      }
    }
  }

  if (forme) {
    const score = textOverlapScore(forme, getStructuredForme(hit));
    if (score >= 0.5) {
      match.forme = true;
      boost += score >= 1 ? 2 : 1;
    }
  }

  if (voie) {
    const score = textOverlapScore(voie, hit.voies_admin || '');
    if (score >= 0.5) {
      match.voie = true;
      boost += score >= 1 ? 1 : 0.5;
    }
  }

  return { boost, criteria_match: match, dosage_extra: dosageExtra };
}

interface RankableItem {
  match_quality: string;
  criteria_boost?: number;
  _dosageExtra?: number | null;
}

function compareByQualityThenBoost(a: RankableItem, b: RankableItem): number {
  const rankA = MATCH_QUALITY_RANK[a.match_quality] || 0;
  const rankB = MATCH_QUALITY_RANK[b.match_quality] || 0;
  if (rankB !== rankA) return rankB - rankA;
  const boostA = a.criteria_boost || 0;
  const boostB = b.criteria_boost || 0;
  if (boostB !== boostA) return boostB - boostA;
  const extraA = a._dosageExtra ?? Infinity;
  const extraB = b._dosageExtra ?? Infinity;
  if (extraA === extraB) return 0;
  return extraA < extraB ? -1 : 1;
}

function rerankWithStructuredCriteria<T extends Record<string, unknown> & RankableItem>(
  results: T[],
  criteria: SearchCriteria = {}
): T[] {
  if (!hasStructuredCriteria(criteria)) {
    return results;
  }

  const scored = results.map((hit, index) => {
    const { boost, criteria_match, dosage_extra } = scoreStructuredCriteria(hit, criteria);
    return { ...hit, criteria_boost: boost, criteria_match, _dosageExtra: dosage_extra, _index: index };
  });

  scored.sort((a, b) => {
    const byQuality = compareByQualityThenBoost(a, b);
    if (byQuality !== 0) return byQuality;
    return a._index - b._index;
  });

  return scored.map(({ _index, _dosageExtra, ...hit }) => hit as unknown as T);
}

export {
  parseDosageTokens,
  matchDosageTokens,
  textOverlapScore,
  hasStructuredCriteria,
  scoreStructuredCriteria,
  compareByQualityThenBoost,
  rerankWithStructuredCriteria
};
