/**
 * Analyse des réponses /search pour usage LLM (taille, redondance, couverture).
 * Usage: node tests/analyze_search_llm.js
 */
const { loadData } = require('../../src/services/dataLoader');
const { executeHybridSearch } = require('../../src/services/searchOrchestrator');
const { getSpecialiteByCis, getRelatedByCis } = require('../../src/services/dataLoader');

const QUERIES = [
  { q: 'doliprane', desc: 'marque exacte connue' },
  { q: '60234100', desc: 'CIS exact' },
  { q: 'paracetamol', desc: 'substance (nombreux résultats)' },
  { q: 'amoxicilline', desc: 'antibiotique courant' },
  { q: 'metformine', desc: 'diabète' },
  { q: 'omeprazole', desc: 'IPP' },
  { q: 'doli', desc: 'préfixe court' },
  { q: 'dolipranr', desc: 'fuzzy typo' },
  { q: 'insuline glargine', desc: 'molécule + forme' },
  { q: 'N02BE01', desc: 'code ATC (edge)' },
  { q: 'vaccin grippe', desc: 'requête vague' },
  { q: 'ivermectine', desc: 'peut toucher vet (auto)' }
];

function byteSize(obj) {
  return Buffer.byteLength(JSON.stringify(obj), 'utf8');
}

function compactMedicament(item) {
  const substances = [...new Set((item.compositions || []).map((c) => c.denomination_substance).filter(Boolean))];
  const presentationsSummary = (item.presentations || []).slice(0, 5).map((p) => ({
    libelle: p.libelle,
    cip13: p.cip13,
    etat: p.etat_commercialisation
  }));
  return {
    type: item.type,
    cis: item.cis,
    num: item.num,
    denomination: item.denomination || item.nom,
    forme_pharma: item.forme_pharma,
    voies_admin: item.voies_admin,
    titulaire: item.titulaire,
    commercialisation: item.commercialisation,
    match_quality: item.match_quality,
    url_bdpm: item.url_bdpm,
    substances,
    presentations_count: (item.presentations || []).length,
    presentations_sample: presentationsSummary,
    compositions_count: (item.compositions || []).length
  };
}

function analyzeQuery(q) {
  const { results, search } = executeHybridSearch(q, 'human');
  const limit5 = results.slice(0, 5);
  const fullBytes = byteSize({ data: limit5, search });
  const compact = limit5.map(compactMedicament);
  const compactBytes = byteSize({ data: compact, search });

  const presCounts = results.map((r) => (r.presentations || []).length);
  const compCounts = results.map((r) => (r.compositions || []).length);

  return {
    q,
    total: results.length,
    top_match: results[0]?.match_quality,
    top_label: results[0]?.denomination || results[0]?.nom,
    pres_max: presCounts.length ? Math.max(...presCounts) : 0,
    pres_avg_top5: presCounts.slice(0, 5).reduce((a, b) => a + b, 0) / Math.min(5, presCounts.length) || 0,
    comp_avg_top5: compCounts.slice(0, 5).reduce((a, b) => a + b, 0) / Math.min(5, compCounts.length) || 0,
    bytes_full_top5: fullBytes,
    bytes_compact_top5: compactBytes,
    ratio_compact: compactBytes / fullBytes
  };
}

function fieldRedundancySample() {
  const { results } = executeHybridSearch('paracetamol', 'human');
  const first = results[0];
  if (!first) return null;
  const pres = first.presentations?.[0];
  const comp = first.compositions?.[0];
  const cisRepeatedPres = pres ? Object.keys(pres).filter((k) => k === 'cis').length : 0;
  const emptyFieldsPres = pres ? Object.entries(pres).filter(([, v]) => v === '' || v == null).map(([k]) => k) : [];
  const emptyFieldsComp = comp ? Object.entries(comp).filter(([, v]) => v === '' || v == null).map(([k]) => k) : [];
  return {
    cis: first.cis,
    denomination: first.denomination,
    n_presentations: first.presentations?.length,
    n_compositions: first.compositions?.length,
    presentation_fields: pres ? Object.keys(pres) : [],
    empty_in_first_presentation: emptyFieldsPres,
    empty_in_first_composition: emptyFieldsComp,
    indications_len: pres?.indications?.length || 0
  };
}

function compareSearchVsDetail() {
  const cis = '60234100';
  const { results } = executeHybridSearch(cis, 'human');
  const fromSearch = results.find((r) => r.cis === cis);
  const specialite = getSpecialiteByCis(cis);
  const presentations = getRelatedByCis('presentations', cis, 0);
  const compositions = getRelatedByCis('compositions', cis, 0);

  const searchItem = fromSearch || results[0];
  return {
    cis,
    search_bytes: byteSize(searchItem),
    detail_core_bytes: byteSize({ ...specialite, presentations, compositions }),
    search_n_pres: searchItem?.presentations?.length,
    detail_n_pres: presentations.length,
    search_n_comp: searchItem?.compositions?.length,
    detail_n_comp: compositions.length
  };
}

async function main() {
  console.log('Chargement des données…');
  await loadData();

  console.log('\n=== Analyse par requête (source=human, top 5) ===\n');
  console.log(
    'q'.padEnd(22),
    'total'.padStart(6),
    'match'.padStart(8),
    'pres↑'.padStart(6),
    'full KB'.padStart(8),
    'compact'.padStart(8),
    'ratio'.padStart(6)
  );
  console.log('-'.repeat(72));

  for (const { q, desc } of QUERIES) {
    const row = analyzeQuery(q);
    console.log(
      q.padEnd(22),
      String(row.total).padStart(6),
      (row.top_match || '-').padStart(8),
      String(row.pres_max).padStart(6),
      (row.bytes_full_top5 / 1024).toFixed(1).padStart(7) + 'K',
      (row.bytes_compact_top5 / 1024).toFixed(1).padStart(7) + 'K',
      (row.ratio_compact * 100).toFixed(0).padStart(5) + '%'
    );
  }

  console.log('\n=== Échantillon redondance (paracetamol #1) ===\n');
  console.log(JSON.stringify(fieldRedundancySample(), null, 2));

  console.log('\n=== Search vs détail CIS 60234100 ===\n');
  console.log(JSON.stringify(compareSearchVsDetail(), null, 2));

  const defaultLimit = 50;
  const { results: paraResults } = executeHybridSearch('paracetamol', 'human');
  const defaultPage = paraResults.slice(0, defaultLimit);
  console.log('\n=== Impact limit=50 (paracetamol) ===');
  console.log(`Résultats paginés: ${defaultPage.length}, taille JSON: ${(byteSize({ data: defaultPage }) / 1024 / 1024).toFixed(2)} Mo`);

  const { results: autoVet } = executeHybridSearch('ivermectine', 'auto');
  console.log('\n=== Auto source (ivermectine) ===');
  console.log(`Résultats: ${autoVet.length}, types: ${[...new Set(autoVet.map((r) => r.type))].join(', ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
