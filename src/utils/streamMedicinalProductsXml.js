const fs = require('fs');
const readline = require('readline');

const PRODUCT_CLOSE = '</medicinal-product>';

function indexOfProductOpen(line, fromIndex = 0) {
  const marker = '<medicinal-product';
  let pos = fromIndex;
  while (pos < line.length) {
    const idx = line.indexOf(marker, pos);
    if (idx === -1) return -1;
    if (line.startsWith('<medicinal-product-group', idx)) {
      pos = idx + marker.length;
      continue;
    }
    const nextChar = line[idx + marker.length];
    if (nextChar === '>' || nextChar === ' ' || nextChar === '\t') {
      return idx;
    }
    pos = idx + 1;
  }
  return -1;
}

/**
 * Lit un fichier produits ANMV bloc par bloc (sans charger tout le XML en mémoire).
 * @param {string} productsPath
 * @param {(blockXml: string) => void | Promise<void>} onProduct
 */
async function streamMedicinalProducts(productsPath, onProduct) {
  const stream = fs.createReadStream(productsPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let buffer = '';
  let inProduct = false;

  for await (const line of rl) {
    if (!inProduct) {
      const openIdx = indexOfProductOpen(line);
      if (openIdx === -1) continue;
      inProduct = true;
      buffer = line.slice(openIdx);
      const closeIdx = buffer.indexOf(PRODUCT_CLOSE);
      if (closeIdx !== -1) {
        const block = buffer.slice(0, closeIdx + PRODUCT_CLOSE.length);
        buffer = '';
        inProduct = false;
        await onProduct(block);
      }
      continue;
    }

    buffer += `\n${line}`;
    const closeIdx = buffer.indexOf(PRODUCT_CLOSE);
    if (closeIdx === -1) continue;

    const block = buffer.slice(0, closeIdx + PRODUCT_CLOSE.length);
    buffer = buffer.slice(closeIdx + PRODUCT_CLOSE.length);
    inProduct = indexOfProductOpen(buffer) !== -1;
    if (inProduct) {
      const nextOpen = indexOfProductOpen(buffer);
      buffer = buffer.slice(nextOpen);
    } else {
      buffer = '';
    }
    await onProduct(block);
  }
}

module.exports = {
  streamMedicinalProducts
};
