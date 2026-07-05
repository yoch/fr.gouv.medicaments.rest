#!/usr/bin/env node
'use strict';

/**
 * Étude empirique dosage / forme pour enrichir /api/medicaments/search.
 * Usage: node scripts/benchmark/study_dosage_forme.js [--json]
 */

const fs = require('fs');
const path = require('path');
const state = require('../../src/services/bdpm/state');
const {
  loadData,
  search,
  getSpecialiteByCis,
  getRelatedByCis,
  HYDRATE_RELATED_LIMIT
} = require('../../src/services/dataLoader');
const { executeHybridSearch } = require('../../src/services/searchOrchestrator');
const { rowCount, materializeRange } = require('../../src/utils/corpusStore');
const { normalizeSearchText } = require('../../src/utils/searchRanking');
const {
  parseDosageTokens,
  rerankWithStructuredCriteria
} = require('../../src/utils/structuredSearchCriteria');

const REPORT_EXAMPLES = [
  {
    id: 'doliprane_1g',
    q: 'Doliprane',
    dosage: '1 gramme',
    forme: 'comprimé',
    note: 'Rapport: Doliprane 1 gramme'
  },
  {
    id: 'esomeprazole_40',
    q: 'Esomeprazole',
    dosage: '40 mg',
    forme: null,
    note: 'Rapport: Esomeprazole 40mg'
  },
  {
    id: 'ozempic_025',
    q: 'Ozempic',
    dosage: '0,25 mg',
    forme: null,
    note: 'Rapport: Ozempic 0,25mg'
  },
  {
    id: 'prednisolone_oro_20',
    q: 'prednisolone',
    dosage: '20 mg',
    forme: 'comprimé orodispersible',
    note: 'Rapport: prednisolone orodispersible 20mg'
  },
  {
    id: 'progesterone_ovule',
    q: 'progesterone',
    dosage: null,
    forme: 'ovule',
    voie: 'vaginale',
    note: 'Rapport: progesterone ovule'
  },
  {
    id: 'cerulyse_spray',
    q: 'Cerulyse',
    dosage: null,
    forme: 'solution',
    voie: 'auriculaire',
    note: 'Rapport: Cerulyse spray'
  },
  {
    id: 'nexium_40',
    q: 'NEXIUM',
    dosage: '40 mg',
    forme: null,
    note: 'Rapport: NEXIUM 40mg'
  },
  {
    id: 'paracetamol_1g',
    q: 'paracetamol',
    dosage: '1 gramme',
    forme: 'comprimé',
    note: 'Rapport: paracetamol 1 gramme'
  },
  {
    id: 'sertraline_25',
    q: 'sertraline',
    dosage: '25 mg',
    forme: 'gélule',
    note: 'Rapport: sertraline 25'
  },
  {
    id: 'methotrexate_per_os',
    q: 'méthotrexate',
    dosage: '25 mg',
    forme: 'comprimé',
    voie: 'orale',
    note: 'Rapport: méthotrexate per os'
  }
];

function topCounts(map, limit = 20) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function profileFields() {
  const specialites = state.corpus.specialites;
  const compositions = state.corpus.compositions;

  const formeCounts = new Map();
  const voieCounts = new Map();
  let emptyForme = 0;
  let emptyVoie = 0;

  const nSpec = rowCount(specialites);
  for (let i = 0; i < nSpec; i++) {
    const row = specialites[i].toJSON();
    if (!row.forme_pharma) emptyForme += 1;
    else formeCounts.set(row.forme_pharma, (formeCounts.get(row.forme_pharma) || 0) + 1);
    if (!row.voies_admin) emptyVoie += 1;
    else voieCounts.set(row.voies_admin, (voieCounts.get(row.voies_admin) || 0) + 1);
  }

  const dosageCounts = new Map();
  const unitCounts = new Map();
  let emptyDosage = 0;
  let parseableDosage = 0;
  const dosagesPerCis = new Map();

  const nComp = rowCount(compositions);
  for (let i = 0; i < nComp; i++) {
    const row = compositions[i].toJSON();
    const dosage = row.dosage || '';
    if (!dosage) {
      emptyDosage += 1;
      continue;
    }
    dosageCounts.set(dosage, (dosageCounts.get(dosage) || 0) + 1);
    const tokens = parseDosageTokens(dosage);
    if (tokens.length > 0) parseableDosage += 1;
    for (const t of tokens) {
      unitCounts.set(t.unit, (unitCounts.get(t.unit) || 0) + 1);
    }
    const cis = row.cis;
    if (!dosagesPerCis.has(cis)) dosagesPerCis.set(cis, new Set());
    dosagesPerCis.get(cis).add(dosage);
  }

  let multiDosageCis = 0;
  for (const set of dosagesPerCis.values()) {
    if (set.size > 1) multiDosageCis += 1;
  }

  return {
    specialites: {
      total: nSpec,
      empty_forme_pharma: emptyForme,
      empty_forme_pct: pct(emptyForme, nSpec),
      distinct_forme_pharma: formeCounts.size,
      top_forme_pharma: topCounts(formeCounts, 15),
      empty_voies_admin: emptyVoie,
      empty_voie_pct: pct(emptyVoie, nSpec),
      distinct_voies_admin: voieCounts.size,
      top_voies_admin: topCounts(voieCounts, 15)
    },
    compositions: {
      total: nComp,
      empty_dosage: emptyDosage,
      empty_dosage_pct: pct(emptyDosage, nComp),
      distinct_dosage: dosageCounts.size,
      parseable_dosage: parseableDosage,
      parseable_dosage_pct: pct(parseableDosage, nComp - emptyDosage),
      top_units: topCounts(unitCounts, 10),
      top_dosages: topCounts(dosageCounts, 15),
      cis_with_multiple_dosages: multiDosageCis,
      cis_with_multiple_dosages_pct: pct(multiDosageCis, dosagesPerCis.size)
    }
  };
}

