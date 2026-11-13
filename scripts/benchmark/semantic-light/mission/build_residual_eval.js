'use strict';

/**
 * Construit le benchmark complémentaire de sondes résiduelles non-cliniques
 * (eval_residual_v1.json) ciblant les cas difficiles après B2 :
 *   - R1_severe_typos : fautes multi-caractères / phonétiques dépassant fuzzy 0.2
 *   - R2_patient_noise_unaliased : formulations / contenants hors table PHARMA_ALIASES
 *   - R3_crosslingual_inn : variantes DCI internationales (US/EN/FR)
 *   - R4_traps_impossible_oos : gardes anti-hallucination sémantique (pièges/OOS)
 *
 * Strictement séparé en dev/heldout par cluster SHA1, ancré BDPM/ANMV sans RCP.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { loadData, getBdpmCorpusStats } = require('../../../../src/services/dataLoader');
const { loadVetData, getVetCorpusStats } = require('../../../../src/services/vetDataLoader');
const { normalizeSearchText } = require('../../../../src/utils/searchRanking');

function stableBucket(key) {
  const digest = crypto.createHash('sha1').update(`res_v1:${String(key)}`).digest();
  return digest[0] % 2; // 0 = dev, 1 = heldout
}

function makeLookup(bdpm, vet) {
  const compByCis = new Map();
  for (const c of bdpm.compositions) {
    if (!compByCis.has(c.cis)) compByCis.set(c.cis, []);
    compByCis.get(c.cis).push(c);
  }
  const presByCis = new Map();
  for (const p of bdpm.presentations) {
    if (!presByCis.has(p.cis)) presByCis.set(p.cis, []);
    presByCis.get(p.cis).push(p);
  }
  const vetCompByNum = new Map();
  for (const c of vet.compositions) {
    if (!vetCompByNum.has(c.num)) vetCompByNum.set(c.num, []);
    vetCompByNum.get(c.num).push(c);
  }
  return { compByCis, presByCis, vetCompByNum };
}

function findBdpm(bdpm, lookup, pred) {
  const out = [];
  for (const s of bdpm.specialites) {
    const comps = lookup.compByCis.get(s.cis) || [];
    const pres = lookup.presByCis.get(s.cis) || [];
    const subs = comps.map((c) => normalizeSearchText(c.denomination_substance));
    const normDenom = normalizeSearchText(s.denomination);
    const normForme = normalizeSearchText(s.forme_pharma);
    const normVoie = normalizeSearchText(s.voies_admin);
    const saCount = new Set(
      comps.filter((c) => c.nature_composant === 'SA').map((c) => c.code_substance).filter(Boolean)
    ).size || subs.length;
    if (pred({ s, comps, pres, subs, normDenom, normForme, normVoie, saCount })) {
      out.push(s.cis);
    }
  }
  return out;
}

function findVet(vet, lookup, pred) {
  const out = [];
  for (const m of vet.medicaments) {
    const comps = lookup.vetCompByNum.get(m.num) || [];
    const subs = comps.map((c) => normalizeSearchText(c.substance));
    const normNom = normalizeSearchText(m.nom);
    const normForme = normalizeSearchText(m.forme_pharmaceutique);
    const normSpecies = (m.especes || []).map((e) => normalizeSearchText(e));
    if (pred({ m, comps, subs, normNom, normForme, normSpecies })) out.push(m.num);
  }
  return out;
}

function corruptSevere(word) {
  if (!word || word.length < 5) return word;
  let s = word
    .replace(/ph/g, 'f')
    .replace(/th/g, 't')
    .replace(/qu/g, 'k')
    .replace(/y/g, 'i')
    .replace(/x/g, 'cs');
  if (s !== word && s.length >= 6) return s;
  // Double altération phonétique + transposition si mot simple
  const arr = s.split('');
  if (arr.length >= 6) {
    const tmp = arr[2];
    arr[2] = arr[3];
    arr[3] = tmp;
    if (arr.length >= 7) arr.splice(arr.length - 2, 1);
  }
  return arr.join('');
}

async function main() {
  await loadData();
  await loadVetData();
  const bdpm = getBdpmCorpusStats().corpus;
  const vet = getVetCorpusStats().corpus;
  const lookup = makeLookup(bdpm, vet);

  const cases = [];
  const addCase = (c) => {
    const split = c.split || (stableBucket(c.cluster) === 0 ? 'dev' : 'heldout');
    cases.push({ ...c, split });
  };

  // --- Curated R1_severe_typos (dépassent fuzzy 0.2 ou double altération) ---
  const r1CuratedSpecs = [
    {
      id: 'res_r1_mauprel',
      cluster: 'res_omeprazole_mopral',
      q: 'mauprel 20 mg',
      varPred: ({ normDenom }) => normDenom.startsWith('mopral') && normDenom.includes('20 mg'),
      idPred: ({ normDenom }) => normDenom.startsWith('mopral')
    },
    {
      id: 'res_r1_kardejik',
      cluster: 'res_kardegic',
      q: 'kardejik 75 mg',
      varPred: ({ normDenom }) => normDenom.startsWith('kardegic') && normDenom.includes('75 mg'),
      idPred: ({ normDenom }) => normDenom.startsWith('kardegic')
    },
    {
      id: 'res_r1_spasphom',
      cluster: 'res_spasfon',
      q: 'spasphom 80 mg',
      varPred: ({ normDenom }) => normDenom.startsWith('spasfon') && normDenom.includes('80 mg'),
      idPred: ({ normDenom }) => normDenom.startsWith('spasfon')
    },
    {
      id: 'res_r1_taore',
      cluster: 'res_tahor',
      q: 'taore 10 mg',
      varPred: ({ normDenom }) => normDenom.startsWith('tahor') && normDenom.includes('10 mg'),
      idPred: ({ normDenom }) => normDenom.startsWith('tahor')
    },
    {
      id: 'res_r1_plavics',
      cluster: 'res_plavix',
      q: 'plavics 75 mg',
      varPred: ({ normDenom }) => normDenom.startsWith('plavix') && normDenom.includes('75 mg'),
      idPred: ({ normDenom }) => normDenom.startsWith('plavix')
    },
    {
      id: 'res_r1_parasetamol_comprimee',
      cluster: 'res_paracetamol_typo',
      q: 'parasetamole 1 g',
      varPred: ({ subs, normDenom, saCount }) => saCount === 1 && subs.some((x) => x.startsWith('paracetamol')) && (normDenom.includes('1000 mg') || normDenom.includes('1 g')),
      idPred: ({ subs, saCount }) => saCount === 1 && subs.some((x) => x.startsWith('paracetamol'))
    },
    {
      id: 'res_r1_azitromicine',
      cluster: 'res_azithromycine',
      q: 'azitromicine 250 mg',
      varPred: ({ subs, normDenom, saCount }) => saCount === 1 && subs.some((x) => x.startsWith('azithromycine')) && normDenom.includes('250 mg'),
      idPred: ({ subs }) => subs.some((x) => x.startsWith('azithromycine'))
    },
    {
      id: 'res_r1_ibupfrofene',
      cluster: 'res_ibuprofene_typo',
      q: 'ibupfrofene 400 mg',
      varPred: ({ subs, normDenom, saCount }) => saCount === 1 && subs.some((x) => x.startsWith('ibuprofene')) && normDenom.includes('400 mg'),
      idPred: ({ subs }) => subs.some((x) => x.startsWith('ibuprofene'))
    },
    {
      id: 'res_r1_augmentain',
      cluster: 'res_augmentin_typo',
      q: 'augmentain 1 g',
      varPred: ({ normDenom }) => normDenom.startsWith('augmentin') && normDenom.includes('1 g'),
      idPred: ({ normDenom }) => normDenom.startsWith('augmentin')
    },
    {
      id: 'res_r1_xanacs',
      cluster: 'res_xanax',
      q: 'xanacs 0,25 mg',
      varPred: ({ normDenom }) => normDenom.startsWith('xanax') && normDenom.includes('0,25 mg'),
      idPred: ({ normDenom }) => normDenom.startsWith('xanax')
    }
  ];

  for (const spec of r1CuratedSpecs) {
    const varIds = findBdpm(bdpm, lookup, spec.varPred);
    const idIds = findBdpm(bdpm, lookup, spec.idPred);
    if (varIds.length === 0) throw new Error(`No matches for ${spec.id}`);
    addCase({
      id: spec.id,
      family: 'R1_severe_typos',
      cluster: spec.cluster,
      provenance: 'curated',
      q: spec.q,
      source: 'auto',
      expectedVariantIds: varIds,
      expectedIdentityIds: idIds,
      trapIds: []
    });
  }

  // --- Programmatic R1 severe typos from corpus brands ---
  const seenBrands = new Set(['mopral', 'dexeryl', 'spasfon', 'tahor', 'plavix', 'augmentin', 'xanax', 'doliprane', 'hexamidine']);
  let genCount = 0;
  for (const s of bdpm.specialites) {
    if (genCount >= 24) break;
    if (s.commercialisation !== 'Commercialisée') continue;
    const normDenom = normalizeSearchText(s.denomination);
    const m = /^([a-z]{6,12})\s+(\d+(?:,\d+)?\s*(?:mg|g|ml|ui))\b/.exec(normDenom);
    if (!m) continue;
    const brand = m[1];
    const dose = m[2];
    if (seenBrands.has(brand) || brand.endsWith('euse') || brand === 'acide' || brand === 'chlorhydrate') continue;
    seenBrands.add(brand);
    const mutated = corruptSevere(brand);
    if (mutated === brand) continue;
    const varIds = findBdpm(bdpm, lookup, ({ normDenom: nd }) => nd.startsWith(`${brand} `) && nd.includes(dose));
    const idIds = findBdpm(bdpm, lookup, ({ normDenom: nd }) => nd.startsWith(`${brand} `));
    if (varIds.length === 0) continue;
    genCount++;
    addCase({
      id: `res_r1_gen_${brand}`,
      family: 'R1_severe_typos',
      cluster: `brand_${brand}`,
      provenance: 'corpus_generated',
      q: `${mutated} ${dose}`,
      source: 'auto',
      expectedVariantIds: varIds,
      expectedIdentityIds: idIds,
      trapIds: []
    });
  }

  // --- Curated R2_patient_noise_unaliased (hors table PHARMA_ALIASES) ---
  const r2Specs = [
    {
      id: 'res_r2_pommade_diclofenac',
      cluster: 'res_diclofenac_topique',
      q: 'pommade diclofenac',
      source: 'auto',
      varPred: ({ subs, normForme }) => subs.some((x) => x.startsWith('diclofenac')) && (normForme.includes('gel') || normForme.includes('creme') || normForme.includes('pommade')),
      idPred: ({ subs }) => subs.some((x) => x.startsWith('diclofenac')),
      trapPred: ({ subs, normForme }) => subs.some((x) => x.startsWith('diclofenac')) && normForme.includes('comprime')
    },
    {
      id: 'res_r2_ibuprofene_avaler',
      cluster: 'res_ibuprofene_oral',
      q: 'ibuprofene comprime a avaler',
      source: 'auto',
      varPred: ({ subs, normForme, saCount }) => saCount === 1 && subs.some((x) => x.startsWith('ibuprofene')) && normForme.includes('comprime'),
      idPred: ({ subs }) => subs.some((x) => x.startsWith('ibuprofene')),
      trapPred: ({ subs, normForme }) => subs.some((x) => x.startsWith('ibuprofene')) && normForme.includes('gel')
    },
    {
      id: 'res_r2_medicament_metacam_chien',
      cluster: 'res_vet_metacam',
      q: 'medicament metacam chien',
      source: 'auto',
      isVet: true,
      varPred: ({ normNom, normSpecies }) => normNom.startsWith('metacam') && normSpecies.some((x) => x.includes('chien')),
      idPred: ({ normNom }) => normNom.startsWith('metacam')
    },
    {
      id: 'res_r2_medicament_vet_shotapen_chien',
      cluster: 'res_vet_shotapen',
      q: 'medicament shotapen pour chien',
      source: 'auto',
      isVet: true,
      varPred: ({ normNom, normSpecies }) => normNom.startsWith('shotapen') && normSpecies.some((x) => x.includes('chien')),
      idPred: ({ normNom }) => normNom.startsWith('shotapen')
    },
    {
      id: 'res_r2_pastille_flurbiprofene',
      cluster: 'res_flurbiprofene_sucer',
      q: 'pastille flurbiprofene',
      source: 'auto',
      varPred: ({ subs, normForme }) => subs.some((x) => x.includes('flurbiprofene')) && (normForme.includes('pastille') || normForme.includes('sucer')),
      idPred: ({ subs }) => subs.some((x) => x.includes('flurbiprofene'))
    },
    {
      id: 'res_r2_bain_bouche_chlorhexidine',
      cluster: 'res_chlorhexidine_bouche',
      q: 'bain de bouche chlorhexidine',
      source: 'auto',
      varPred: ({ subs, normForme }) => subs.some((x) => x.includes('chlorhexidine')) && normForme.includes('bain de bouche'),
      idPred: ({ subs }) => subs.some((x) => x.includes('chlorhexidine'))
    },
    {
      id: 'res_r2_tube_aciclovir',
      cluster: 'res_aciclovir_creme',
      q: 'tube aciclovir',
      source: 'auto',
      varPred: ({ subs, normForme }) => subs.some((x) => x.includes('aciclovir')) && (normForme.includes('creme') || normForme.includes('pommade')),
      idPred: ({ subs }) => subs.some((x) => x.includes('aciclovir')),
      trapPred: ({ subs, normForme }) => subs.some((x) => x.includes('aciclovir')) && normForme.includes('comprime')
    },
    {
      id: 'res_r2_gellule_amoxicilline',
      cluster: 'res_amoxicilline_gelule',
      q: 'amoxicilline gellule 500 mg',
      source: 'auto',
      varPred: ({ subs, normForme, normDenom, saCount }) => saCount === 1 && subs.some((x) => x.startsWith('amoxicilline')) && normForme.includes('gelule') && normDenom.includes('500 mg'),
      idPred: ({ subs, saCount }) => saCount === 1 && subs.some((x) => x.startsWith('amoxicilline'))
    },
    {
      id: 'res_r2_flacon_polyfra_collyre',
      cluster: 'res_bepanthene_creme',
      q: 'creme dermique econazole',
      source: 'auto',
      varPred: ({ subs, normForme }) => subs.some((x) => x.includes('econazole')) && normForme.includes('creme'),
      idPred: ({ subs }) => subs.some((x) => x.includes('econazole'))
    },
    {
      id: 'res_r2_stylo_insuline_aspart',
      cluster: 'res_insuline_aspart',
      q: 'stylo insuline asparte',
      source: 'auto',
      varPred: ({ subs, pres, normForme }) => subs.some((x) => x.includes('insuline asparte')) && (normForme.includes('stylo') || pres.some((p) => normalizeSearchText(p.libelle).includes('stylo'))),
      idPred: ({ subs }) => subs.some((x) => x.includes('insuline asparte'))
    }
  ];

  for (const spec of r2Specs) {
    const varIds = spec.isVet ? findVet(vet, lookup, spec.varPred) : findBdpm(bdpm, lookup, spec.varPred);
    const idIds = spec.isVet ? findVet(vet, lookup, spec.idPred) : findBdpm(bdpm, lookup, spec.idPred);
    const trapIds = spec.trapPred ? findBdpm(bdpm, lookup, spec.trapPred) : [];
    if (varIds.length === 0) throw new Error(`No matches for ${spec.id}`);
    addCase({
      id: spec.id,
      family: 'R2_patient_noise_unaliased',
      cluster: spec.cluster,
      provenance: 'curated',
      q: spec.q,
      source: spec.source,
      expectedVariantIds: varIds,
      expectedIdentityIds: idIds,
      trapIds
    });
  }

  // --- Curated R3_crosslingual_inn ---
  const r3Specs = [
    { id: 'res_r3_acetaminophen', cluster: 'res_cl_paracetamol', q: 'acetaminophen 500 mg', frSub: 'paracetamol', dose: '500 mg' },
    { id: 'res_r3_albuterol', cluster: 'res_cl_salbutamol', q: 'albuterol inhalation', frSub: 'salbutamol', dose: null },
    { id: 'res_r3_epinephrine', cluster: 'res_cl_adrenaline', q: 'epinephrine injectable', frSub: 'adrenaline', dose: null },
    { id: 'res_r3_amoxicillin', cluster: 'res_cl_amoxicilline', q: 'amoxicillin 1 g', frSub: 'amoxicilline', dose: '1 g' },
    { id: 'res_r3_ibuprofen', cluster: 'res_cl_ibuprofene', q: 'ibuprofen 400 mg', frSub: 'ibuprofene', dose: '400 mg' },
    { id: 'res_r3_metformin', cluster: 'res_cl_metformine', q: 'metformin 850 mg', frSub: 'metformine', dose: '850 mg' },
    { id: 'res_r3_omeprazol', cluster: 'res_cl_omeprazole_en', q: 'omeprazol 20 mg', frSub: 'omeprazole', dose: '20 mg' },
    { id: 'res_r3_atorvastatin', cluster: 'res_cl_atorvastatine', q: 'atorvastatin 20 mg', frSub: 'atorvastatine', dose: '20 mg' }
  ];

  for (const spec of r3Specs) {
    const varIds = findBdpm(bdpm, lookup, ({ subs, normDenom, saCount }) => {
      if (saCount !== 1 || !subs.some((x) => x.includes(spec.frSub))) return false;
      if (!spec.dose) return true;
      if (spec.dose === '1 g') return normDenom.includes('1 g') || normDenom.includes('1000 mg');
      return normDenom.includes(spec.dose);
    });
    const idIds = findBdpm(bdpm, lookup, ({ subs, saCount }) => saCount === 1 && subs.some((x) => x.includes(spec.frSub)));
    if (varIds.length === 0) throw new Error(`No matches for ${spec.id}`);
    addCase({
      id: spec.id,
      family: 'R3_crosslingual_inn',
      cluster: spec.cluster,
      provenance: 'curated',
      q: spec.q,
      source: 'auto',
      expectedVariantIds: varIds,
      expectedIdentityIds: idIds,
      trapIds: []
    });
  }

  // --- Curated R4_traps_impossible_oos ---
  const r4Traps = [
    { id: 'res_r4_imp_dose', cluster: 'trap_paracetamol_huge', q: 'paracetamol 50000 mg', impossible: true, forbidCriteriaSatisfied: ['dosage'] },
    { id: 'res_r4_imp_forme', cluster: 'trap_aspirine_collyre', q: 'aspirine collyre ophtalmique', impossible: true, forbidCriteriaSatisfied: ['forme', 'voie'] },
    { id: 'res_r4_imp_code', cluster: 'trap_missing_code_2', q: '99999998', impossible: true },
    { id: 'res_r4_oos_fictif', cluster: 'oos_fictif', q: 'medicament imaginaire zlorp', oos: true },
    { id: 'res_r4_oos_sommeil', cluster: 'oos_clinical_sleep', q: 'que prendre pour bien dormir', oos: true },
    { id: 'res_r4_oos_toux', cluster: 'oos_clinical_toux', q: 'quel sirop contre toux seche', oos: true }
  ];
  for (const t of r4Traps) {
    addCase({
      ...t,
      family: 'R4_traps_impossible_oos',
      provenance: 'curated',
      source: 'auto'
    });
  }

  const counts = {
    total: cases.length,
    dev: cases.filter((c) => c.split === 'dev').length,
    heldout: cases.filter((c) => c.split === 'heldout').length,
    byFamily: {}
  };
  for (const c of cases) {
    const f = (counts.byFamily[c.family] ??= { dev: 0, heldout: 0 });
    f[c.split]++;
  }

  const outPath = path.join(__dirname, 'eval_residual_v1.json');
  fs.writeFileSync(outPath, `${JSON.stringify({ version: 1, counts, cases }, null, 2)}\n`);
  console.log('Generated eval_residual_v1.json:', JSON.stringify(counts, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
