'use strict';

const XMLParser = require('@nodable/flexible-xml-parser').default;

/** Chemins skip.tags (`..tag`). Voir docs/VET_XML_PARSER_PHASES.md. */
/** Prod : ignore RCP volumineux et lien-rcp (URL reconstruite depuis nom + maj-rcp). */
const VET_SKIP_PRODUCT_TAGS = ['..paragraphes-rcp', '..lien-rcp'];

/** Tests scan RCP : garde lien-rcp pour équivalence avec le XML source. */
const VET_SKIP_SCAN_TAGS = ['..paragraphes-rcp'];

function createVetDictionaryParser() {
  return new XMLParser({
    skip: { attributes: true }
  });
}

/**
 * @param {string[]} [skipTags]
 */
function createVetProductBlockParser(skipTags = VET_SKIP_PRODUCT_TAGS) {
  return new XMLParser({
    skip: {
      attributes: true,
      tags: skipTags
    }
  });
}

const defaultDictionaryParser = createVetDictionaryParser();
const defaultProductParser = createVetProductBlockParser();

function wrapProductBlockXml(blockXml) {
  return `<?xml version="1.0" encoding="UTF-8"?><root>${blockXml}</root>`;
}

/**
 * @param {object} parsed — racine flexible-xml (souvent `{ root: … }` ou groupe ANMV).
 * @returns {object|null}
 */
function extractMedicinalProduct(parsed) {
  const root = parsed.root ?? parsed['medicinal-product-group'] ?? parsed;
  const raw = root['medicinal-product'];
  const product = Array.isArray(raw) ? raw[0] : raw;
  if (!product || !product.num || !product.nom) return null;
  return product;
}

/**
 * Liste tous les médicaments sous medicinal-product-group (parse fichier entier).
 * @param {object} parsed
 * @returns {object[]}
 */
function extractMedicinalProductsFromGroup(parsed) {
  const group = parsed['medicinal-product-group'] ?? parsed;
  const raw = group['medicinal-product'];
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((p) => p && p.num && p.nom);
}

/**
 * Parse un bloc `<medicinal-product>…</medicinal-product>` (après découpe readline).
 * @param {string} blockXml
 * @param {ReturnType<typeof createVetProductBlockParser>} parser — instance réutilisable (obligatoire).
 */
function parseProductBlock(blockXml, parser) {
  if (!parser) {
    throw new Error('parseProductBlock: parser requis (ex. defaultProductParser)');
  }
  const parsed = parser.parse(wrapProductBlockXml(blockXml));
  return extractMedicinalProduct(parsed);
}

module.exports = {
  VET_SKIP_PRODUCT_TAGS,
  VET_SKIP_SCAN_TAGS,
  createVetDictionaryParser,
  createVetProductBlockParser,
  defaultDictionaryParser,
  defaultProductParser,
  wrapProductBlockXml,
  extractMedicinalProduct,
  extractMedicinalProductsFromGroup,
  parseProductBlock
};