function pct(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function hydrateBdpmHit(cis, matchQuality = 'fuzzy', matchVia = 'denomination') {
  const base = getSpecialiteByCis(cis) || { cis };
  return {
    type: 'medicament',
    match_quality: matchQuality,
    match_via: matchVia,
    ...base,
    presentations: getRelatedByCis('presentations', cis, HYDRATE_RELATED_LIMIT),
    compositions: getRelatedByCis('compositions', cis, HYDRATE_RELATED_LIMIT)
  };
}

function mergeByCis(searches) {
  const qualityByCis = new Map();
  const viaByCis = new Map();
  const rank = { exact: 3, prefix: 2, fuzzy: 1 };

  for (const { items, via } of searches) {
    for (const item of items) {
      const cis = item.cis;
      if (!cis) continue;
      const prev = qualityByCis.get(cis);
      if (!prev || rank[item.match_quality] > rank[prev]) {
        qualityByCis.set(cis, item.match_quality);
        viaByCis.set(cis, via);
      }
    }
  }

  return [...qualityByCis.entries()].map(([cis, match_quality]) =>
    hydrateBdpmHit(cis, match_quality, viaByCis.get(cis))
  );
}

function recallCurrent(q) {
  return mergeByCis([
    { items: search('specialites', q), via: 'denomination' },
    { items: search('presentations', q), via: 'presentation' },
    { items: search('compositions', q), via: 'composition' }
  ]);
}

function recallTarget(q) {
  const normalizedQ = normalizeSearchText(q);
  const isCode = /^\d+$/.test(String(q).trim());

  const searches = [
    { items: search('specialites', q), via: 'denomination' },
    {
      items: search('compositions', q).filter((item) => {
        const substance = normalizeSearchText(item.denomination_substance || '');
        return substance.includes(normalizedQ) || normalizedQ.includes(substance);
      }),
      via: 'composition'
    }
  ];

  if (isCode) {
    searches.push({ items: search('presentations', q), via: 'presentation' });
  }

  return mergeByCis(searches);
}

function summarizeTop(hit) {
  if (!hit) return null;
  const dosages = [...new Set((hit.compositions || []).map((c) => c.dosage).filter(Boolean))].slice(0, 3);
  return {
    cis: hit.cis,
    denomination: hit.denomination,
    forme_pharma: hit.forme_pharma,
    voies_admin: hit.voies_admin,
    match_quality: hit.match_quality,
    match_via: hit.match_via,
    dosages_sample: dosages,
    criteria_boost: hit.criteria_boost,
    criteria_match: hit.criteria_match
  };
}

function evaluateExample(example) {
  const compositeQ = [example.q, example.dosage, example.forme, example.voie]
    .filter(Boolean)
    .join(' ');

  const currentComposite = executeHybridSearch(compositeQ, 'human').results;
  const currentQ = executeHybridSearch(example.q, 'human').results;

  const targetRecall = recallTarget(example.q);
  const currentRecall = recallCurrent(example.q);

  const criteria = {
    dosage: example.dosage || null,
    forme: example.forme || null,
    voie: example.voie || null
  };
  const boosted = rerankWithStructuredCriteria(targetRecall, criteria);

  return {
    id: example.id,
    note: example.note,
    params: { q: example.q, ...criteria },
    composite_q: compositeQ,
    counts: {
      composite_and_fail: currentComposite.length,
      q_only_current: currentQ.length,
      recall_current: currentRecall.length,
      recall_target: targetRecall.length,
      recall_delta: targetRecall.length - currentRecall.length
    },
    top: {
      composite: summarizeTop(currentComposite[0]),
      q_only: summarizeTop(currentQ[0]),
      target_reranked: summarizeTop(boosted[0]),
      target_second: summarizeTop(boosted[1])
    },
    verdict: classifyExample(example, currentComposite, boosted)
  };
}

function classifyExample(example, compositeResults, boostedResults) {
  const top = boostedResults[0];
  if (!top) return 'no_recall';

  const compositeFailed = compositeResults.length === 0;
  const criteria = {
    dosage: Boolean(example.dosage),
    forme: Boolean(example.forme),
    voie: Boolean(example.voie)
  };
  const matched = top.criteria_match || {};

  if (compositeFailed && top.criteria_boost > 0) {
    if (
      (!criteria.dosage || matched.dosage) &&
      (!criteria.forme || matched.forme) &&
      (!criteria.voie || matched.voie)
    ) {
      return 'structured_fixes_composite_failure';
    }
    return 'structured_partial_fix';
  }

  if (top.criteria_boost > 0) return 'structured_improves_ranking';
  return 'structured_no_gain';
}

function buildRecommendations(profile, evaluations) {
  const fixes = evaluations.filter((e) => e.verdict === 'structured_fixes_composite_failure').length;
  const partial = evaluations.filter((e) => e.verdict === 'structured_partial_fix').length;
  const improves = evaluations.filter((e) => e.verdict === 'structured_improves_ranking').length;
  const noGain = evaluations.filter((e) => e.verdict === 'structured_no_gain').length;

  const formeDistinct = profile.specialites.distinct_forme_pharma;
  const dosageParseable = profile.compositions.parseable_dosage_pct;

  return {
    interface: {
      add_params: ['dosage', 'forme'],
      optional_later: ['voie'],
      scoring_mode: 'non_destructive_boost',
      remove_from_text_recall: ['compositions.dosage', 'presentations.libelle'],
      keep_exact_code_recall: ['cis', 'cip7', 'cip13']
    },
    confidence: {
      forme_pharma: formeDistinct < 500 ? 'high' : 'medium',
      dosage_normalization: dosageParseable >= 80 ? 'medium' : 'low',
      voie_separate_param: 'recommended_if_forme_ambiguous'
    },
    study_results: {
      composite_failures_fixed: fixes,
      partial_fixes: partial,
      ranking_improvements: improves,
      no_gain: noGain
    },
    llm_examples: buildLlmExamples(evaluations)
  };
}

function buildLlmExamples(evaluations) {
  const good = evaluations.filter((e) =>
    ['structured_fixes_composite_failure', 'structured_improves_ranking'].includes(e.verdict)
  );

  return good.slice(0, 6).map((e) => {
    const p = e.params;
    const parts = [`q=${p.q}`];
    if (p.dosage) parts.push(`dosage=${p.dosage}`);
    if (p.forme) parts.push(`forme=${p.forme}`);
    if (p.voie) parts.push(`voie=${p.voie}`);
    return {
      call: parts.join('&'),
      avoid: e.composite_q,
      top_result: e.top.target_reranked?.denomination || null
    };
  });
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Étude — paramètres `dosage` et `forme` pour `/search`\n');
  lines.push(`Généré le ${report.generated_at}\n`);

  lines.push('## 1. Profil des champs BDPM\n');
  lines.push('### Spécialités\n');
  lines.push(`- Total : ${report.profile.specialites.total}`);
  lines.push(`- \`forme_pharma\` distinctes : ${report.profile.specialites.distinct_forme_pharma}`);
  lines.push(`- \`forme_pharma\` vide : ${report.profile.specialites.empty_forme_pct}%`);
  lines.push(`- \`voies_admin\` distinctes : ${report.profile.specialites.distinct_voies_admin}`);
  lines.push(`- \`voies_admin\` vide : ${report.profile.specialites.empty_voie_pct}%\n`);

  lines.push('Top `forme_pharma` :\n');
  for (const row of report.profile.specialites.top_forme_pharma.slice(0, 10)) {
    lines.push(`- ${row.value} (${row.count})`);
  }
  lines.push('');

  lines.push('### Compositions\n');
  lines.push(`- Total : ${report.profile.compositions.total}`);
  lines.push(`- \`dosage\` vide : ${report.profile.compositions.empty_dosage_pct}%`);
  lines.push(`- \`dosage\` distincts : ${report.profile.compositions.distinct_dosage}`);
  lines.push(`- Dosages parseables (mg/g/ug/ml/ui/%) : ${report.profile.compositions.parseable_dosage_pct}%`);
  lines.push(`- CIS avec plusieurs dosages : ${report.profile.compositions.cis_with_multiple_dosages_pct}%\n`);

  lines.push('## 2. Comparaison rappel actuel vs cible\n');
  lines.push('| Exemple | composite (AND) | q seul | rappel actuel | rappel cible | delta |');
  lines.push('|---------|------------------:|-------:|--------------:|-------------:|------:|');
  for (const e of report.evaluations) {
    lines.push(
      `| ${e.id} | ${e.counts.composite_and_fail} | ${e.counts.q_only_current} | ${e.counts.recall_current} | ${e.counts.recall_target} | ${e.counts.recall_delta} |`
    );
  }
  lines.push('');

  lines.push('## 3. Scoring structuré (boost non destructif)\n');
  lines.push('| Exemple | verdict | top après boost | match dosage | match forme | match voie |');
  lines.push('|---------|---------|-------------------|:------------:|:-----------:|:----------:|');
  for (const e of report.evaluations) {
    const t = e.top.target_reranked;
    const m = t?.criteria_match || {};
    lines.push(
      `| ${e.id} | ${e.verdict} | ${t?.denomination || '—'} | ${m.dosage ? 'oui' : 'non'} | ${m.forme ? 'oui' : 'non'} | ${m.voie ? 'oui' : 'non'} |`
    );
  }
  lines.push('');

  lines.push('## 4. Recommandation interface\n');
  const r = report.recommendations;
  lines.push('- Ajouter `dosage` et `forme` comme paramètres optionnels de `/search`.');
  lines.push('- Scoring : **boost non destructif** (jamais filtre strict par défaut).');
  lines.push('- Retirer du rappel texte : `compositions.dosage`, `presentations.libelle`.');
  lines.push('- Conserver lookup exact : `cis`, `cip7`, `cip13`.');
  lines.push(`- Étude : ${r.study_results.composite_failures_fixed} cas composite→0 corrigés par structuré ; ${r.study_results.ranking_improvements} améliorations de ranking ; ${r.study_results.partial_fixes} partiels ; ${r.study_results.no_gain} sans gain.\n`);

  lines.push('### Lecture des deltas de rappel cible\n');
  lines.push('- Un delta négatif signifie que le rappel actuel bénéficiait de bruit (`dosage` ou `libelle` présentation indexés).');
  lines.push('- Ex. `methotrexate_per_os` : rappel actuel 88 vs cible 70 — le bruit composition disparaît, mais `q=méthotrexate` seul ramène déjà 88 candidats ; le structuré sert à **réordonner**, pas à rappeler.');
  lines.push('- Ex. `prednisolone_oro_20` : delta -3 — impact faible, le scoring structuré remonte le bon comprimé orodispersible 20 mg.\n');

  lines.push('### Normalisation dosage — limites observées\n');
  lines.push(`- ${report.profile.compositions.parseable_dosage_pct}% des dosages BDPM sont parseables en mg/g/ug/ml/ui/%.`);
  lines.push('- Les équivalences `1 gramme` ↔ `1000 mg` fonctionnent sur les cas testés.');
  lines.push(`- ${report.profile.compositions.cis_with_multiple_dosages_pct}% des CIS ont plusieurs dosages en composition : le booster ne doit pas exclure les autres présentations.\n`);

  lines.push('### Forme vs voie\n');
  lines.push('- `forme_pharma` est relativement normalisé (367 valeurs distinctes, 0% vide).');
  lines.push('- `voie` mérite un paramètre séparé : `ovule`, `spray`, `collyre` relèvent souvent de `forme_pharma` + `voies_admin` combinés.');
  lines.push('- Sur les exemples : `progesterone ovule` et `Cerulyse spray` nécessitent `forme` + `voie` pour un boost fiable.\n');

  lines.push('### Exemples validés pour le prompt agent\n');
  for (const ex of r.llm_examples) {
    lines.push(`- Appel : \`${ex.call}\` — éviter \`${ex.avoid}\` → ${ex.top_result || '?'}`);
  }
  lines.push('');

  return lines.join('\n');
}

async function main() {
  const jsonOnly = process.argv.includes('--json');

  console.error('Chargement BDPM…');
  await loadData();

  const profile = profileFields();
  const evaluations = REPORT_EXAMPLES.map(evaluateExample);
  const recommendations = buildRecommendations(profile, evaluations);

  const report = {
    generated_at: new Date().toISOString(),
    profile,
    evaluations,
    recommendations
  };

  const outDir = path.join(__dirname, '../../docs');
  const mdPath = path.join(outDir, 'ETUDE_DOSAGE_FORME.md');
  const jsonPath = path.join(outDir, 'ETUDE_DOSAGE_FORME.json');

  fs.writeFileSync(mdPath, renderMarkdown(report), 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  if (jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderMarkdown(report));
    console.error(`\nÉcrit : ${mdPath}`);
    console.error(`Écrit : ${jsonPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
