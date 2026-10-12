'use strict';

const { normalizeSearchText, MATCH_QUALITY_RANK } = require('./searchRanking');

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
  μg: 'ug',
  mcg: 'ug',
  microgramme: 'ug',
  microgrammes: 'ug',
  '%': '%'
};

const DOSAGE_TOKEN_RE =
  /(\d+(?:[.,]\d+)?)\s*(mg|g|grammes?|ml|l|ui|iu|u|µg|μg|ug|mcg|microgrammes?|%)(?![\p{L}])(?:\s*\/\s*(?:(\d+(?:[.,]\d+)?)\s*)?(ml|l)(?![\p{L}]))?/giu;

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
    const token = { amount, unit };
    if (match[4]) {
      const volume = match[3] == null ? 1 : Number.parseFloat(match[3].replace(',', '.'));
      if (!Number.isFinite(volume) || volume <= 0) continue;
      token.per = { amount: volume, unit: match[4] };
    }
    tokens.push(token);
  }
  return tokens;
}

function toCanonicalQuantity(token) {
  if (!token) return null;
  switch (token.unit) {
    case 'mg':
      return { amount: token.amount, unit: 'mg' };
    case 'g':
      return { amount: token.amount * 1000, unit: 'mg' };
    case 'ug':
      return { amount: token.amount / 1000, unit: 'mg' };
    case 'ml':
      return { amount: token.amount, unit: 'ml' };
    case 'l':
      return { amount: token.amount * 1000, unit: 'ml' };
    case 'ui':
    case '%':
      return token;
    default:
      return null;
  }
}

function dosageTokensMatch(requested, candidate, { toleranceRatio = 0.02 } = {}) {
  const canonical = (token) => {
    const quantity = toCanonicalQuantity(token);
    if (!quantity) return null;
    const per = token.per && toCanonicalQuantity(token.per);
    const normalized = per
      ? { amount: quantity.amount / per.amount, unit: `${quantity.unit}/${per.unit}` }
      : quantity;
    return Number.isFinite(normalized.amount) ? normalized : null;
  };
  const requestedQuantities = requested.map(canonical).filter((v) => v != null);
  const candidateQuantities = candidate.map(canonical).filter((v) => v != null);
  if (requestedQuantities.length === 0 || candidateQuantities.length === 0) return false;

  return requestedQuantities.some((req) =>
    candidateQuantities.some((cand) => {
      if (req.unit !== cand.unit) return false;
      const delta = Math.abs(req.amount - cand.amount);
      const tol = Math.max(req.amount, cand.amount) * toleranceRatio;
      return delta <= tol;
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

function hasStructuredCriteria(criteria) {
  return Boolean(criteria && (criteria.dosage || criteria.forme || criteria.voie));
}

function getStructuredDenomination(hit) {
  return hit.denomination || hit.nom || '';
}

function getStructuredForme(hit) {
  return hit.forme_pharma || hit.forme_pharmaceutique || '';
}

/**
 * Sources de dosage pour le scoring : uniquement la dénomination / nom.
 * Le champ `compositions.dosage` est volontairement ignoré (dilutions homéo, sels FT,
 * dosages par substance) — le dosage pertinent pour l'agent vit dans la dénomination.
 */
function collectDosageSources(hit) {
  const denomination = getStructuredDenomination(hit);
  return denomination ? [denomination] : [];
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

  return { boost, criteria_match: match };
}

/**
 * La qualité reste le premier critère, même à boost égal : cette comparaison
 * lexicographique est transitive et empêche un match faible de passer devant
 * un match fort. À qualité et boost égaux, l'appelant garde l'ordre initial.
 */
function compareByQualityThenBoost(a, b) {
  const boostA = a.criteria_boost || 0;
  const boostB = b.criteria_boost || 0;
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
