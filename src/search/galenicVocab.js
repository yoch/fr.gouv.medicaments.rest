'use strict';

/**
 * Vocabulaire galénique canonique partagé par l'interpréteur de requêtes
 * (détection de conflits explicite / extrait) et le scoring expérimental
 * (satisfaction forme / voie). Comparaison par mots entiers canoniques,
 * jamais par sous-chaîne (`gel` != `gelule`, `cutanee` != `sous cutanee`).
 */

const { normalizeSearchText } = require('../utils/searchRanking');

const FORME_STOP_WORDS = new Set([
  'a', 'au', 'aux', 'd', 'dans', 'de', 'des', 'du', 'en', 'et', 'l', 'la', 'le', 'les', 'ou', 'par', 'pour', 'sans', 'sur', 'un', 'une'
]);

const FORME_CANONICAL_TOKENS = new Map([
  ['comprimes', 'comprime'],
  ['cpr', 'comprime'],
  ['cp', 'comprime'],
  ['comp', 'comprime'],
  ['gelules', 'gelule'],
  ['gels', 'gel'],
  ['capsules', 'capsule'],
  ['sirops', 'sirop'],
  ['collyres', 'collyre'],
  ['suppositoires', 'suppositoire'],
  ['suppos', 'suppositoire'],
  ['suppo', 'suppositoire'],
  ['sachets', 'sachet'],
  ['sach', 'sachet'],
  ['ampoules', 'ampoule'],
  ['amp', 'ampoule'],
  ['flacons', 'flacon'],
  ['fl', 'flacon'],
  ['ovules', 'ovule'],
  ['poudres', 'poudre'],
  ['pdr', 'poudre'],
  ['solutions', 'solution'],
  ['suspensions', 'suspension'],
  ['emulsions', 'emulsion'],
  ['pommades', 'pommade'],
  ['cremes', 'creme'],
  ['granules', 'granule'],
  ['granule', 'granule'],
  ['patchs', 'patch'],
  ['effervescents', 'effervescent'],
  ['effervescente', 'effervescent'],
  ['effervescentes', 'effervescent'],
  ['eff', 'effervescent'],
  ['pellicules', 'pellicule'],
  ['pelliculee', 'pellicule'],
  ['pelliculees', 'pellicule'],
  ['secables', 'secable'],
  ['orodispersibles', 'orodispersible'],
  ['oro', 'orodispersible'],
  ['dispersibles', 'dispersible'],
  ['resistants', 'resistant'],
  ['resistante', 'resistant'],
  ['resistantes', 'resistant'],
  ['prolongee', 'prolonge'],
  ['prolonges', 'prolonge'],
  ['prolongees', 'prolonge'],
  ['buvables', 'buvable'],
  ['buv', 'buvable'],
  ['injectables', 'injectable'],
  ['inj', 'injectable'],
  ['sublinguales', 'sublingual'],
  ['sublinguale', 'sublingual'],
  ['auriculaires', 'auriculaire']
]);

const VOIE_CANONICAL_ALIASES = new Map([
  ['voie orale', 'orale'],
  ['per os', 'orale'],
  ['po', 'orale'],
  ['voie per os', 'orale'],
  ['oral', 'orale'],
  ['orale', 'orale'],
  ['iv', 'intraveineuse'],
  ['voie iv', 'intraveineuse'],
  ['intraveineux', 'intraveineuse'],
  ['voie intraveineuse', 'intraveineuse'],
  ['intraveineuse', 'intraveineuse'],
  ['im', 'intramusculaire'],
  ['voie im', 'intramusculaire'],
  ['voie intramusculaire', 'intramusculaire'],
  ['intramusculaire', 'intramusculaire'],
  ['sc', 'sous cutanee'],
  ['voie sc', 'sous cutanee'],
  ['sous cutane', 'sous cutanee'],
  ['sous cutanee', 'sous cutanee'],
  ['voie sous cutanee', 'sous cutanee'],
  ['cutane', 'cutanee'],
  ['cutanee', 'cutanee'],
  ['voie cutanee', 'cutanee'],
  ['ophtalmique', 'ophtalmique'],
  ['voie ophtalmique', 'ophtalmique'],
  ['auriculaire', 'auriculaire'],
  ['voie auriculaire', 'auriculaire'],
  ['nasal', 'nasale'],
  ['nasale', 'nasale'],
  ['voie nasale', 'nasale'],
  ['rectal', 'rectale'],
  ['rectale', 'rectale'],
  ['voie rectale', 'rectale'],
  ['vaginal', 'vaginale'],
  ['vaginale', 'vaginale'],
  ['voie vaginale', 'vaginale'],
  ['sublingual', 'sublinguale'],
  ['sublinguale', 'sublinguale'],
  ['voie sublinguale', 'sublinguale'],
  ['transdermique', 'transdermique'],
  ['voie transdermique', 'transdermique'],
  ['inhale', 'inhalee'],
  ['inhalee', 'inhalee'],
  ['inhalation', 'inhalee'],
  ['voie inhalee', 'inhalee'],
  ['buccale autre', 'voie buccale autre'],
  ['extracorporelle autre', 'voie extracorporelle autre'],
  ['parenterale autre', 'voie parenterale autre']
]);

function normalizeGalenicWord(token) {
  return FORME_CANONICAL_TOKENS.get(token) || token;
}

function tokenizeGalenicText(value) {
  const cleaned = normalizeSearchText(value)
    .replace(/([a-z0-9])\((?:e|es|s)\)/g, '$1')
    .replace(/\blp\b/g, 'liberation prolonge')
    .replace(/\bsol\s+buv(?:able)?\b/g, 'solution buvable')
    .replace(/\bsol\s+inj(?:ectable)?\b/g, 'solution injectable');
  if (!cleaned) return [];
  const raw = cleaned.split(/[\s'’()\-–—,;:/]+/u);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (!t) continue;
    out.push(normalizeGalenicWord(t));
  }
  return out;
}

/** Mots galéniques significatifs (canoniques, sans mots vides), dédoublonnés. */
function significantFormeTokens(value) {
  const all = tokenizeGalenicText(value);
  const filtered = all.filter((t) => !FORME_STOP_WORDS.has(t));
  return [...new Set(filtered.length > 0 ? filtered : all)];
}

function canonicalizeVoieEntry(raw) {
  const norm = normalizeSearchText(raw)
    .replace(/['’]/g, ' ')
    .replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!norm) return '';
  return VOIE_CANONICAL_ALIASES.get(norm) || norm;
}

function extractVoieEntries(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  const entries = [];
  for (const part of text.split(/[;,]+/)) {
    const canon = canonicalizeVoieEntry(part);
    if (canon && !entries.includes(canon)) entries.push(canon);
  }
  return entries;
}

module.exports = {
  FORME_STOP_WORDS,
  tokenizeGalenicText,
  significantFormeTokens,
  canonicalizeVoieEntry,
  extractVoieEntries
};
