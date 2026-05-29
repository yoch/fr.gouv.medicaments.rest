const { XMLParser } = require('fast-xml-parser');
const { streamMedicinalProducts } = require('../../src/utils/streamMedicinalProductsXml');

const ARRAY_TAGS = new Set([
  'medicinal-product',
  'compo',
  'sa',
  'mod-vte',
  'voie-admin',
  'code-atcvet',
  'entry',
  'term-esp'
]);

/** Parse léger : ignore le corps des paragraphes-rcp, garde lien-rcp / maj-rcp au niveau produit. */
const xmlParser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  isArray: (tagName) => ARRAY_TAGS.has(tagName),
  stopNodes: ['*.paragraphes-rcp']
});

function parseProductBlock(blockXml) {
  const wrapped = `<?xml version="1.0" encoding="UTF-8"?><root>${blockXml}</root>`;
  const parsed = xmlParser.parse(wrapped);
  const raw = parsed.root?.['medicinal-product'] ?? parsed.root;
  const product = Array.isArray(raw) ? raw[0] : raw;
  if (!product || !product.nom) return null;
  return product;
}

function extractRcpLinkFields(product) {
  return {
    num: product.num != null ? String(product.num).trim() : '',
    nom: String(product.nom).trim(),
    lien_rcp_xml: product['lien-rcp'] ? String(product['lien-rcp']).trim() : '',
    maj_rcp_xml: product['maj-rcp'] ? String(product['maj-rcp']).trim() : ''
  };
}

/**
 * Parcourt un fichier produits ANMV et appelle onFields pour chaque médicament.
 * @param {string} productsPath
 * @param {(fields: { num: string, nom: string, lien_rcp_xml: string, maj_rcp_xml: string }) => void} onFields
 */
async function scanVetProductsXml(productsPath, onFields) {
  await streamMedicinalProducts(productsPath, (blockXml) => {
    const product = parseProductBlock(blockXml);
    if (!product) return;
    onFields(extractRcpLinkFields(product));
  });
}

module.exports = {
  scanVetProductsXml,
  extractRcpLinkFields,
  parseProductBlock
};
