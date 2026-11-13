'use strict';

const {
  FR_STOPWORDS,
  normalizeText,
  maskNegativeLabelBigrams,
  tokenizeWithMaskedBigrams,
  simpleStemFr,
} = require('./text_utils');

// Purely grammatical/galenic pharmacy synonyms (NO symptom/indication shortcuts here)
const GALENIC_SYNONYMS = {
  nourrisson: ['pediatrique', 'enfant', 'bebe'],
  nourrissons: ['pediatrique', 'enfant', 'nourrisson'],
  bebe: ['nourrisson', 'pediatrique', 'enfant'],
  enfant: ['pediatrique', 'nourrisson'],
  enfants: ['pediatrique', 'enfant'],
  pediatrique: ['enfant', 'nourrisson'],
  adulte: ['adultes'],
  adultes: ['adulte'],
  buvable: ['orale', 'sirop', 'solution'],
  sirop: ['buvable', 'orale', 'suspension'],
  orale: ['buvable', 'comprime', 'gelule'],
  comprime: ['cp', 'comprimes'],
  comprimes: ['comprime', 'cp'],
  gelule: ['gelules'],
  gelules: ['gelule'],
  pommade: ['creme', 'gel', 'cutanee', 'topique'],
  creme: ['pommade', 'gel', 'cutanee', 'topique'],
  gel: ['creme', 'pommade', 'cutanee'],
  collyre: ['ophtalmique', 'oculaire'],
  ophtalmique: ['collyre', 'oculaire'],
  suppositoire: ['rectale'],
  maux: ['mal', 'douleur', 'douleurs'],
  mal: ['maux', 'douleur', 'douleurs'],
  yeux: ['oeil', 'oculaire', 'ophtalmique'],
};

// Strictly frozen v1 patient lexicon (18 terms from v1 — NEVER modified for unseen F5b eval!)
const LEXICON_V1 = {
  brulures: [['pyrosis', 0.85], ['reflux', 0.8], ['oesophagite', 0.75], ['gastrique', 0.6]],
  brulure: [['pyrosis', 0.85], ['reflux', 0.8], ['oesophagite', 0.75]],
  estomac: [['gastrique', 0.85], ['gastro', 0.75], ['ulcere', 0.7], ['reflux', 0.7]],
  remontees: [['reflux', 0.9], ['gastro', 0.7], ['oesophagien', 0.8], ['pyrosis', 0.8]],
  acides: [['gastrique', 0.7], ['reflux', 0.7], ['antiacide', 0.85], ['proton', 0.6]],
  caillot: [['thrombose', 0.9], ['embolie', 0.85], ['thromboembolique', 0.85], ['anticoagulant', 0.7]],
  veines: [['veineuse', 0.85], ['phlebite', 0.8], ['thrombose', 0.75]],
  sucre: [['glycemie', 0.85], ['diabete', 0.85], ['hyperglycemie', 0.8]],
  tension: [['hypertension', 0.85], ['arterielle', 0.75], ['antihypertenseur', 0.7]],
  cheveux: [['alopecie', 0.9], ['androgenetique', 0.75]],
  boutons: [['acne', 0.9], ['acneique', 0.8]],
  champignons: [['mycose', 0.9], ['mycoses', 0.85], ['antifongique', 0.8], ['candidose', 0.75]],
  ongles: [['onychomycose', 0.9], ['ungueale', 0.8], ['mycose', 0.7]],
  urinant: [['cystite', 0.85], ['urinaire', 0.85], ['miction', 0.7]],
  graisse: [['cholesterol', 0.85], ['hypercholesterolemie', 0.8], ['hyperlipidemie', 0.8], ['triglycerides', 0.75]],
  oeil: [['glaucome', 0.8], ['oculaire', 0.85], ['intraoculaire', 0.85], ['ophtalmique', 0.75]],
  regles: [['dysmenorrhee', 0.9], ['menstruelles', 0.85]],
  fatigue: [['anemie', 0.55], ['asthenie', 0.75], ['carence', 0.6]],
};

const INTENT_WRAPPER_STOP = new Set([
  'generique', 'generiques', 'equivalent', 'equivalents', 'equivalence',
  'remplacer', 'alternative', 'alternatives', 'molecule', 'principe', 'actif',
  'contient', 'meme', 'autre', 'medicament', 'medoc', 'quel', 'quelle',
  'quelque', 'prendre', 'contre', 'pour', 'avec', 'sans', 'donne', 'donnent',
  'provoque', 'provoquent', 'cause', 'causent', 'effet', 'effets',
  'secondaire', 'secondaires', 'indesirable', 'indesirables', 'indique',
  'interdit', 'eviter', 'compatible', 'danger', 'ordonnance', 'faire',
  'baisser', 'traiter', 'quoi', 'super', 'depuis', 'plusieurs', 'jours',
  'nuit', 'fois', 'bonjour', 'merci', 'pouvez', 'puis', 'savoir', 'cas',
]);

