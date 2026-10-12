#!/usr/bin/env node
'use strict';

// Mesure le critère `dosage` sur des cas réalistes et sur le corpus BDPM local.
// R-précision : part de produits pertinents parmi les R premiers résultats,
// R étant le nombre de pertinents ; le plafond tient compte de la règle qui
// interdit à un critère de franchir un niveau de match_quality.
const fs = require('node:fs');
const path = require('node:path');
const config = require('../../src/config');
const { loadData } = require('../../src/services/dataLoader');
const { executeHybridSearch } = require('../../src/services/searchOrchestrator');
const { normalizeSearchText, MATCH_QUALITY_RANK } = require('../../src/utils/searchRanking');
const { rerankWithStructuredCriteria } = require('../../src/utils/structuredSearchCriteria');

const re = (pattern) => (hit) => pattern.test(hit.denomination);
// [catégorie, q, dosage, pertinence définie à la main sur la dénomination]
const CASES = [
  ['copie', 'amoxicilline', '250 mg/5 ml', re(/\b250 mg ?\/ ?5 ml/i)],
  ['copie', 'amoxicilline', '1 g/125 mg', re(/\b1 g\/125 mg/i)],
  ['copie', 'amoxicilline', '500 mg/62,5 mg', re(/\b500 mg\/62,5 mg/i)],
  ['copie', 'morphine', '10 mg/ml', re(/\b10 mg\/(1 )?ml/i)],
  ['copie', 'methotrexate', '25 mg/ml', re(/\b25 mg\/(1 )?ml/i)],
  ['copie', 'methotrexate', '50 mg/2 ml', re(/\b50 mg\/2 ml/i)],
  ['copie', 'methotrexate', '10 mg/0,4 ml', re(/\b10 mg\/0,4 ml/i)],
  ['copie', 'cholecalciferol', '100 000 UI', re(/\b100 000 UI/i)],
  ['copie', 'cholecalciferol', '50 000 UI', re(/\b50 000 UI/i)],
  ['copie', 'humalog', '200 UI/ml', re(/\b200 (UI|unités)\/ml/i)],
  ['copie', 'humalog', '100 unités/ml', re(/\b100 (UI|unités)\/ml/i)],
  ['copie', 'levothyroxine', '25 microgrammes', re(/(^|[^\d,])25 microgrammes/i)],
  ['copie', 'aciclovir', '5 %', re(/\b5 (%|POUR CENT)/i)],
  ['copie', 'doliprane', '1000 mg', re(/\b1000 mg/i)],
  ['copie', 'salbutamol', '100 microgrammes/dose', re(/\b100 microgrammes\/dose/i)],
  ['simplifié', 'amoxicilline', '250 mg', re(/\b250 mg ?\/ ?5 ml/i)],
  ['simplifié', 'amoxicilline', '500 mg', re(/\b500 mg(?! ?\/ ?\d+(,\d+)? mg)/i)],
  ['simplifié', 'augmentin', '1 g', re(/\b1 g\/125 mg/i)],
  ['simplifié', 'morphine', '10 mg', re(/\b10 mg(?! ?\/)/i)],
  ['simplifié', 'methotrexate', '10 mg', re(/\b10 mg(?! ?\/)/i)],
  ['simplifié', 'oramorph', '20 mg', re(/\b20 mg/i)],
  ['équivalent', 'doliprane', '1 g', re(/\b1000 mg/i)],
  ['équivalent', 'levothyroxine', '25 µg', re(/(^|[^\d,])25 microgrammes/i)],
  ['équivalent', 'acide tranexamique', '500 mg/5 ml', re(/\b0,5 g\/5 ml/i)],
  ['équivalent', 'cholecalciferol', '100000 UI', re(/\b100 000 UI/i)],
  ['équivalent', 'aciclovir', '5 pour cent', re(/\b5 (%|POUR CENT)/i)],
  // Concentrations équivalentes non calculées : limite assumée du rapprochement littéral.
  ['équivalent', 'morphine', '20 mg/ml', re(/\b20 mg\/(1 )?ml/i)],
  ['équivalent', 'amoxicilline', '50 mg/ml', re(/\b250 mg ?\/ ?5 ml/i)]
];

const rank = (hit) => MATCH_QUALITY_RANK[hit.match_quality] || 0;

