const fs = require('fs');

const PRODUCT_CLOSE = '</medicinal-product>';
const DEFAULT_STRIP_TAGS = ['paragraphes-rcp', 'lien-rcp'];

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

function isTagBoundary(ch) {
  return ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
}

function findNextStripOpen(text, fromIndex, stripTags) {
  let best = null;
  for (const tag of stripTags) {
    let pos = fromIndex;
    while (pos < text.length) {
      const idx = text.indexOf(`<${tag}`, pos);
      if (idx === -1) break;
      const next = text[idx + tag.length + 1];
      if (isTagBoundary(next)) {
        if (!best || idx < best.idx) best = { idx, tag };
        break;
      }
      pos = idx + tag.length + 1;
    }
  }
  return best;
}

function stripIgnoredProductTags(text, state, stripTags = DEFAULT_STRIP_TAGS) {
  if (!stripTags || stripTags.length === 0 || text.length === 0) return text;

  let out = '';
  let pos = 0;

  while (pos < text.length) {
    if (state.skipTag) {
      const closeMarker = `</${state.skipTag}>`;
      const closeIdx = text.indexOf(closeMarker, pos);
      if (closeIdx === -1) return out;
      pos = closeIdx + closeMarker.length;
      state.skipTag = null;
      continue;
    }

    const next = findNextStripOpen(text, pos, stripTags);
    if (!next) {
      out += text.slice(pos);
      break;
    }

    out += text.slice(pos, next.idx);
    const tagEnd = text.indexOf('>', next.idx);
    if (tagEnd === -1) {
      state.skipTag = next.tag;
      break;
    }

    const openingTag = text.slice(next.idx, tagEnd + 1);
    if (/\/\s*>$/.test(openingTag)) {
      pos = tagEnd + 1;
      continue;
    }

    const closeMarker = `</${next.tag}>`;
    const closeIdx = text.indexOf(closeMarker, tagEnd + 1);
    if (closeIdx === -1) {
      state.skipTag = next.tag;
      break;
    }
    pos = closeIdx + closeMarker.length;
  }

  return out;
}

/**
 * Lit un fichier produits ANMV bloc par bloc (sans charger tout le XML en mémoire).
 * @param {string} productsPath
 * @param {(blockXml: string) => void | Promise<void>} onProduct
 * @param {{ stripTags?: string[] }} [options]
 */
async function streamMedicinalProducts(productsPath, onProduct, options = {}) {
  const stream = fs.createReadStream(productsPath, { encoding: 'utf8' });
  const stripTags = options.stripTags ?? DEFAULT_STRIP_TAGS;
  const stripState = { skipTag: null };

  let buffer = '';
  let inProduct = false;

  function* productBlocks(lines) {
    for (const line of lines) {
      let fragment;
      if (inProduct) {
        fragment = stripIgnoredProductTags(`\n${line}`, stripState, stripTags);
      } else {
        const openIdx = indexOfProductOpen(line);
        if (openIdx === -1) continue;
        inProduct = true;
        buffer = '';
        fragment = stripIgnoredProductTags(line.slice(openIdx), stripState, stripTags);
      }

      // Scanner seulement le fragment ajouté : scanner le buffer à chaque ligne
      // aplatit les chaînes concaténées sous JavaScriptCore et recopie le produit.
      const fragmentCloseIdx = fragment.indexOf(PRODUCT_CLOSE);
      const previousLength = buffer.length;
      buffer += fragment;
      if (fragmentCloseIdx === -1) continue;
      let closeIdx = previousLength + fragmentCloseIdx;

      // Une même ligne peut fermer un produit puis en contenir d'autres, complets ou non.
      while (closeIdx !== -1) {
        const end = closeIdx + PRODUCT_CLOSE.length;
        const block = buffer.slice(0, end);
        const nextOpen = indexOfProductOpen(buffer, end);
        inProduct = nextOpen !== -1;
        buffer = inProduct ? buffer.slice(nextOpen) : '';
        yield block;
        closeIdx = inProduct ? buffer.indexOf(PRODUCT_CLOSE) : -1;
      }
    }
  }

  // Traiter les lignes synchroniquement dans chaque chunk : l'itérateur async
  // de readline crée une promesse par ligne (près de 800 000 sur le corpus ANMV).
  // N'attendre que les chunks et les callbacks produits, avec backpressure.
  let pendingLine = '';
  for await (const chunk of stream) {
    const text = pendingLine + chunk;
    const end = text.endsWith('\r') ? text.length - 1 : text.length;
    const lines = text.slice(0, end).split(/\r\n|[\r\n]/);
    pendingLine = lines.pop() + text.slice(end);
    for (const block of productBlocks(lines)) await onProduct(block);
  }
  if (pendingLine) {
    for (const block of productBlocks([pendingLine.replace(/\r$/, '')])) {
      await onProduct(block);
    }
  }
}

module.exports = {
  stripIgnoredProductTags,
  streamMedicinalProducts
};
