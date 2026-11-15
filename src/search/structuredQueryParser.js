'use strict';

/**
 * Interpréteur conservateur de requêtes pharmaceutiques (étape B1/B2).
 *
 * Produit une représentation typée et explicable à partir d'une requête texte
 * libre (`q`) et de critères explicites (`{ dosage, forme, voie }`).
 *
 * Invariants :
 *  - les paramètres explicites priment toujours (toute contradiction est signalée);
 *  - un code numérique (CIS/CIP/GTIN/num) ou ATC/ATCvet est routé en exact sans altération;
 *  - aucun nombre dépourvu d'unité pharmaceutique n'est supprimé du nom
 *    (préserve `MAG 2 100 mg`, `VITAMINE D3`, `OMEGA 3`, `B12`, etc.);
 *  - aucune normalisation de concentration non unitaire (`mg/0,4 ml` ≠ `mg/ml`).
 */

const { normalizeSearchText } = require('../utils/searchRanking');
const { parseDosageTokens } = require('../utils/structuredSearchCriteria');
const { significantFormeTokens, canonicalizeVoieEntry, extractVoieEntries } = require('./galenicVocab');
const { VERBATIM_SANS_QUALIFIER_WORDS } = require('./queryIntentGuard');

const PHARMA_ALIASES = Object.freeze([
  // Voies d'administration (source: usages pharmaceutiques courants / ANSM)
  { pattern: /\bper\s+os\b|\bvoie\s+orale\b|\bpo\b/g, kind: 'voie', value: 'orale', source: 'galenic_abbrev', expandForme: null },
  { pattern: /\bintraveineux\b|\bintraveineuse\b|\biv\b/g, kind: 'voie', value: 'intraveineuse', source: 'galenic_abbrev', expandForme: ['injectable', 'perfusion'] },
  { pattern: /\bintramusculaire\b|\bim\b/g, kind: 'voie', value: 'intramusculaire', source: 'galenic_abbrev', expandForme: ['injectable'] },
  { pattern: /\bsous[\s-]cutane[e]?\b|\bsc\b/g, kind: 'voie', value: 'sous-cutanee', source: 'galenic_abbrev', expandForme: ['injectable', 'seringue', 'stylo'] },
  { pattern: /\bophtalmique\b|\bgouttes?\s+(?:dans\s+les\s+|pour\s+les\s+|aux\s+)?yeux\b|\byeux\b/g, kind: 'voie', value: 'ophtalmique', source: 'patient_galenic', expandForme: ['collyre'] },
  { pattern: /\bauriculaire\b|\boreille[s]?\b/g, kind: 'voie', value: 'auriculaire', source: 'patient_galenic', expandForme: ['instillation auriculaire', 'auriculaire'] },
  { pattern: /\bnasal[e]?\b|\bnez\b/g, kind: 'voie', value: 'nasale', source: 'patient_galenic', expandForme: ['pulverisation nasale', 'nasal'] },
  { pattern: /\brectal[e]?\b/g, kind: 'voie', value: 'rectale', source: 'bdpm_voie', expandForme: ['suppositoire'] },
  { pattern: /\bvaginal[e]?\b/g, kind: 'voie', value: 'vaginale', source: 'bdpm_voie', expandForme: ['ovule', 'capsule vaginale'] },
  { pattern: /\bsous\s+la\s+langue\b|\bfond\s+sous\s+la\s+langue\b|\bsublingual[e]?\b/g, kind: 'voie', value: 'sublinguale', source: 'patient_galenic', expandForme: ['lyophilisat', 'sublingual', 'orodispersible'] },
  { pattern: /\btransdermique\b/g, kind: 'voie', value: 'transdermique', source: 'bdpm_voie', expandForme: ['dispositif transdermique', 'patch'] },

  // Formes galéniques & conditionnements courants
  { pattern: /\bsol(?:ution)?\s+buv(?:able)?\b/g, kind: 'forme', value: 'solution buvable', source: 'galenic_abbrev' },
  { pattern: /\bsol(?:ution)?\s+inj(?:ectable)?\b/g, kind: 'forme', value: 'solution injectable', source: 'galenic_abbrev' },
  { pattern: /\bpdr\b/g, kind: 'forme', value: 'poudre', source: 'galenic_abbrev' },
  { pattern: /\b(?:cpr|cp|comp|cachets?)\b/g, kind: 'forme', value: 'comprime', source: 'patient_galenic' },
  { pattern: /\b(?:suppo|suppositoires?)\b/g, kind: 'forme', value: 'suppositoire', source: 'galenic_abbrev' },
  { pattern: /\b(?:coll|collyres?)\b/g, kind: 'forme', value: 'collyre', source: 'galenic_abbrev' },
  { pattern: /\b(?:sach|sachets?)\b/g, kind: 'forme', value: 'sachet', source: 'galenic_abbrev' },
  { pattern: /\b(?:amp|ampoules?)\b/g, kind: 'forme', value: 'ampoule', source: 'galenic_abbrev' },
  { pattern: /\b(?:fl|flacons?)\b/g, kind: 'forme', value: 'flacon', source: 'galenic_abbrev' },
  { pattern: /\b(?:piqures?|injections?|injectables?)\b/g, kind: 'forme', value: 'injectable', source: 'patient_galenic', altTokens: ['seringue', 'stylo', 'solution injectable', 'perfusion'] },
  { pattern: /\bpatchs?\b/g, kind: 'forme', value: 'transdermique', source: 'patient_galenic', altTokens: ['dispositif'] },
  { pattern: /\bspray[s]?\b|\bpulv(?:erisation)?\b/g, kind: 'forme', value: 'pulverisation', source: 'patient_galenic', altTokens: ['instillation', 'flacon', 'solution pour', 'spray'] },
  { pattern: /\bsirop[s]?\b/g, kind: 'forme', value: 'sirop', source: 'patient_galenic', altTokens: ['solution buvable', 'suspension buvable'] },
  { pattern: /\bgouttes?\b/g, kind: 'forme', value: 'gouttes', source: 'patient_galenic', altTokens: ['solution buvable', 'instillation', 'collyre'] },
  { pattern: /\b(?:oro|orodispersibles?|lyocs?|qui\s+fond(?:\s+dans\s+la\s+bouche)?)\b/g, kind: 'qualifier', value: 'orodispersible', source: 'patient_galenic', altTokens: ['lyophilisat'] },
  { pattern: /\b(?:eff|effervescents?)\b/g, kind: 'qualifier', value: 'effervescent', source: 'galenic_abbrev' },
  { pattern: /\b(?:lp|retard|prolonge[e]?)\b/g, kind: 'qualifier', value: 'liberation prolongee', source: 'galenic_abbrev' },
  { pattern: /\bpellicule[es]?\b/g, kind: 'qualifier', value: 'pellicule', source: 'bdpm_forme' },
  { pattern: /\ba\s+croquer\b|\bcroquer\b/g, kind: 'qualifier', value: 'a croquer', source: 'bdpm_forme' },
  ...VERBATIM_SANS_QUALIFIER_WORDS.map((w) => ({
    pattern: new RegExp(`\\bsans\\s+(?:de\\s+|d\\s+)?${w}${w.endsWith('s') ? '' : 's?'}\\b`, 'g'),
    kind: 'qualifier',
    value: `sans ${w}`,
    source: 'bdpm_verbatim_sans'
  })),

  // Qualificatifs d'intention non-clinique (équivalence générique)
  { pattern: /\b(?:generiques?|equivalents?)\b(?:\s+d[eu']|\s+d')?/g, kind: 'intent', value: 'generic_equivalent', source: 'bdpm_gener_intent' }
]);

const CHAINED_VERBATIM_NI_RE = new RegExp(
  `\\bni\\s+(?=(?:de\\s+|d\\s+)?(?:${VERBATIM_SANS_QUALIFIER_WORDS.map((w) => (w.endsWith('s') ? w : `${w}s?`)).join('|')})\\b)`,
  'g'
);

const STOP_WORDS_FR = new Set([
  'de', 'du', 'des', 'd', 'le', 'la', 'les', 'l', 'un', 'une', 'en', 'pour', 'par',
  'avec', 'dans', 'sur', 'au', 'aux', 'a', 'et', 'ou'
]);

const STANDALONE_UNIT_PATTERN =
  '(?:microgrammes?|µg|μg|mcg|ug|mg|gr?|ml|cl|l|ui|u\\.?i\\.?|mui|kui|unites?|doses?|%|pour\\s+cent|mbq|gbq|mmol|meq|ch|dh|heures?|h)';

const DENOM_UNIT_PATTERN =
  '(?:microgrammes?|µg|μg|mcg|ug|mg|gr?|kg|ml|cl|l|ui|u\\.?i\\.?|mui|kui|unites?|doses?|%|pour\\s+cent|mbq|gbq|mmol|meq|ch|dh|heures?|h)';

const UNIT_PATTERN = STANDALONE_UNIT_PATTERN;

const COMPOUND_DOSAGE_RE = new RegExp(
  `(?:^|[\\s(/])(\\d+(?:[.,]\\d+)?)\\s*(${STANDALONE_UNIT_PATTERN})\\s*\\/\\s*(?:(\\d+(?:[.,]\\d+)?)\\s*)?(${DENOM_UNIT_PATTERN})(?=$|[\\s),;+])`,
  'gi'
);

const SINGLE_DOSAGE_RE = new RegExp(
  `(?:^|[\\s(/])(\\d+(?:[.,]\\d+)?)\\s*(${STANDALONE_UNIT_PATTERN})(?=$|[\\s),;+/])`,
  'gi'
);

// Délimiteurs (zone d'usage privé Unicode) d'un composé de dosage conservé tel quel
const KEPT_OPEN = '\uE000';
const KEPT_CLOSE = '\uE001';
const KEPT_COMPOUND_RE = /\uE000(\d+)\uE001/g;

function normalizeGluedUnits(text) {
  let s = String(text || '');
  // Espacer uniquement les milliers stricts (groupes de '000') devant unité pharma
  // Préserve strictement 'MAG 2 100 mg' (car '100' != '000') !
  s = s.replace(/\b(\d{1,3}(?:[\s\u00a0.]000)+)\s*(ui|u\.?i\.?|unites?|mg|g|ml|microgrammes?|µg|ug|mcg)\b/gi, (_, num, u) => {
    return `${num.replace(/[\s\u00a0.]/g, '')} ${u}`;
  });
  // Séparer nom collé à un dosage avec unité ('esoméprazole40mg', 'doliprane1g')
  s = s.replace(
    new RegExp(`([a-zà-öø-ÿ]{2,})(\\d+(?:[.,]\\d+)?\\s*(?:${UNIT_PATTERN})(?=$|[\\s),;+/]))`, 'gi'),
    '$1 $2'
  );
  // Séparer nom collé à un dosage numérique 2-4 chiffres sans unité ('doliprane1000', 'ibuprofene400')
  s = s.replace(/([a-zà-öø-ÿ]{3,})(\d{2,4}(?:[.,]\d+)?(?=$|\s))/gi, '$1 $2');
  return s;
}

function normalizeUnitString(rawUnit) {
  const u = normalizeSearchText(rawUnit).replace(/\./g, '').replace(/\s+/g, ' ').trim();
  if (u === 'µg' || u === 'μg' || u === 'ug' || u === 'mcg' || u === 'microgramme') return 'microgrammes';
  if (u === 'gr') return 'g';
  if (u === 'pour cent') return '%';
  if (u === 'ui' || u === 'u i' || u === 'unite' || u === 'unites') return 'ui';
  if (u === 'dose' || u === 'doses') return 'dose';
  if (u === 'heure' || u === 'heures' || u === 'h') return 'h';
  if (u === 'mui') return 'mui_expand';
  return u;
}

function canonicalizeDosageSpan(numStr, unitStr) {
  const unit = normalizeUnitString(unitStr);
  if (unit === 'mui_expand') {
    const num = Number(numStr.replace(',', '.')) * 1000000;
    return `${num} ui`;
  }
  return `${numStr.replace(',', '.')} ${unit}`;
}

function isExactIdentifierQuery(trimmed) {
  if (/^\d{6,14}$/.test(trimmed)) return { kind: 'numeric_code', code: trimmed };
  if (/^Q?[A-Z]\d{2}(?:[A-Z]{1,2}\d{0,2})?$/i.test(trimmed)) return { kind: 'atc_code', code: trimmed.toUpperCase() };
  return null;
}

/**
 * Construit les ensembles taxonomiques autorisés à partir du corpus chargé.
 */
function buildTaxonomyVocab(bdpmCorpus, vetCorpus) {
  const formeSingle = new Set();
  const formeMulti = new Set();
  const voieSingle = new Set();
  const voieMulti = new Set();
  const speciesTokens = new Map(); // normalized word -> canonical singular

  function indexPhrase(phrase, singleSet, multiSet) {
    const norm = normalizeSearchText(phrase).replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!norm) return;
    const words = norm.split(' ').filter(Boolean);
    if (words.length >= 2 && words.length <= 4) multiSet.add(words.join(' '));
    for (const w of words) {
      if (w.length >= 4 && !STOP_WORDS_FR.has(w)) singleSet.add(w);
    }
  }

  for (const s of bdpmCorpus.specialites || []) {
    if (s.forme_pharma) indexPhrase(s.forme_pharma, formeSingle, formeMulti);
    if (s.voies_admin) {
      for (const v of String(s.voies_admin).split(';')) {
        indexPhrase(v, voieSingle, voieMulti);
      }
    }
  }
  for (const m of (vetCorpus && vetCorpus.medicaments) || []) {
    if (m.forme_pharmaceutique) indexPhrase(m.forme_pharmaceutique, formeSingle, formeMulti);
    for (const esp of m.especes || []) {
      const ne = normalizeSearchText(esp).trim();
      if (!ne || ne.length < 3) continue;
      let singular = ne;
      if (ne.endsWith('aux') && ne.length > 4) singular = `${ne.slice(0, -3)}al`;
      else if (ne.endsWith('s') && ne.length > 3) singular = ne.slice(0, -1);
      speciesTokens.set(singular, singular);
      speciesTokens.set(ne, singular);
      speciesTokens.set(`${singular}s`, singular);
      if (singular.endsWith('al')) speciesTokens.set(`${singular.slice(0, -1)}ux`, singular);
    }
  }
  // Exclure quelques adjectifs trop génériques qui peuvent apparaître dans des noms de marques
  for (const ambiguous of ['solution', 'poudre', 'suspension', 'autre', 'pour', 'usage', 'voie', 'simple', 'huile', 'pate']) {
    formeSingle.delete(ambiguous);
    voieSingle.delete(ambiguous);
  }

  return {
    formeSingle,
    formeMulti: [...formeMulti].sort((a, b) => b.length - a.length),
    voieSingle,
    voieMulti: [...voieMulti].sort((a, b) => b.length - a.length),
    speciesTokens
  };
}

