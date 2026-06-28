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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function queryTerms(query) {
  return tokenizeSearchText(query).map((term) => normalizeSearchText(term)).filter(Boolean);
}

function termMatchesAsWord(haystack, term) {
  const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(term)}(?:[^a-z0-9]|$)`);
  return re.test(haystack);
}

/**
 * Classement match_quality : couverture des termes de la requête dans le libellé
 * (plus fiable que l'égalité de la chaîne entière seule).
 * - exact : libellé égal à la requête, identifiant (CIS/num) égal, ou tous les termes en mots entiers
 * - prefix : commence par la requête ou par le 1er terme avec tous les termes présents
 * - fuzzy : match MiniSearch (typo / terme partiel) sans couverture complète
 *
 * Idée non implémentée : rejeter ou restreindre les requêtes trop "code", par ex. seulement
 * numériques ou alphanumériques très courts.
 */
function computeMatchPriority(primaryValue, query, { idValue = '' } = {}) {
  const normalizedQuery = normalizeSearchText(query);
  const terms = queryTerms(query);
  if (!terms.length) return 0;

  const value = normalizeSearchText(primaryValue);
  const normalizedId = normalizeSearchText(idValue);

  if (value === normalizedQuery || normalizedId === normalizedQuery) return 2;
  if (value.startsWith(normalizedQuery) || normalizedId.startsWith(normalizedQuery)) return 1;

  const haystack = value || normalizedId;
  if (!haystack) return 0;

  const allTermsPresent = terms.every((term) => haystack.includes(term));
  if (!allTermsPresent) return 0;

  if (terms.every((term) => termMatchesAsWord(haystack, term))) {
    return value === normalizedQuery ? 2 : 1;
  }

  if (haystack.startsWith(terms[0])) return 1;

  return 0;
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
  computeMatchPriority,
  matchQualityFromPriority,
  isStrongMatchQuality,
  queryTerms,
  MATCH_QUALITY_RANK,
  MATCH_VIA_RANK
};
