'use strict';

const { normalizeSearchText } = require('../utils/searchRanking');

/**
 * Qualificatifs négatifs figurant littéralement dans les dénominations BDPM.
 * Toute autre clause « sans <entité> » ou négation (« pas de », « ni ») est traitée
 * comme une exclusion / contrainte clinique non vérifiable sans RCP complet.
 */
const VERBATIM_SANS_QUALIFIERS = new Set([
  'sucre',
  'sucres',
  'conservateur',
  'conservateurs',
  'alcool'
]);

const NEGATION_CLAUSE_BOUNDARY = new Set([
  'en', 'avec', 'pour', 'comprime', 'comprimes', 'gelule', 'gelules',
  'sirop', 'sachet', 'sachets', 'collyre', 'solution', 'pommade', 'creme',
  'suppositoire', 'suppositoires', 'ampoule', 'ampoules', 'injectable',
  'enfant', 'adulte', 'chien', 'chat'
]);

const STOP_CLAUSE_FILLERS = new Set(['de', 'du', 'des', 'd', 'le', 'la', 'les', 'l', 'un', 'une', 'et', 'ou']);

const CLINICAL_RCP_PATTERNS = [
  { re: /\bnon\s+contre[\s-]?indiqu(?:e|ee|es|ees)\b/, kind: 'contraindication_negated' },
  { re: /\bcontre[\s-]?indiqu(?:e|ee|es|ees)\b|\bcontre[\s-]?indications?\b/, kind: 'contraindication' },
  { re: /\bpendant\s+(?:la\s+)?grossesse\b|\bfemme\s+enceinte\b|\bgrossesse\b|\benceinte[s]?\b|\ballaitement\b|\ballaiter\b|\ballaite(?:nt)?\b/, kind: 'pregnancy_lactation' },
  { re: /\bcompatibles?\b|\bcompatibilite\b|\bteratogene\b/, kind: 'clinical_compatibility' },
  { re: /\beffets?\s+(?:indesirables?|secondaires?)\b|\binteraction(?:s)?\s+medicamenteuse(?:s)?\b|\bsurdosage\b/, kind: 'clinical_rcp_property' }
];

const EXPLICIT_NEGATION_TOKENS = new Set([
  'non', 'pas', 'ni', 'aucun', 'aucune', 'sauf', 'excepte', 'hors'
]);

