const fs = require('fs');
const readline = require('readline');

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
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const stripTags = options.stripTags ?? DEFAULT_STRIP_TAGS;
  const stripState = { skipTag: null };

  let buffer = '';
  let inProduct = false;

  for await (const line of rl) {
    if (!inProduct) {
      const openIdx = indexOfProductOpen(line);
      if (openIdx === -1) continue;
      inProduct = true;
      buffer = stripIgnoredProductTags(line.slice(openIdx), stripState, stripTags);
      const closeIdx = buffer.indexOf(PRODUCT_CLOSE);
      if (closeIdx !== -1) {
        const block = buffer.slice(0, closeIdx + PRODUCT_CLOSE.length);
        buffer = '';
        inProduct = false;
        await onProduct(block);
      }
      continue;
    }

    buffer += stripIgnoredProductTags(`\n${line}`, stripState, stripTags);
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
  stripIgnoredProductTags,
  streamMedicinalProducts
};
