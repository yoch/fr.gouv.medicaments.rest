'use strict';

const { normalizeSearchText } = require('./searchRanking');

const UNIT_ALIASES = {
  mg: 'mg',
  g: 'g',
  gramme: 'g',
  grammes: 'g',
  ml: 'ml',
  l: 'l',
  ui: 'ui',
  u: 'ui',
  iu: 'ui',
  ug: 'ug',
  µg: 'ug',
  mcg: 'ug',
  microgramme: 'ug',
  microgrammes: 'ug',
  '%': '%'
};

const DOSAGE_TOKEN_RE =
  /(\d+(?:[.,]\d+)?)\s*(mg|g|grammes?|ml|l|ui|iu|u|µg|ug|mcg|microgrammes?|%)/giu;

/**
 * Parse une chaîne dosage en quantités normalisées (mg, g, ml, ui, ug, %).
 * Retourne [] si rien d'exploitable.
 */
function parseDosageTokens(value) {
  const text = normalizeSearchText(String(value ?? ''));
  if (!text) return [];

  const tokens = [];
  let match;
  const re = new RegExp(DOSAGE_TOKEN_RE.source, DOSAGE_TOKEN_RE.flags);
  while ((match = re.exec(text)) !== null) {
    const amount = Number.parseFloat(match[1].replace(',', '.'));
    if (!Number.isFinite(amount)) continue;
    const unitKey = match[2].normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const unit = UNIT_ALIASES[unitKey];
    if (!unit) continue;
    tokens.push({ amount, unit });
  }
  return tokens;
}

function toCanonicalMg(token) {
  if (!token) return null;
  switch (token.unit) {
    case 'mg':
      return token.amount;
    case 'g':
      return token.amount * 1000;
    case 'ug':
      return token.amount / 1000;
    default:
      return null;
  }
}

function dosageTokensMatch(requested, candidate, { toleranceRatio = 0.02 } = {}) {
  const reqMg = requested.map(toCanonicalMg).filter((v) => v != null);
  const candMg = candidate.map(toCanonicalMg).filter((v) => v != null);
  if (reqMg.length === 0 || candMg.length === 0) return false;

  return reqMg.some((req) =>
    candMg.some((cand) => {
      const delta = Math.abs(req - cand);
      const tol = Math.max(req, cand) * toleranceRatio;
      return delta <= Math.max(tol, 0.001);
    })
  );
}

function tokenSet(value) {
  return new Set(
    normalizeSearchText(value)
      .split(/[\s/;,+()-]+/u)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3)
  );
}

function textOverlapScore(needle, haystack) {
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

const MATCH_QUALITY_RANK = { exact: 3, prefix: 2, fuzzy: 1 };

function hasStructuredCriteria(criteria) {
  return Boolean(criteria && (criteria.dosage || criteria.forme || criteria.voie));
}

/**
 * Sources de dosage pour le scoring : uniquement la dénomination de la spécialité.
 * Le champ `compositions.dosage` est volontairement ignoré (dilutions homéo, sels FT,
 * dosages par substance) — le dosage pertinent pour l'agent vit dans la dénomination.
 */
function collectDosageSources(hit) {
  return hit.denomination ? [hit.denomination] : [];
}

/**
 * Score non destructif selon dosage/forme/voie. Ne filtre jamais les candidats ;
 * ne sert qu'à réordonner à l'intérieur d'un même niveau de `match_quality`.
 */
function scoreStructuredCriteria(hit, criteria = {}) {
  const { dosage = null, forme = null, voie = null } = criteria;
  const match = { dosage: false, forme: false, voie: false };
  let boost = 0;

  if (dosage) {
    const requested = parseDosageTokens(dosage);
    if (requested.length > 0) {
      const sources = collectDosageSources(hit);
      match.dosage = sources.some((src) =>
        dosageTokensMatch(requested, parseDosageTokens(src))
      );
      if (match.dosage) boost += 2;
    }
  }

  if (forme) {
    const score = textOverlapScore(forme, hit.forme_pharma || '');
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

  return { boost, criteria_match: match };
}

/**
 * Comparateur anti-bruit : si les critères n'apportent aucun différentiel de
 * boost, l'ordre existant est conservé. Dès qu'un boost structuré déplacerait
 * un candidat, `match_quality` garde la priorité pour empêcher un match faible
 * de passer devant un match fort.
 */
function compareByQualityThenBoost(a, b) {
  const boostA = a.criteria_boost || 0;
  const boostB = b.criteria_boost || 0;
  if (boostB === boostA) return 0;
  const rankA = MATCH_QUALITY_RANK[a.match_quality] || 0;
  const rankB = MATCH_QUALITY_RANK[b.match_quality] || 0;
  if (rankB !== rankA) return rankB - rankA;
  return boostB - boostA;
}

function rerankWithStructuredCriteria(results, criteria = {}) {
  if (!hasStructuredCriteria(criteria)) {
    return results;
  }

  const scored = results.map((hit, index) => {
    const { boost, criteria_match } = scoreStructuredCriteria(hit, criteria);
    return { ...hit, criteria_boost: boost, criteria_match, _index: index };
  });

  scored.sort((a, b) => {
    const byQuality = compareByQualityThenBoost(a, b);
    if (byQuality !== 0) return byQuality;
    return a._index - b._index;
  });

  return scored.map(({ _index, ...hit }) => hit);
}

module.exports = {
  parseDosageTokens,
  dosageTokensMatch,
  textOverlapScore,
  hasStructuredCriteria,
  scoreStructuredCriteria,
  compareByQualityThenBoost,
  rerankWithStructuredCriteria
};