function normalizeCriterionText(value) {
  return normalizeSearchText(value || '')
    .replace(/['’/;,+()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inspectCriterionConstraint(value) {
  const norm = normalizeCriterionText(value);
  if (!norm) return null;

  for (const pat of CLINICAL_RCP_PATTERNS) {
    if (pat.re.test(norm)) {
      return { reason: 'clinical_rcp_property_in_criterion', markers: [], excluded: [], cues: [pat.kind] };
    }
  }

  const tokens = norm.split(' ').filter(Boolean);
  const markers = [];
  const excluded = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (EXPLICIT_NEGATION_TOKENS.has(tok)) {
      markers.push(tok);
      let j = i + 1;
      while (j < tokens.length && STOP_CLAUSE_FILLERS.has(tokens[j])) j++;
      const rest = tokens.slice(j).filter((t) => !STOP_CLAUSE_FILLERS.has(t) && !EXPLICIT_NEGATION_TOKENS.has(t));
      if (rest.length > 0) excluded.push(rest.join(' '));
    } else if (tok === 'sans') {
      let j = i + 1;
      while (j < tokens.length && STOP_CLAUSE_FILLERS.has(tokens[j])) j++;
      const rest = [];
      while (j < tokens.length && tokens[j] !== 'ni' && tokens[j] !== 'sans') {
        if (!STOP_CLAUSE_FILLERS.has(tokens[j])) rest.push(tokens[j]);
        j++;
      }
      const phrase = rest.join(' ');
      if (!phrase || !VERBATIM_SANS_QUALIFIERS.has(phrase)) {
        markers.push('sans');
        if (phrase) excluded.push(phrase);
      }
      i = Math.max(i, j - 1);
    }
  }

  if (markers.length > 0) {
    return { reason: 'negation_in_explicit_criterion', markers: [...new Set(markers)], excluded: [...new Set(excluded)], cues: [] };
  }
  return null;
}

function canonicalizeEntityChunk(tokens) {
  const cleaned = tokens.filter((t) => t && !STOP_CLAUSE_FILLERS.has(t));
  return cleaned.join(' ');
}

/**
 * Analyse les négations explicites, contextes cliniques RCP et poids corporel patient (kg)
 * afin d'éviter toute perte silencieuse d'intention ou fausse inférence (A1).
 */
function analyzeQuerySafetyAndIntent(rawQuery, parsed, explicitCriteria = {}) {
  const norm = normalizeCriterionText(rawQuery);

  const unsupportedCriteria = [];
  const clinicalCues = [];
  let clinicalPolarity = null;
  const markers = [];
  const excluded = [];

  const criteriaToCheck = {
    dosage: explicitCriteria?.dosage ?? parsed?.effectiveCriteria?.dosage ?? null,
    forme: explicitCriteria?.forme ?? parsed?.effectiveCriteria?.forme ?? null,
    voie: explicitCriteria?.voie ?? parsed?.effectiveCriteria?.voie ?? null
  };

  for (const [field, val] of Object.entries(criteriaToCheck)) {
    if (!val) continue;
    const issue = inspectCriterionConstraint(val);
    if (issue) {
      unsupportedCriteria.push({ field, value: String(val).trim(), reason: issue.reason });
      for (const m of issue.markers) markers.push(m);
      for (const ex of issue.excluded) excluded.push(ex);
      for (const cue of issue.cues) clinicalCues.push(cue);
    }
  }

  if (!norm && unsupportedCriteria.length === 0) {
    return {
      supported: true,
      intent: parsed && parsed.kind === 'exact_code' ? 'exact_code' : 'product_or_concept',
      abstainReason: null,
      patientWeight: null,
      pediatricInferred: false,
      verbatimQualifiers: [],
      unsupportedCriteria: [],
      negation: { detected: false, markers: [], excluded: [] },
      clinicalProperty: { detected: false, polarity: null, cues: [] }
    };
  }

  // Poids corporel patient (ex. « douleur adulte 70 kg ») : jamais un dosage, jamais déduit « pédiatrique »
  const weightMatch = norm.match(/\b(\d+(?:[.,]\d+)?)\s*kg\b(?!\s*\/)/);
  const patientWeight = weightMatch ? `${weightMatch[1]} kg` : null;

  // Propriétés cliniques / RCP (contre-indications, grossesse, effets indésirables...)
  for (const pat of CLINICAL_RCP_PATTERNS) {
    if (pat.re.test(norm)) {
      clinicalCues.push(pat.kind);
      if (pat.kind === 'contraindication_negated') clinicalPolarity = 'negated_contraindication';
      else if (pat.kind === 'contraindication' && !clinicalPolarity) clinicalPolarity = 'contraindication';
    }
  }
  const hasClinicalRcp = clinicalCues.length > 0;

  // Analyse séquentielle de négations : « sans X », « sans X ni Y », « pas de X », « ni Y »
  const tokens = norm ? norm.split(' ') : [];
  const verbatimQualifiers = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === 'sans' || tok === 'ni' || tok === 'pas') {
      if (tok === 'pas') {
        // « pas de X » / « pas d X » / « pas X »
        markers.push('pas');
        let j = i + 1;
        while (j < tokens.length && STOP_CLAUSE_FILLERS.has(tokens[j])) j++;
        const chunk = [];
        while (
          j < tokens.length &&
          tokens[j] !== 'ni' &&
          tokens[j] !== 'sans' &&
          tokens[j] !== 'et' &&
          !NEGATION_CLAUSE_BOUNDARY.has(tokens[j])
        ) {
          chunk.push(tokens[j]);
          j++;
        }
        const entity = canonicalizeEntityChunk(chunk);
        if (entity) excluded.push(entity);
        i = Math.max(i, j - 1);
      } else {
        // « sans ... » ou « ni ... »
        let j = i + 1;
        while (j < tokens.length && STOP_CLAUSE_FILLERS.has(tokens[j])) j++;
        const chunk = [];
        while (
          j < tokens.length &&
          tokens[j] !== 'ni' &&
          tokens[j] !== 'sans' &&
          !NEGATION_CLAUSE_BOUNDARY.has(tokens[j])
        ) {
          chunk.push(tokens[j]);
          j++;
        }
        const entity = canonicalizeEntityChunk(chunk);
        if (tok === 'sans' && entity && VERBATIM_SANS_QUALIFIERS.has(entity)) {
          verbatimQualifiers.push(`sans ${entity}`);
        } else if (entity) {
          markers.push(tok);
          excluded.push(entity);
        } else {
          markers.push(tok);
        }
        i = Math.max(i, j - 1);
      }
    }
  }

  // Cas particulier « sans conservateur ni <X> » / « non <contre-indiqué> »
  if (tokens.includes('non') && !hasClinicalRcp) {
    markers.push('non');
  }

  const hasUnsupportedExclusion = excluded.length > 0 || markers.length > 0;

  let supported = true;
  let intent = parsed && parsed.kind === 'exact_code' ? 'exact_code' : 'product_or_concept';
  let abstainReason = null;

  if (hasClinicalRcp) {
    supported = false;
    intent = 'clinical_rcp_property_unsupported';
    abstainReason = 'clinical_rcp_property_not_indexed';
  } else if (unsupportedCriteria.length > 0) {
    supported = false;
    intent = 'explicit_criterion_unsupported';
    abstainReason = 'explicit_criterion_negation_not_supported';
  } else if (hasUnsupportedExclusion) {
    supported = false;
    intent = 'negation_exclusion_unsupported';
    abstainReason = 'substance_or_constraint_exclusion_not_supported';
  }

  return {
    supported,
    intent,
    abstainReason,
    patientWeight,
    pediatricInferred: false,
    verbatimQualifiers: [...new Set(verbatimQualifiers)],
    unsupportedCriteria,
    negation: {
      detected: hasUnsupportedExclusion || (clinicalPolarity === 'negated_contraindication'),
      markers: [...new Set(markers)],
      excluded: [...new Set(excluded)]
    },
    clinicalProperty: {
      detected: hasClinicalRcp,
      polarity: clinicalPolarity,
      cues: [...new Set(clinicalCues)]
    }
  };
}

module.exports = {
  VERBATIM_SANS_QUALIFIERS,
  analyzeQuerySafetyAndIntent,
  inspectCriterionConstraint
};
