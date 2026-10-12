'use strict';

/**
 * Nettoyage des textes sources (BDPM, dictionnaire et produits ANMV) au
 * chargement, avant stockage et indexation. Les fichiers contiennent du HTML
 * (`<br>`, `<sup>`, `<p>`), des entités, des caractères Windows-1252 décodés
 * en Latin-1 (U+0092 au lieu d'une apostrophe, U+0095 au lieu d'une puce), des
 * `¿` à la place d'apostrophes et des espaces parasites.
 */

// Windows-1252 0x80–0x9F. Les apostrophes deviennent `'`, l'apostrophe
// majoritaire du corpus ; les positions non attribuées sont supprimées.
const CP1252 = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: "'",
  0x92: "'", 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜',
  0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ'
};

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: "'", lsquo: "'", rdquo: '”', ldquo: '“', laquo: '«', raquo: '»',
  hellip: '…', ndash: '–', mdash: '—', bull: '•', deg: '°', micro: 'µ',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â',
  ccedil: 'ç', icirc: 'î', iuml: 'ï', ocirc: 'ô', ugrave: 'ù', ucirc: 'û',
  uuml: 'ü', oelig: 'œ', reg: '®', trade: '™', copy: '©', plusmn: '±',
  times: '×', ge: '≥', le: '≤', alpha: 'α', beta: 'β', gamma: 'γ'
};

const SUPERSCRIPT = {
  0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹',
  '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ'
};
const SUBSCRIPT = {
  0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉',
  '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎'
};

const NEEDS_CLEANUP_CHAR =
  /[<&\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00a0\u00ad\u00bf\u2007\u2019\u202f\u200b-\u200d\u2060\ufeff\t\r\n]/;
const NEEDS_CLEANUP_SPACE = / [ ,.]/;
const ENTITY = /&(#\d+|#x[0-9a-f]+|[a-z]+);/gi;
const SCRIPT_TAG = /<(sup|sub)\b[^<>]*>([^<]*)<\/\1\s*>/gi;
const LINE_BREAK_TAG = /<br\s*\/?>|<\/?(?:p|div|li|ul|ol|tr|h[1-6])\b[^<>]*>/gi;
const ANY_TAG = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/gi;
const C1 = /[\u0080-\u009f]/g;
// `¿` remplace une apostrophe dans les élisions (« l¿enfant », « qu¿il ») ;
// ailleurs (« 3A¿G ») le caractère d'origine est inconnu et `¿` est gardé.
const ELISION = /(^|[^\p{L}])(c|d|j|l|m|n|s|t|qu|jusqu|lorsqu|puisqu|quoiqu)\u00bf(?=\p{L})/giu;
// Autres usages de `¿` relevés dans la BDPM : œ perdu, mutation génétique
// (« 711+3A>G »), espace avant ponctuation double, espace après une puce.
const QUESTION_MARK_FIXES = [
  [/\u00bf\u00bfil/g, "'œil"],
  [/\u00bf(?=dèmes?\b)/g, 'œ'],
  [/(?<=[0-9b][ACGT])\u00bf(?=[ACGT](?![a-z]))/g, '>'],
  [/\u00bf(?=[:;!?])/g, ' '],
  [/(?<=•)\u00bf/g, ' ']
];
const SOFT_HYPHEN_BULLET = /(^|\n)[ \t]*\u00ad+[ \t]*-?[ \t]*/g;
const QUESTION_MARK_BULLET = /(^|\n)[ \t]*\u00bf(?=[ \t])/g;
const CONTROL_BETWEEN_LETTERS = /(?<=\p{L})[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f](?=\p{L})/gu;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const INVISIBLE = /[\u00ad\u200b-\u200d\u2060\ufeff]/g;
const SPACE_LIKE = /[\t\u00a0\u2007\u202f]/g;

function decodeEntity(match, body) {
  if (body[0] === '#') {
    const code = body[1] === 'x' || body[1] === 'X'
      ? parseInt(body.slice(2), 16)
      : parseInt(body.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  }
  return NAMED_ENTITIES[body.toLowerCase()] ?? match;
}

// « 10<sup>6</sup> » doit devenir « 10⁶ » : retirer la balise seule donnerait « 106 ».
function replaceScriptTag(_match, tag, content) {
  const table = tag.toLowerCase() === 'sup' ? SUPERSCRIPT : SUBSCRIPT;
  const chars = [...content.trim()];
  if (chars.length > 0 && chars.every((c) => table[c] !== undefined)) {
    return chars.map((c) => table[c]).join('');
  }
  return content;
}

function normalizeSpaces(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    lines[i] = lines[i]
      .replace(/ {2,}/g, ' ')
      .trim()
      .replace(/(\d) +([,.])(?=\d)/g, '$1$2')
      .replace(/ +([,.])(?=\s|$)/g, '$1')
      .replace(/ +([,.])(?=[^\s\d])/g, '$1 ');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * @param {string} value
 * @returns {string} le texte nettoyé, ou `value` inchangé s'il n'y a rien à corriger
 */
function cleanText(value) {
  if (typeof value !== 'string') return value;
  if (!NEEDS_CLEANUP_CHAR.test(value) && !NEEDS_CLEANUP_SPACE.test(value)) return value;
  let text = value
    .replace(ENTITY, decodeEntity)
    .replace(C1, (c) => CP1252[c.charCodeAt(0)] ?? '');
  text = text
    .replace(SCRIPT_TAG, replaceScriptTag)
    .replace(LINE_BREAK_TAG, '\n')
    .replace(ANY_TAG, '');
  if (text.includes('\u00bf')) {
    for (const [pattern, replacement] of QUESTION_MARK_FIXES) text = text.replace(pattern, replacement);
  }
  text = text
    .replace(ELISION, "$1$2'")
    .replace(QUESTION_MARK_BULLET, '$1•')
    .replace(/\u2019/g, "'")
    .replace(SOFT_HYPHEN_BULLET, '$1- ')
    .replace(CONTROL_BETWEEN_LETTERS, '-')
    .replace(CONTROL, ' ')
    .replace(INVISIBLE, '')
    .replace(SPACE_LIKE, ' ');
  return normalizeSpaces(text);
}

module.exports = { cleanText };
