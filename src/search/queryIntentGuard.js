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
  { re: /\bpendant\s+(?:la\s+)?grossesse\b|\bfemme\s+enceinte\b|\ballaitement\b/, kind: 'pregnancy_lactation' },
  { re: /\beffets?\s+(?:indesirables?|secondaires?)\b|\binteraction(?:s)?\s+medicamenteuse(?:s)?\b|\bsurdosage\b/, kind: 'clinical_rcp_property' }
];

function canonicalizeEntityChunk(tokens) {
  const cleaned = tokens.filter((t) => t && !STOP_CLAUSE_FILLERS.has(t));
  return cleaned.join(' ');
}

/**
 * Analyse les négations explicites, contextes cliniques RCP et poids corporel patient (kg)
 * afin d'éviter toute perte silencieuse d'intention ou fausse inférence (A1).
 */
function analyzeQuerySafetyAndIntent(rawQuery, parsed) {
  const norm = normalizeSearchText(rawQuery || '')
    .replace(/['’/;,+()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!norm) {
    return {
      supported: true,
      intent: parsed && parsed.kind === 'exact_code' ? 'exact_code' : 'product_or_concept',
      abstainReason: null,
      patientWeight: null,
      pediatricInferred: false,
      verbatimQualifiers: [],
      negation: { detected: false, markers: [], excluded: [] },
      clinicalProperty: { detected: false, polarity: null, cues: [] }
    };
  }

  // Poids corporel patient (ex. « douleur adulte 70 kg ») : jamais un dosage, jamais déduit « pédiatrique »
  const weightMatch = norm.match(/\b(\d+(?:[.,]\d+)?)\s*kg\b(?!\s*\/)/);
  const patientWeight = weightMatch ? `${weightMatch[1]} kg` : null;

  // Propriétés cliniques / RCP (contre-indications, grossesse, effets indésirables...)
  const clinicalCues = [];
  let clinicalPolarity = null;
  for (const pat of CLINICAL_RCP_PATTERNS) {
    if (pat.re.test(norm)) {
      clinicalCues.push(pat.kind);
      if (pat.kind === 'contraindication_negated') clinicalPolarity = 'negated_contraindication';
      else if (pat.kind === 'contraindication' && !clinicalPolarity) clinicalPolarity = 'contraindication';
    }
  }
  const hasClinicalRcp = clinicalCues.length > 0;

  // Analyse séquentielle de négations : « sans X », « sans X ni Y », « pas de X », « ni Y »
  const tokens = norm.split(' ');
  const markers = [];
  const excluded = [];
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
    negation: {
      detected: hasUnsupportedExclusion || (clinicalPolarity === 'negated_contraindication'),
      markers: [...new Set(markers)],
      excluded: [...new Set(excluded)]
    },
    clinicalProperty: {
      detected: hasClinicalRcp,
      polarity: clinicalPolarity,
      cues: clinicalCues
    }
  };
}

module.exports = {
  VERBATIM_SANS_QUALIFIERS,
  analyzeQuerySafetyAndIntent
};
