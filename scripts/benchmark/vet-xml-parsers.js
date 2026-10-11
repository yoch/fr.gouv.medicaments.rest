#!/usr/bin/env node
'use strict';

/**
 * Compare mémoire / durée des stratégies de parse XML vétérinaire.
 *
 * Usage:
 *   npm run benchmark:vet-xml
 *   node --expose-gc scripts/benchmark/vet-xml-parsers.js --phase=saxes
 *   BENCHMARK_PHASES=baseline,saxes node --expose-gc scripts/benchmark/vet-xml-parsers.js
 *
 * Phases (défaut : baseline + saxes) :
 *   baseline — fast-xml-parser + stopNodes (ancien comportement)
 *   saxes    — saxes, sous-arbres RCP ignorés (prod)
 * Les deux phases partagent le découpage en blocs de `streamMedicinalProductsXml`.
 */

const fs = require('fs');
const path = require('path');
const { XMLParser: FxpParser } = require('fast-xml-parser');
const { streamMedicinalProducts } = require('../../src/utils/streamMedicinalProductsXml');
const { defaultProductParser, parseProductBlock } = require('../../src/utils/vetXmlParser');

const { gcBeforeMeasure } = require('../../src/utils/loadGc');

const DEFAULT_PRODUCTS = path.join(
  __dirname,
  '../../data/veterinaires/amm-vet-fr-v2-v.xml'
);

const DEFAULT_PHASES = 'baseline,saxes';

function parseArgs(argv) {
  let productsPath = DEFAULT_PRODUCTS;
  let phases = (process.env.BENCHMARK_PHASES || DEFAULT_PHASES)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const arg of argv) {
    if (arg.startsWith('--phase=')) {
      phases = [arg.slice('--phase='.length)];
    } else if (!arg.startsWith('-')) {
      productsPath = path.resolve(arg);
    }
  }
  return { productsPath, phases };
}

function memMb() {
  const u = process.memoryUsage();
  return {
    heapUsed_mb: Math.round((u.heapUsed / 1024 / 1024) * 10) / 10,
    rss_mb: Math.round((u.rss / 1024 / 1024) * 10) / 10
  };
}

function snapshot(label) {
  gcBeforeMeasure(label);
  return { label, ...memMb() };
}

const FXP_ARRAY_TAGS = new Set([
  'medicinal-product',
  'compo',
  'sa',
  'mod-vte',
  'voie-admin',
  'code-atcvet',
  'entry',
  'term-esp'
]);

const fxpParser = new FxpParser({
  ignoreAttributes: true,
  trimValues: true,
  isArray: (tagName) => FXP_ARRAY_TAGS.has(tagName),
  stopNodes: ['*.paragraphes-rcp', '*.lien-rcp']
});

function parseBlockFxp(blockXml) {
  const product = fxpParser.parse(blockXml)['medicinal-product']?.[0];
  return product?.num && product?.nom ? product : null;
}

async function runBaseline(productsPath) {
  let count = 0;
  let rcpChars = 0;
  const t0 = Date.now();
  const before = snapshot('baseline_start');

  await streamMedicinalProducts(productsPath, (blockXml) => {
    const product = parseBlockFxp(blockXml);
    if (!product) return;
    count++;
    const rcp = product['paragraphes-rcp'];
    if (typeof rcp === 'string') rcpChars += rcp.length;
  });

  const after = snapshot('baseline_end');
  return {
    phase: 'baseline',
    ms: Date.now() - t0,
    products: count,
    paragraphes_rcp_chars_in_objects: rcpChars,
    mem: { before, after, delta_heap_mb: after.heapUsed_mb - before.heapUsed_mb }
  };
}

async function runSaxes(productsPath) {
  let count = 0;
  let rcpKeys = 0;
  const t0 = Date.now();
  const before = snapshot('saxes_start');

  await streamMedicinalProducts(productsPath, (blockXml) => {
    const product = parseProductBlock(blockXml, defaultProductParser);
    if (!product) return;
    count++;
    if ('paragraphes-rcp' in product) rcpKeys++;
  });

  const after = snapshot('saxes_end');
  return {
    phase: 'saxes',
    ms: Date.now() - t0,
    products: count,
    products_with_paragraphes_rcp_key: rcpKeys,
    mem: { before, after, delta_heap_mb: after.heapUsed_mb - before.heapUsed_mb }
  };
}

async function main() {
  const { productsPath, phases } = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(productsPath)) {
    console.error(`Fichier introuvable: ${productsPath}`);
    process.exit(1);
  }

  const meta = {
    node: process.version,
    productsPath,
    phases,
    file_mb: Math.round((fs.statSync(productsPath).size / 1024 / 1024) * 10) / 10
  };
  console.log(JSON.stringify({ meta }, null, 2));

  const results = [];

  for (const phase of phases) {
    if (phase === 'baseline') results.push(await runBaseline(productsPath));
    else if (phase === 'saxes') results.push(await runSaxes(productsPath));
    else console.warn(`Phase inconnue: ${phase}`);
  }

  console.log('\n=== RÉSULTATS ===\n');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
