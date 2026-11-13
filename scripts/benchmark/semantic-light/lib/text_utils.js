'use strict';

const DIACRITICS_RE = /[\u0300-\u036f]/g;
const SPLIT_RE = /[\s\p{P}]+/u;

const FR_STOPWORDS = new Set([
  'a', 'ai', 'ainsi', 'apres', 'au', 'aux', 'avec', 'avoir', 'bon', 'bonjour',
  'car', 'cas', 'ce', 'ces', 'cette', 'chez', 'comme', 'contre', 'dans', 'de',
  'des', 'doit', 'doivent', 'donc', 'dont', 'du', 'd', 'elle', 'en', 'entre',
  'est', 'et', 'ete', 'etre', 'faut', 'il', 'j', 'je', 'l', 'la', 'le', 'les',
  'leur', 'leurs', 'lors', 'ma', 'mais', 'me', 'meme', 'merci', 'mes', 'mon',
  'ne', 'ni', 'nos', 'notre', 'on', 'ou', 'par', 'pas', 'pendant', 'peu',
  'peut', 'peuvent', 'plus', 'pour', 'prendre', 'pris', 'qu', 'que', 'quel',
  'quelle', 'quelles', 'quels', 'qui', 'quoi', 'sa', 'sans', 'se', 'ses', 'si',
  'son', 'sont', 'sous', 'suis', 'sur', 'ta', 'te', 'tes', 'ton', 'tous', 'tout',
  'toute', 'toutes', 'tres', 'tu', 'un', 'une', 'vers', 'vos', 'votre', 'vous',
  'y', 'svp', 'sil', 'plait', 'medoc', 'medocs', 'medicament', 'medicaments',
  'produit', 'produits', 'traitement', 'traitements', 'moyen', 'remede',
  'soigner', 'calmer', 'soulager', 'guerir', 'efficace', 'meilleur', 'conseil',
  'cherche', 'veux', 'voudrais', 'savoir', 'faire', 'donner', 'donne', 'aide',
  'aider', 'estce', 'ya'
]);

const CLINICAL_STOPWORDS = new Set([
  'de', 'du', 'des', 'la', 'le', 'les', 'et', 'en', 'ou', 'au', 'aux',
  'un', 'une', 'pour', 'par', 'dans', 'sur', 'avec', 'sans', 'est', 'sont',
  'qui', 'que', 'ce', 'cette', 'ces', 'se', 'sa', 'son', 'ses', 'il', 'elle',
  'on', 'ne', 'pas', 'plus', 'etre', 'avoir', 'ete', 'chez', 'entre', 'vers',
  'sous', 'dont', 'tout', 'tous', 'toute', 'toutes', 'autre', 'autres',
  'peut', 'doit', 'peuvent', 'doivent', 'cas', 'lors', 'ainsi', 'tres',
  'indique', 'indiques', 'indiquee', 'indiquees', 'adulte', 'adultes',
  'patient', 'patients', 'rubrique', 'medicament', 'medicaments', 'voir'
]);

function normalizeText(value) {
  if (value == null) return '';
  return String(value)
    .normalize('NFD')
    .replace(DIACRITICS_RE, '')
    .toLowerCase();
}

/**
 * Fuse high-frequency negation/label bigrams before tokenization so
 * "SANS SUCRE" does not pollute a query for "sucre", and "sans ordonnance" stays intact.
 */
function maskNegativeLabelBigrams(normalizedStr) {
  return normalizedStr
    .replace(/\bsans\s+sucre(?:s)?\b/g, 'sanssucre')
    .replace(/\bsans\s+sel\b/g, 'sanssel')
    .replace(/\bsans\s+sodium\b/g, 'sanssodium')
    .replace(/\bsans\s+conservateur(?:s)?\b/g, 'sansconservateur')
    .replace(/\bsans\s+alcool\b/g, 'sansalcool')
    .replace(/\bsans\s+gluten\b/g, 'sansgluten')
    .replace(/\bsans\s+ordonnance\b/g, 'sansordonnance');
}

function tokenizeBasic(text) {
  return normalizeText(text).split(SPLIT_RE).filter(Boolean);
}

function tokenizeWithMaskedBigrams(text) {
  const norm = maskNegativeLabelBigrams(normalizeText(text));
  return norm.split(/[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^`{|}~’«»]+/u).filter(Boolean);
}

/**
 * Lightweight French inflection + medical morphological normalization for `_morph` experiment.
 */
function simpleStemFr(token) {
  if (token.length <= 4) return token;
  if (token === 'maux') return 'mal';
  if (token === 'yeux') return 'oeil';
  let t = token;
  if (t.endsWith('aux') && t.length > 5) t = t.slice(0, -3) + 'al';
  else if (t.endsWith('eux') && t.length > 5) t = t.slice(0, -1);
  else if (t.endsWith('es') && t.length > 5) t = t.slice(0, -2);
  else if ((t.endsWith('s') || t.endsWith('x')) && t.length > 4) t = t.slice(0, -1);

  if (t.endsWith('ique') && t.length > 7) t = t.slice(0, -4);
  else if (t.endsWith('iques') && t.length > 8) t = t.slice(0, -5);
  else if (t.endsWith('ement') && t.length > 8) t = t.slice(0, -5);
  else if (t.endsWith('ation') && t.length > 8) t = t.slice(0, -5);
  return t;
}

function extractCharNgrams(token, n = 4) {
  const out = [];
  if (token.length <= n) {
    out.push(token);
    return out;
  }
  const seen = new Set();
  for (let i = 0; i <= token.length - n; i++) {
    const g = token.slice(i, i + n);
    if (!seen.has(g)) {
      seen.add(g);
      out.push(`_${n}${g}`);
    }
  }
  return out;
}

module.exports = {
  FR_STOPWORDS,
  CLINICAL_STOPWORDS,
  normalizeText,
  maskNegativeLabelBigrams,
  tokenizeBasic,
  tokenizeWithMaskedBigrams,
  simpleStemFr,
  extractCharNgrams,
};