const SUB_RE = /\b(generique(?:s)?|equivalent(?:s)?|remplacer|alternative(?:s)?|meme\s+molecule|meme\s+principe|principe\s+actif|molecule\s+d[eu']?)\b/;
const ADVERSE_RE = /\b(qui\s+donne(?:nt)?|provoque(?:nt)?|cause(?:nt)?|fait\s+prendre|effet(?:s)?\s+secondaire(?:s)?|effet(?:s)?\s+indesirable(?:s)?)\b/;
const CI_RE = /\b(contre[- ]?indiqu[eé]|interdit|deconseill[eé]|a\s+eviter\s+en\s+cas)\b/;
const OTC_RE = /\bsans[\s_]+ordonnance\b/;
const HOSPITAL_RE = /\b(hospitalier|hopital|intraveineuse|perfusion|chimio|anesthesie|curare)\b/;

function extractNegations(normText) {
  const masked = maskNegativeLabelBigrams(normText);
  const excludes = [];
  const exRe = /\bsans\s+([a-z0-9]+)/g;
  let m;
  let stripped = masked;
  while ((m = exRe.exec(masked)) !== null) {
    const target = m[1];
    if (target && !['avis', 'ordonnance', 'sucre', 'sel', 'conservateur', 'alcool', 'gluten', 'sodium'].includes(target)) {
      excludes.push(target);
    }
  }
  if (excludes.length > 0) {
    stripped = stripped.replace(/\bsans\s+[a-z0-9]+/g, ' ');
  }
  return {
    strippedText: stripped,
    excludeSubstances: excludes,
    requireSansSucre: /\bsanssucre\b/.test(masked),
  };
}

function analyzeQuery(rawQuery, brandToCanonSubs) {
  const norm = normalizeText(rawQuery).replace(/(\d)(mg|mcg|ml|kg|ui|g)\b/g, '$1 $2');
  const { strippedText, excludeSubstances, requireSansSucre } = extractNegations(norm);

  const isSubstitution = SUB_RE.test(norm);
  const isAdverse = ADVERSE_RE.test(norm);
  const isContraindication = CI_RE.test(norm);
  const requireOtc = OTC_RE.test(norm);
  const wantsHospital = HOSPITAL_RE.test(norm);
  const isPediatric = /\b(nourrisson|bebe|enfant|pediatrique|kg|mois)\b/.test(norm);
  const isPregnancy = /\b(enceinte|grossesse|allaitement)\b/.test(norm);

  const rawTokens = tokenizeWithMaskedBigrams(strippedText);
  const contentTerms = [];
  for (const t of rawTokens) {
    if (!t) continue;
    if (FR_STOPWORDS.has(t)) continue;
    if (t === 'sansordonnance') continue;
    if (isSubstitution && INTENT_WRAPPER_STOP.has(t)) continue;
    if ((isAdverse || isContraindication) && ['effet', 'effets', 'secondaire', 'secondaires', 'indesirable', 'indesirables', 'provoque', 'donne', 'cause', 'fait', 'contre', 'indique', 'indiquee', 'cas'].includes(t)) continue;
    contentTerms.push(t);
  }

  // Automatic Brand -> Molecule inference (NO manual lexicon!)
  const detectedBrands = [];
  const inferredSubTerms = [];
  for (const t of contentTerms) {
    const info = brandToCanonSubs.get(t);
    if (info) {
      detectedBrands.push(t);
      for (const s of info.subs) {
        for (const sw of s.split(/\s+/)) {
          if (sw.length >= 3) inferredSubTerms.push(sw);
        }
      }
    }
  }

  // Expand negations via automatic BDPM brand->substance mapping (e.g. "sans aspirine" -> exclude acide acetylsalicylique)
  const excludeTermsExpanded = new Set(excludeSubstances);
  for (const ex of excludeSubstances) {
    const info = brandToCanonSubs.get(ex);
    if (info) {
      for (const s of info.subs) {
        excludeTermsExpanded.add(s);
        for (const w of s.split(/\s+/)) {
          if (w.length >= 7) excludeTermsExpanded.add(w);
        }
      }
    }
  }

  return {
    raw: rawQuery,
    norm,
    rawTokens,
    contentTerms,
    excludeSubstances: [...excludeTermsExpanded],
    requireSansSucre,
    isSubstitution,
    isAdverse,
    isContraindication,
    requireOtc,
    wantsHospital,
    isPediatric,
    isPregnancy,
    detectedBrands,
    inferredSubTerms: [...new Set(inferredSubTerms)],
    morphTerms: [...new Set(contentTerms.map(simpleStemFr))],
  };
}

module.exports = {
  GALENIC_SYNONYMS,
  LEXICON_V1,
  analyzeQuery,
};
