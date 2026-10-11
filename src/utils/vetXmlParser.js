'use strict';

const { SaxesParser } = require('saxes');

/** Prod : ignore RCP volumineux et lien-rcp (URL reconstruite depuis nom + maj-rcp). Voir docs/VET_XML_PARSER_PHASES.md. */
const VET_SKIP_PRODUCT_TAGS = ['paragraphes-rcp', 'lien-rcp'];

/** Tests scan RCP : garde lien-rcp pour équivalence avec le XML source. */
const VET_SKIP_SCAN_TAGS = ['paragraphes-rcp'];

const PRODUCT_TAG = 'medicinal-product';
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @param {string[]} [skipTags] — balises ignorées avec leur sous-arbre, à toute profondeur.
 */
function createVetProductBlockParser(skipTags = VET_SKIP_PRODUCT_TAGS) {
  return { skipTags: new Set(skipTags) };
}

const defaultProductParser = createVetProductBlockParser();

function addChild(obj, key, value) {
  if (UNSAFE_KEYS.has(key)) return;
  if (!Object.hasOwn(obj, key)) obj[key] = value;
  else if (Array.isArray(obj[key])) obj[key].push(value);
  else obj[key] = [obj[key], value];
}

// saxes découpe le texte dans la chaîne du bloc. Sous V8, une sous-chaîne d'au
// moins 13 caractères référence sa chaîne parente : sans copie, chaque valeur
// gardée dans le corpus retiendrait tout le bloc XML (~18 Mo sur le corpus ANMV).
// La concaténation puis le slice forcent V8 à recopier dans une chaîne propre.
function leafText(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length < 13 ? normalized : ` ${normalized}`.slice(1);
}

/**
 * Parse un bloc `<medicinal-product>…</medicinal-product>` en objet compact :
 * une balise feuille donne son texte (espaces normalisés, sans conversion de
 * type), une balise répétée donne un tableau.
 * @param {string} blockXml
 * @param {ReturnType<typeof createVetProductBlockParser>} parser — configuration (obligatoire).
 * @returns {object|null} null si le bloc n'est pas un médicament avec `num` et `nom`.
 */
function parseProductBlock(blockXml, parser) {
  if (!parser) {
    throw new Error('parseProductBlock: parser requis (ex. defaultProductParser)');
  }
  const { skipTags } = parser;
  const xml = new SaxesParser();
  const stack = [];
  let skipDepth = 0;
  let root = null;

  const onText = (text) => {
    if (skipDepth === 0 && stack.length > 0) stack[stack.length - 1].text += text;
  };
  xml.on('opentag', ({ name }) => {
    if (skipDepth > 0 || skipTags.has(name)) {
      skipDepth++;
      return;
    }
    stack.push({ name, children: null, text: '' });
  });
  xml.on('text', onText);
  xml.on('cdata', onText);
  xml.on('closetag', () => {
    if (skipDepth > 0) {
      skipDepth--;
      return;
    }
    const node = stack.pop();
    const value = node.children ?? leafText(node.text);
    const parent = stack[stack.length - 1];
    if (parent) addChild((parent.children ??= {}), node.name, value);
    else root = { name: node.name, value };
  });
  xml.write(blockXml).close();

  const product = root?.name === PRODUCT_TAG ? root.value : null;
  if (!product || typeof product !== 'object' || !product.num || !product.nom) return null;
  return product;
}

module.exports = {
  VET_SKIP_PRODUCT_TAGS,
  VET_SKIP_SCAN_TAGS,
  createVetProductBlockParser,
  defaultProductParser,
  parseProductBlock
};