function compactText(value) {
  return normalizeSearchText(value).replace(/\s+/g, '');
}

// `10 mg/1 ml` = `10 mg/ml` : un volume unitaire écrit équivaut à la concentration par ml
function dosageTokensForComparison(value) {
  const tokens = parseDosageTokens(value);
  const vols = tokens.filter((t) => t.unit === 'ml');
  if (/\//.test(value) && vols.length === 1 && vols[0].amount === 1 && tokens.length === 2) {
    const other = tokens.find((t) => t.unit !== 'ml');
    if (other.unit === 'mg' || other.unit === 'ui') return [{ amount: other.amount, unit: `${other.unit}/ml` }];
  }
  return tokens;
}

// « / » suivi d'une base de rapport (volume, masse ou poids de référence), avec ou sans quantité
const CONCENTRATION_RE = /\/\s*(?:\d+(?:[.,]\d+)?\s*)?(?:ml|l|kg|g|dose|doses|h|heures?)(?![\p{L}])/iu;

function isConcentration(value) {
  return CONCENTRATION_RE.test(normalizeSearchText(value));
}

function sameDosageValue(explicitValue, parsedValue) {
  const a = dosageTokensForComparison(explicitValue);
  const b = dosageTokensForComparison(parsedValue);
  if (a.length === 0 || b.length === 0) return compactText(explicitValue) === compactText(parsedValue);
  // Une concentration (`12,5 mg/kg`, `10 mg/0,4 ml`) n'équivaut pas à une quantité nue ;
  // une association (`500 mg/30 mg`) équivaut à la liste `500 mg 30 mg`.
  if (isConcentration(explicitValue) !== isConcentration(parsedValue)) return false;
  if (a.length !== b.length) return false;
  const byUnitThenAmount = (x, y) => (x.unit === y.unit ? x.amount - y.amount : (x.unit < y.unit ? -1 : 1));
  const sa = [...a].sort(byUnitThenAmount);
  const sb = [...b].sort(byUnitThenAmount);
  return sa.every((t, i) =>
    t.unit === sb[i].unit &&
    Math.abs(t.amount - sb[i].amount) <= Math.max(t.amount, sb[i].amount) * 1e-6
  );
}

