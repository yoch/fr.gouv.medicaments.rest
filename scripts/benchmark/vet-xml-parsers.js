#!/usr/bin/env node
'use strict';

/**
 * Compare mémoire / durée des stratégies de parse XML vétérinaire.
 *
 * Usage:
 *   npm run benchmark:vet-xml
 *   node --expose-gc scripts/benchmark-vet-xml-parsers.js --phase=phase1
 *   BENCHMARK_PHASES=baseline,phase1,phase2 node --expose-gc scripts/benchmark-vet-xml-parsers.js
 *
 * Phases (défaut : baseline + phase1) :
 *   baseline — fast-xml-parser + stopNodes + readline (ancien comportement)
 *   phase1   — flexible-xml-parser + skip.tags + readline (prod)
 *   phase2   — parseStream, arbre complet en mémoire (expérimental, peut OOM)
 */

const fs = require('fs');
const path = require('path');
const { XMLParser: FxpParser } = require('fast-xml-parser');
const { streamMedicinalProducts } = require('../../src/utils/streamMedicinalProductsXml');
const {
  createVetProductBlockParser,
  defaultProductParser,
  extractMedicinalProduct,
  extractMedicinalProductsFromGroup,
  parseProductBlock,
  wrapProductBlockXml
} = require('../../src/utils/vetXmlParser');

const { gcBeforeMeasure } = require('../../src/utils/loadGc');

const DEFAULT_PRODUCTS = path.join(
  __dirname,
  '../data/veterinaires/amm-vet-fr-v2-v.xml'
);

const DEFAULT_PHASES = 'baseline,phase1';

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
  const parsed = fxpParser.parse(wrapProductBlockXml(blockXml));
  return extractMedicinalProduct(parsed);
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

async function runPhase1(productsPath) {
  let count = 0;
  let rcpKeys = 0;
  const t0 = Date.now();
  const before = snapshot('phase1_start');

  await streamMedicinalProducts(productsPath, (blockXml) => {
    const product = parseProductBlock(blockXml, defaultProductParser);
    if (!product) return;
    count++;
    if ('paragraphes-rcp' in product) rcpKeys++;
  });

  const after = snapshot('phase1_end');
  return {
    phase: 'phase1',
    ms: Date.now() - t0,
    products: count,
    products_with_paragraphes_rcp_key: rcpKeys,
    mem: { before, after, delta_heap_mb: after.heapUsed_mb - before.heapUsed_mb }
  };
}

/** Phase 2 expérimentale — ne pas utiliser en prod (voir docs/VET_XML_PARSER_PHASES.md). */
async function parseAllProductsViaStream(productsPath) {
  const parser = createVetProductBlockParser();
  const parsed = await parser.parseStream(
    fs.createReadStream(productsPath, { encoding: 'utf8' })
  );
  return extractMedicinalProductsFromGroup(parsed);
}

async function runPhase2(productsPath) {
  const t0 = Date.now();
  const before = snapshot('phase2_start');

  const products = await parseAllProductsViaStream(productsPath);
  const afterParse = snapshot('phase2_after_parse');
  let rcpKeys = 0;
  for (const p of products) {
    if (p && 'paragraphes-rcp' in p) rcpKeys++;
  }

  const after = snapshot('phase2_end');
  return {
    phase: 'phase2',
    ms: Date.now() - t0,
    products: products.length,
    products_with_paragraphes_rcp_key: rcpKeys,
    mem: {
      before,
      after_parse: afterParse,
      after,
      delta_heap_parse_mb: afterParse.heapUsed_mb - before.heapUsed_mb,
      delta_heap_total_mb: after.heapUsed_mb - before.heapUsed_mb
    }
  };
}

async function main() {
  const { productsPath, phases } = parseArgs(process.argv.slice(2));

  if (phases.includes('phase2')) {
    console.warn(
      'Attention : phase2 charge tout le XML en arbre JS — risque OOM sur gros fichiers. Voir docs/VET_XML_PARSER_PHASES.md.'
    );
  }

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
    else if (phase === 'phase1') results.push(await runPhase1(productsPath));
    else if (phase === 'phase2') results.push(await runPhase2(productsPath));
    else console.warn(`Phase inconnue: ${phase}`);
  }

  console.log('\n=== RÉSULTATS ===\n');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
