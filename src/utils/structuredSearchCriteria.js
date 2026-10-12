'use strict';

const { normalizeSearchText, MATCH_QUALITY_RANK } = require('./searchRanking');

// Facteur de conversion vers l'unité canonique (mg, ml, ui, %).
const UNITS = {
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

// Le séparateur de milliers n'est accepté que devant une unité internationale :
// devant mg, « MAG 2 100 mg » ou « D3 500 mg » seraient lus comme 2 100 ou 3 500 mg.
const UI_THOUSANDS = String.raw`(?<![\p{L}\d.,])\d{1,3}(?:[ \u00a0]\d{3})+(?=\s*(?:ui|iu|u|unites?)(?![\p{L}]))`;
const DECIMAL = String.raw`\d+(?:[.,]\d+)?`;
const UNIT = String.raw`mg|g|grammes?|ml|l|ui|iu|u|µg|μg|ug|mcg|microgrammes?|unites?|pour cent|%`;
// « /ml » sans volume forme une concentration ; un volume écrit (« /5 ml », « /1 ml »)
// reste une quantité distincte.
const DOSAGE_TOKEN_RE = new RegExp(
  String.raw`(${UI_THOUSANDS}|${DECIMAL})\s*(${UNIT})(?![\p{L}])(?:\s*\/\s*(ml|l)(?![\p{L}\d]))?`,
  'giu'
);

/**
 * Lit les quantités d'une chaîne telles qu'écrites, converties en mg, ml, ui ou %.
 * Une concentration par ml garde son unité composée (`mg/ml`) ; un volume écrit
 * (`250 mg/5 ml`) donne deux quantités indépendantes. Retourne [] si rien d'exploitable.
 */
function parseDosageTokens(value) {
  const text = normalizeSearchText(String(value ?? ''));
  if (!text) return [];

  const tokens = [];
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

/**
 * Compte les quantités demandées retrouvées dans le candidat, chaque quantité
 * du candidat ne servant qu'une fois. `extra` compte les quantités du candidat
 * non demandées.
 */
function matchDosageTokens(requested, candidate, { toleranceRatio = 0.02 } = {}) {
  const used = new Set();
  let matched = 0;
  for (const req of requested) {
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

/**
 * Le dosage est lu uniquement dans la dénomination / nom. Le champ
 * `compositions.dosage` est volontairement ignoré (dilutions homéo, sels FT,
 * dosages par substance) — le dosage pertinent pour l'agent vit dans la dénomination.
 */
function getStructuredDenomination(hit) {
  return hit.denomination || hit.nom || '';
}

function getStructuredForme(hit) {
  return hit.forme_pharma || hit.forme_pharmaceutique || '';
}

/**
 * Score non destructif selon dosage/forme/voie. Ne filtre jamais les candidats ;
 * ne sert qu'à réordonner à l'intérieur d'un même niveau de `match_quality`.
 * Le boost de dosage est proportionnel aux quantités retrouvées ;
 * `criteria_match.dosage` exige qu'elles le soient toutes. `dosage_extra` sert
 * à départager deux boosts égaux et vaut null sans quantité retrouvée.
 */
function scoreStructuredCriteria(hit, criteria = {}) {
  const { dosage = null, forme = null, voie = null } = criteria;
  const match = { dosage: false, forme: false, voie: false };
  let boost = 0;
  let dosageExtra = null;

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

/**
 * Ordre lexicographique, donc transitif : qualité, boost, puis le moins de
 * quantités non demandées (`_dosageExtra`). La qualité reste prioritaire pour
 * qu'un match faible ne passe jamais devant un match fort. À égalité,
 * l'appelant garde l'ordre initial.
 */
function compareByQualityThenBoost(a, b) {
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

function rerankWithStructuredCriteria(results, criteria = {}) {
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

  return scored.map(({ _index, _dosageExtra, ...hit }) => hit);
}

module.exports = {
  parseDosageTokens,
  matchDosageTokens,
  textOverlapScore,
  hasStructuredCriteria,
  scoreStructuredCriteria,
  compareByQualityThenBoost,
  rerankWithStructuredCriteria
};
