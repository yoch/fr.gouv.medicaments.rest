const { streamMedicinalProducts } = require('../../src/utils/streamMedicinalProductsXml');
const {
  createVetProductBlockParser,
  parseProductBlock,
  VET_SKIP_SCAN_TAGS
} = require('../../src/utils/vetXmlParser');

const scanParser = createVetProductBlockParser(VET_SKIP_SCAN_TAGS);

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
    const product = parseProductBlock(blockXml, scanParser);
    if (!product) return;
    onFields(extractRcpLinkFields(product));
  });
}

module.exports = {
  scanVetProductsXml,
  extractRcpLinkFields
};
