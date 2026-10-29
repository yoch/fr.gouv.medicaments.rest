const { AND } = require('@yoch/frozenminisearch');

const MATCH_QUALITY = ['fuzzy', 'prefix', 'exact'];
const SPACE_OR_PUNCTUATION = /[\s\p{P}]+/u;

function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function tokenizeSearchText(value) {
  return String(value ?? '').split(SPACE_OR_PUNCTUATION).filter(Boolean);
}

function queryTerms(query) {
  return tokenizeSearchText(query).map((term) => normalizeSearchText(term)).filter(Boolean);
}

const DROPPED = 0;
const UNFOLDABLE = 0xffff;
const UNKNOWN = 0xfffe;

/**
 * normalizeSearchText caractère par caractère : code replié, DROPPED pour un
 * accent supprimé, UNFOLDABLE quand le résultat dépend du contexte (sigma final,
 * marque combinante conservée que NFD peut réordonner, surrogate) ou fait
 * plusieurs caractères. Un texte UNFOLDABLE passe par la normalisation complète.
 */
function computeFold(code) {
  const folded = normalizeSearchText(String.fromCharCode(code));
  if (folded.length === 0) return DROPPED;
  if (
    folded.length > 1 ||
    code === 0 ||
    code === 0x03a3 ||
    code >= 0xfffe ||
    (code >= 0xd800 && code <= 0xdfff) ||
    /\p{M}/u.test(folded)
  ) {
    return UNFOLDABLE;
  }
  return folded.charCodeAt(0);
}

// Remplie à la première rencontre de chaque caractère, par isFoldable : les
// autres fonctions ne reçoivent que des textes déjà acceptés par isFoldable.
const FOLD = new Uint16Array(0x10000).fill(UNKNOWN);

function isFoldable(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    let folded = FOLD[code];
    if (folded === UNKNOWN) folded = FOLD[code] = computeFold(code);
    if (folded === UNFOLDABLE) return false;
  }
  return true;
}

function foldedLength(text) {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    if (FOLD[text.charCodeAt(i)] !== DROPPED) length++;
  }
  return length;
}

/** Index qui suit la correspondance de `pattern` (normalisé) dans `text` replié à partir de `start`, sinon -1. */
function matchFoldedAt(text, start, pattern) {
  let i = start;
  for (let j = 0; j < pattern.length; i++) {
    if (i >= text.length) return -1;
    const folded = FOLD[text.charCodeAt(i)];
    if (folded === DROPPED) continue;
    if (folded !== pattern.charCodeAt(j)) return -1;
    j++;
  }
  return i;
}

function isWordCode(code) {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39);
}

function foldedBefore(text, index) {
  for (let i = index - 1; i >= 0; i--) {
    const folded = FOLD[text.charCodeAt(i)];
    if (folded !== DROPPED) return folded;
  }
  return -1;
}

function foldedFrom(text, index) {
  for (let i = index; i < text.length; i++) {
    const folded = FOLD[text.charCodeAt(i)];
    if (folded !== DROPPED) return folded;
  }
  return -1;
}

function containsFolded(text, term, wholeWord) {
  for (let i = 0; i < text.length; i++) {
    if (FOLD[text.charCodeAt(i)] === DROPPED) continue;
    const end = matchFoldedAt(text, i, term);
    if (end < 0) continue;
    if (!wholeWord || (!isWordCode(foldedBefore(text, i)) && !isWordCode(foldedFrom(text, end)))) {
      return true;
    }
  }
  return false;
}

function hasNormalizedWholeWord(haystack, term) {
  let idx = 0;
  while ((idx = haystack.indexOf(term, idx)) !== -1) {
    const prev = idx > 0 ? haystack.charCodeAt(idx - 1) : -1;
    const next = idx + term.length < haystack.length ? haystack.charCodeAt(idx + term.length) : -1;
    if (!isWordCode(prev) && !isWordCode(next)) return true;
    idx++;
  }
  return false;
}

function codeEqualsQuery(codeValue, normalizedQuery) {
  const code = String(codeValue);
  if (!isFoldable(code)) return normalizeSearchText(code) === normalizedQuery;
  return foldedLength(code) === normalizedQuery.length && matchFoldedAt(code, 0, normalizedQuery) >= 0;
}