function evaluate(base, dosage, isRelevant) {
  const ranked = rerankWithStructuredCriteria(base, { dosage });
  const relevant = ranked.map(isRelevant);
  const R = relevant.filter(Boolean).length;
  if (R === 0) return null;
  const ideal = [...ranked].sort((a, b) => rank(b) - rank(a) || isRelevant(b) - isRelevant(a));
  const flagged = ranked.filter((hit) => hit.criteria_match.dosage);
  return {
    rprec: relevant.slice(0, R).filter(Boolean).length / R,
    ceiling: ideal.slice(0, R).filter(isRelevant).length / R,
    top1: relevant[0] ? 1 : 0,
    flagPrecision: flagged.length ? flagged.filter(isRelevant).length / flagged.length : null,
    first: ranked[0].denomination.split(',')[0]
  };
}

// Premier dosage écrit avant la virgule, avec ses dénominateurs éventuels.
const SEGMENT_RE = new RegExp(
  String.raw`(\d[\d \u00a0,.]*\s*(?:mg|g|µg|microgrammes?|ui|u\.i\.|unités?|ml|l|%|pour cent)\b` +
  String.raw`(?:\s*\/\s*(?:\d[\d \u00a0,.]*\s*)?(?:mg|g|µg|microgrammes?|ui|unités?|ml|l|dose|24 heures|heures?)\b)*)`,
  'i'
);
function segmentOf(denomination) {
  const match = String(denomination).split(',')[0].match(SEGMENT_RE);
  return match ? match[1].toLowerCase().replace(/\s*\/\s*/g, '/').replace(/[\s\u00a0]+/g, ' ').trim() : null;
}

const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;
const pct = (value) => `${Math.round(value * 100)} %`;
function summary(rows) {
  const flagged = rows.filter((row) => row.flagPrecision != null);
  return `${String(rows.length).padStart(5)} cas, R-précision ${pct(mean(rows.map((r) => r.rprec)))} ` +
    `(plafond ${pct(mean(rows.map((r) => r.ceiling)))}), premier pertinent ${pct(mean(rows.map((r) => r.top1)))}, ` +
    `précision de criteria_match.dosage ${flagged.length ? pct(mean(flagged.map((r) => r.flagPrecision))) : '—'}`;
}

async function main() {
  const log = console.log;
  console.log = () => {};
  await loadData();
  console.log = log;

  const bases = new Map();
  const baseFor = (q) => {
    if (!bases.has(q)) bases.set(q, executeHybridSearch(q, 'human').results.filter((hit) => hit.denomination));
    return bases.get(q);
  };

  const byCategory = {};
  for (const [category, q, dosage, isRelevant] of CASES) {
    const row = evaluate(baseFor(q), dosage, isRelevant);
    if (!row) throw new Error(`Aucun résultat pertinent pour q=${q} dosage=${dosage}`);
    (byCategory[category] ??= []).push(row);
    log(`[${category}] q=${q} dosage=${dosage} : R-précision ${pct(row.rprec)} (plafond ${pct(row.ceiling)}), 1er : ${row.first}`);
  }
  log('');
  for (const [category, rows] of Object.entries(byCategory)) log(`${category.padEnd(11)} ${summary(rows)}`);

  // Corpus : q = premier mot de la dénomination, dosage recopié tel qu'écrit.
  const pairs = new Map();
  const lines = fs.readFileSync(path.join(config.dataDir, 'CIS_bdpm.txt'), 'utf8').split('\n');
  for (const line of lines) {
    const denomination = line.split('\t')[1];
    const segment = denomination && segmentOf(denomination);
    const q = denomination && normalizeSearchText(denomination.split(/[\s,(/]/)[0]);
    if (segment && /^[a-z]{4,}$/.test(q)) pairs.set(`${q}\u0000${segment}`, { q, segment });
  }
  const corpus = [];
  for (const { q, segment } of pairs.values()) {
    const base = baseFor(q);
    if (base.length < 2 || base.length > 500) continue;
    const row = evaluate(base, segment, (hit) => segmentOf(hit.denomination) === segment);
    if (row && base.some((hit) => segmentOf(hit.denomination) !== segment)) corpus.push(row);
  }
  log(`${'corpus'.padEnd(11)} ${summary(corpus)}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