function sameTokenSet(a, b) {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((t) => sb.has(t));
}

function sameFormeValue(explicitValue, parsedValue) {
  return sameTokenSet(significantFormeTokens(explicitValue), significantFormeTokens(parsedValue));
}

function sameVoieValue(explicitValue, parsedVoies) {
  const parsedEntries = [...new Set(parsedVoies.map(canonicalizeVoieEntry).filter(Boolean))];
  return sameTokenSet(extractVoieEntries(explicitValue), parsedEntries);
}

/**
 * Interprète une requête utilisateur sans perte silencieuse.
 * @param {string} rawQuery
 * @param {{ dosage?: string|null, forme?: string|null, voie?: string|null }} explicitCriteria
 * @param {object} taxonomy
 * @param {{ useAliases?: boolean }} [options]
 */
function parseStructuredQuery(rawQuery, explicitCriteria = {}, taxonomy = null, { useAliases = false } = {}) {
  const raw = String(rawQuery || '').trim();
  const explicit = {
    dosage: explicitCriteria?.dosage ? String(explicitCriteria.dosage).trim() : null,
    forme: explicitCriteria?.forme ? String(explicitCriteria.forme).trim() : null,
    voie: explicitCriteria?.voie ? String(explicitCriteria.voie).trim() : null
  };

  const codeMatch = isExactIdentifierQuery(raw);
  if (codeMatch) {
    return {
      raw,
      kind: 'exact_code',
      code: codeMatch,
      nameTokens: [normalizeSearchText(raw)],
      nameQuery: raw,
      extracted: {
        dosages: [],
        formes: [],
        voies: [],
        qualifiers: [],
        species: [],
        intents: [],
        altFormeTokens: []
      },
      effectiveCriteria: {
        ...explicit,
        qualifiers: [],
        species: [],
        altFormeTokens: []
      },
      explicitOverrides: {
        dosage: Boolean(explicit.dosage),
        forme: Boolean(explicit.forme),
        voie: Boolean(explicit.voie)
      },
      conflicts: [],
      provenance: [{ span: raw, role: codeMatch.kind, source: 'exact_pattern' }]
    };
  }

  const provenance = [];
  const extractedDosages = [];
  const extractedFormes = [];
  const extractedVoies = [];
  const extractedQualifiers = [];
  const extractedSpecies = [];
  const intents = [];
  const altFormeFromForme = [];
  const altFormeFromVoie = [];
  const altFormeFromQualifier = [];

  let working = normalizeGluedUnits(raw);

  // 1. Extraction des dosages / concentrations avec unité explicite
  const keptCompounds = [];
  COMPOUND_DOSAGE_RE.lastIndex = 0;
  // Un span n'est retiré du nom que s'il produit une quantité comparable : une
  // unité non interprétée (`9 ch`, `10 cl`, `2 mmol`) reste dans la requête lexicale
  // plutôt que de devenir un critère « unsupported » qui perdrait l'information.
  working = working.replace(COMPOUND_DOSAGE_RE, (full, n1, u1, n2, u2) => {
    const left = canonicalizeDosageSpan(n1, u1);
    const right = n2 ? canonicalizeDosageSpan(n2, u2) : normalizeUnitString(u2);
    const span = `${left}/${right}`;
    // Le numérateur doit être interprétable à lui seul (`5 mmol/10 ml` ≠ `10 ml`).
    // Le composé conservé est remplacé par un jeton opaque pour que la passe simple
    // ne capture pas son dénominateur seul ; il est restitué juste après.
    if (parseDosageTokens(left).length === 0) {
      const lead = /^[\s(/]/.test(full) ? full[0] : '';
      keptCompounds.push(full.slice(lead.length));
      return `${lead}${KEPT_OPEN}${keptCompounds.length - 1}${KEPT_CLOSE}`;
    }
    extractedDosages.push(span);
    provenance.push({ span: full.trim(), role: 'dosage_compound', value: span, source: 'unit_regex' });
    return ' ';
  });

  SINGLE_DOSAGE_RE.lastIndex = 0;
  working = working.replace(SINGLE_DOSAGE_RE, (full, n1, u1) => {
    const span = canonicalizeDosageSpan(n1, u1);
    if (parseDosageTokens(span).length === 0) return full;
    extractedDosages.push(span);
    provenance.push({ span: full.trim(), role: 'dosage_single', value: span, source: 'unit_regex' });
    return ' ';
  });
  working = working.replace(KEPT_COMPOUND_RE, (_, idx) => keptCompounds[Number(idx)]);

  // Normalisation douce pour les vocabulaires forme/voie/espèces
  let normWork = normalizeSearchText(working)
    .replace(/['’]/g, ' ')
    .replace(/[,;()/+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 2. Alias pharmaceutiques traçables (B2 uniquement)
  if (useAliases) {
    // « sans sucre ni conservateur » : la suite « ni <qualificatif littéral> » vaut
    // « sans <qualificatif littéral> » (le garde-fou n'accepte « ni » qu'enchaîné ainsi).
    normWork = normWork.replace(CHAINED_VERBATIM_NI_RE, 'sans ');
    for (const rule of PHARMA_ALIASES) {
      rule.pattern.lastIndex = 0;
      if (!rule.pattern.test(normWork)) continue;
      rule.pattern.lastIndex = 0;
      const nextWork = normWork.replace(rule.pattern, ' ').replace(/\s+/g, ' ').trim();
      // Ne jamais vider la requête en supprimant un alias ambigu (ex. mot unique "patch" ou "spray").
      // Un qualificatif littéral reste alors dans le texte mais est tout de même extrait.
      if (!nextWork) {
        if (rule.source === 'bdpm_verbatim_sans') {
          extractedQualifiers.push(rule.value);
          provenance.push({ span: rule.value, role: rule.kind, value: rule.value, source: rule.source });
        }
        continue;
      }
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(normWork)) !== null) {
        provenance.push({ span: match[0].trim(), role: rule.kind, value: rule.value, source: rule.source });
      }
      normWork = nextWork;
      if (rule.kind === 'voie') {
        extractedVoies.push(rule.value);
        if (rule.expandForme) altFormeFromVoie.push(...rule.expandForme);
      } else if (rule.kind === 'forme') {
        extractedFormes.push(rule.value);
        if (rule.altTokens) altFormeFromForme.push(...rule.altTokens);
      } else if (rule.kind === 'qualifier') {
        extractedQualifiers.push(rule.value);
        if (rule.altTokens) altFormeFromQualifier.push(...rule.altTokens);
      } else if (rule.kind === 'intent') {
        intents.push(rule.value);
      }
    }
  }

  // 3. Expressions composées issues de la taxonomie BDPM / ANMV
  if (taxonomy) {
    for (const phrase of taxonomy.formeMulti) {
      // Préfiltre bon marché : n'instancier la RegExp que si l'expression est présente
      if (!normWork.includes(phrase)) continue;
      const re = new RegExp(`(?:^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|\\s)`, 'g');
      if (re.test(normWork)) {
        const remaining = normWork.replace(re, ' ').replace(/\s+/g, ' ').trim();
        if (remaining.length > 0) {
          normWork = remaining;
          extractedFormes.push(phrase);
          provenance.push({ span: phrase, role: 'forme', value: phrase, source: 'bdpm_taxonomy' });
        }
      }
    }
    for (const phrase of taxonomy.voieMulti) {
      // Préfiltre bon marché : n'instancier la RegExp que si l'expression est présente
      if (!normWork.includes(phrase)) continue;
      const re = new RegExp(`(?:^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|\\s)`, 'g');
      if (re.test(normWork)) {
        const remaining = normWork.replace(re, ' ').replace(/\s+/g, ' ').trim();
        if (remaining.length > 0) {
          normWork = remaining;
          extractedVoies.push(phrase);
          provenance.push({ span: phrase, role: 'voie', value: phrase, source: 'bdpm_taxonomy' });
        }
      }
    }
  }

  // 4. Tokenisation restante : extraire forme/voie/espèce simples seulement s'il reste un cœur lexical
  const rawTokens = normWork.split(/\s+/).filter(Boolean);
  const keptTokens = [];
  for (let i = 0; i < rawTokens.length; i++) {
    const tok = rawTokens[i];
    const isVitaminLetter = ['a', 'd', 'e', 'k'].includes(tok) && rawTokens.some((t) => t.startsWith('vitamin'));
    const isCodeLetter = i === 0 && tok.length === 1 && /^\d+$/.test(rawTokens[1] || '');
    if (STOP_WORDS_FR.has(tok) && !isVitaminLetter && !isCodeLetter) {
      // Garde 'a'/'d' si 'vitamine' ou marque à préfixe numérique ('A 313') est présent
      continue;
    }
    // On extrait un mot simple forme/voie/espèce uniquement si d'autres mots non vides restent pour le médicament
    const hasRemainingSubstantive = keptTokens.length > 0 || rawTokens.slice(i + 1).some((t) =>
      !STOP_WORDS_FR.has(t) &&
      !(taxonomy?.formeSingle?.has(t)) &&
      !(taxonomy?.voieSingle?.has(t)) &&
      !(taxonomy?.speciesTokens?.has(t))
    );

    if (taxonomy && hasRemainingSubstantive) {
      if (taxonomy.speciesTokens.has(tok)) {
        const canonical = taxonomy.speciesTokens.get(tok);
        extractedSpecies.push(canonical);
        provenance.push({ span: tok, role: 'species', value: canonical, source: 'anmv_taxonomy' });
        continue;
      }
      if (taxonomy.formeSingle.has(tok)) {
        extractedFormes.push(tok);
        provenance.push({ span: tok, role: 'forme', value: tok, source: 'bdpm_taxonomy' });
        continue;
      }
      if (taxonomy.voieSingle.has(tok)) {
        extractedVoies.push(tok);
        provenance.push({ span: tok, role: 'voie', value: tok, source: 'bdpm_taxonomy' });
        continue;
      }
    }
    keptTokens.push(tok);
  }

  // Filet de sécurité : si aucun token nom/substance ne subsiste, restaurer les mots initiaux
  const finalNameTokens = keptTokens.length > 0 ? keptTokens : rawTokens;

  // Précédence stricte des paramètres explicites + détection visible de conflits
  // (comparaison sur les valeurs interprétées, pas sur l'écriture : `500mg` = `500 mg`,
  // `1 g` = `1000 mg`, `comprimés` = `comprime`, `voie orale` = `per os`)
  const conflicts = [];
  const parsedDosage = extractedDosages.join(' ');
  const effDosage = explicit.dosage || (extractedDosages.length > 0 ? parsedDosage : null);
  if (explicit.dosage && extractedDosages.length > 0 && !sameDosageValue(explicit.dosage, parsedDosage)) {
    conflicts.push({ field: 'dosage', explicit: explicit.dosage, parsed: parsedDosage });
  }
  const parsedForme = extractedFormes.join(' ');
  const effForme = explicit.forme || (extractedFormes.length > 0 ? parsedForme : null);
  if (explicit.forme && extractedFormes.length > 0 && !sameFormeValue(explicit.forme, parsedForme)) {
    conflicts.push({ field: 'forme', explicit: explicit.forme, parsed: parsedForme });
  }
  const parsedVoie = extractedVoies.join(' ');
  const effVoie = explicit.voie || (extractedVoies.length > 0 ? parsedVoie : null);
  if (explicit.voie && extractedVoies.length > 0 && !sameVoieValue(explicit.voie, extractedVoies)) {
    conflicts.push({ field: 'voie', explicit: explicit.voie, parsed: parsedVoie });
  }

  const rawAltFormeTokens = [...new Set([
    ...altFormeFromForme,
    ...altFormeFromVoie,
    ...altFormeFromQualifier
  ])];
  // Precedence stricte : un param explicite `forme` annule toute expansion derivee du texte.
  const effectiveAltFormeTokens = explicit.forme
    ? []
    : [...new Set([
      ...altFormeFromForme,
      ...(explicit.voie ? [] : altFormeFromVoie),
      ...altFormeFromQualifier
    ])];

  return {
    raw,
    kind: 'structured',
    code: null,
    nameTokens: finalNameTokens,
    nameQuery: finalNameTokens.join(' '),
    explicitOverrides: {
      dosage: Boolean(explicit.dosage),
      forme: Boolean(explicit.forme),
      voie: Boolean(explicit.voie)
    },
    extracted: {
      dosages: extractedDosages,
      formes: extractedFormes,
      voies: extractedVoies,
      qualifiers: extractedQualifiers,
      species: extractedSpecies,
      intents,
      altFormeTokens: rawAltFormeTokens
    },
    effectiveCriteria: {
      dosage: effDosage,
      forme: effForme,
      voie: effVoie,
      qualifiers: extractedQualifiers,
      species: extractedSpecies,
      altFormeTokens: effectiveAltFormeTokens
    },
    conflicts,
    provenance
  };
}

module.exports = {
  buildTaxonomyVocab,
  parseStructuredQuery
};