/**
 * Classement match_quality : couverture des termes de la requête dans le libellé
 * (plus fiable que l'égalité de la chaîne entière seule).
 * - exact : libellé égal à la requête ou code égal (CIS/num/CIP)
 * - prefix : commence par la requête, contient tous les termes en mots entiers,
 *   ou commence par le 1er terme avec tous les termes présents
 * - fuzzy : match MiniSearch (typo / terme partiel) sans couverture complète
 *
 * La requête est normalisée une seule fois. Les libellés sont comparés repliés,
 * sans créer de chaîne normalisée par candidat.
 */
function createMatchPriorityClassifier(query) {
  const normalizedQuery = normalizeSearchText(query);
  const terms = queryTerms(query);

  function classifyNormalized(primaryValue, idValue, codeValues) {
    const value = normalizeSearchText(primaryValue);
    const normalizedId = normalizeSearchText(idValue);

    if (value === normalizedQuery || normalizedId === normalizedQuery) return 2;
    for (const codeValue of codeValues) {
      if (normalizeSearchText(codeValue) === normalizedQuery) return 2;
    }
    if (value.startsWith(normalizedQuery)) return 1;

    const haystack = value || normalizedId;
    if (!haystack) return 0;

    const allTermsPresent = terms.every((term) => haystack.includes(term));
    if (!allTermsPresent) return 0;

    if (terms.every((term) => hasNormalizedWholeWord(haystack, term))) return 1;

    if (haystack.startsWith(terms[0])) return 1;

    return 0;
  }

  return (primaryValue, { idValue = '', codeValues = [] } = {}) => {
    if (!terms.length) return 0;

    const value = String(primaryValue ?? '');
    const id = String(idValue ?? '');
    if (!isFoldable(value) || !isFoldable(id)) return classifyNormalized(value, id, codeValues);

    const valueLength = foldedLength(value);
    const idLength = foldedLength(id);
    const queryLength = normalizedQuery.length;
    if (valueLength === queryLength && matchFoldedAt(value, 0, normalizedQuery) >= 0) return 2;
    if (idLength === queryLength && matchFoldedAt(id, 0, normalizedQuery) >= 0) return 2;
    for (const codeValue of codeValues) {
      if (codeEqualsQuery(codeValue, normalizedQuery)) return 2;
    }
    if (matchFoldedAt(value, 0, normalizedQuery) >= 0) return 1;

    const haystack = valueLength > 0 ? value : id;
    if (valueLength === 0 && idLength === 0) return 0;

    for (const term of terms) {
      if (!containsFolded(haystack, term, false)) return 0;
    }
    let allWholeWords = true;
    for (let k = 0; k < terms.length && allWholeWords; k++) {
      allWholeWords = containsFolded(haystack, terms[k], true);
    }
    if (allWholeWords) return 1;

    return matchFoldedAt(haystack, 0, terms[0]) >= 0 ? 1 : 0;
  };
}

function matchQualityFromPriority(priority) {
  return MATCH_QUALITY[priority];
}

function isStrongMatchQuality(matchQuality) {
  return matchQuality === 'exact' || matchQuality === 'prefix';
}

const miniSearchOptions = {
  tokenize: (text) => tokenizeSearchText(text),
  processTerm: (term) => normalizeSearchText(term),
  searchOptions: {
    tokenize: (text) => tokenizeSearchText(text),
    processTerm: (term) => normalizeSearchText(term),
    combineWith: AND,
    prefix: (term) => !/^\d+$/.test(term),
    fuzzy: (term) => (/^\d/.test(term) ? false : 0.2)
  }
};

const MATCH_QUALITY_RANK = { exact: 3, prefix: 2, fuzzy: 1 };
const MATCH_VIA_RANK = { cis: 4, num: 4, denomination: 3, presentation: 2, composition: 1 };

module.exports = {
  miniSearchOptions,
  normalizeSearchText,
  createMatchPriorityClassifier,
  matchQualityFromPriority,
  isStrongMatchQuality,
  queryTerms,
  MATCH_QUALITY_RANK,
  MATCH_VIA_RANK
};
