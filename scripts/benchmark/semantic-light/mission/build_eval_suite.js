'use strict';

/**
 * Construit le jeu d'évaluation A.5 (dev + heldout strictement disjoints par
 * famille/spécialité, sans fuite ni dépendance aux RCP).
 *
 * Distingue explicitement :
 *   - provenance: 'curated' (requêtes réalistes ancrées dans BDPM/ANMV)
 *   - provenance: 'corpus_generated' (transformations déterministes issues du corpus)
 *
 * Sépare :
 *   - expectedVariantCis / expectedVariantNums : bonne identité + bonne variante (dosage/forme/voie/espèce)
 *   - expectedIdentityCis / expectedIdentityNums : bonne molécule/marque (même si autre dosage/forme)
 *   - trapIds : pièges à éviter (mauvaise dose/concentration/sel/espèce)
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { loadData, getBdpmCorpusStats } = require('../../../../src/services/dataLoader');
const { loadVetData, getVetCorpusStats } = require('../../../../src/services/vetDataLoader');
const { normalizeSearchText } = require('../../../../src/utils/searchRanking');

function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function stableBucket(key) {
  const digest = crypto.createHash('sha1').update(String(key)).digest();
  return digest[0] % 2; // 0 = dev, 1 = heldout
}

function makeSubLookup(bdpm) {
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
  const generByCis = new Map();
  const generByGroup = new Map();
  for (const g of bdpm.generiques) {
    if (!generByCis.has(g.cis)) generByCis.set(g.cis, []);
    generByCis.get(g.cis).push(g);
    if (!generByGroup.has(g.id_groupe)) generByGroup.set(g.id_groupe, []);
    generByGroup.get(g.id_groupe).push(g);
  }
  const mitmByCis = new Map();
  for (const m of bdpm.mitm) {
    if (!mitmByCis.has(m.cis)) mitmByCis.set(m.cis, []);
    mitmByCis.get(m.cis).push(m);
  }
  return { compByCis, presByCis, generByCis, generByGroup, mitmByCis };
}

function makeVetLookup(vet) {
  const compByNum = new Map();
  for (const c of vet.compositions) {
    if (!compByNum.has(c.num)) compByNum.set(c.num, []);
    compByNum.get(c.num).push(c);
  }
  const presByNum = new Map();
  for (const p of vet.presentations) {
    if (!presByNum.has(p.num)) presByNum.set(p.num, []);
    presByNum.get(p.num).push(p);
  }
  return { compByNum, presByNum };
}

function activeSubsNormalized(cis, compByCis) {
  const comps = compByCis.get(cis) || [];
  return new Set(comps.map((c) => normalizeSearchText(c.denomination_substance)).filter(Boolean));
}

function distinctActiveEntityCount(cis, compByCis) {
  const comps = compByCis.get(cis) || [];
  const sa = comps.filter((c) => c.nature_composant === 'SA');
  const src = sa.length ? sa : comps;
  return new Set(src.map((c) => normalizeSearchText(c.denomination_substance)).filter(Boolean)).size;
}

function findBdpmBy(bdpm, lookups, pred) {
  const ids = [];
  for (const s of bdpm.specialites) {
    const subs = [...activeSubsNormalized(s.cis, lookups.compByCis)];
    const comps = lookups.compByCis.get(s.cis) || [];
    const pres = lookups.presByCis.get(s.cis) || [];
    if (pred({ s, subs, comps, pres, normDenom: normalizeSearchText(s.denomination), normForme: normalizeSearchText(s.forme_pharma), normVoie: normalizeSearchText(s.voies_admin) })) {
      ids.push(s.cis);
    }
  }
  return ids;
}

function findVetBy(vet, vetLookups, pred) {
  const ids = [];
  for (const m of vet.medicaments) {
    const comps = vetLookups.compByNum.get(m.num) || [];
    const subs = comps.map((c) => normalizeSearchText(c.substance));
    const normNom = normalizeSearchText(m.nom);
    const normForme = normalizeSearchText(m.forme_pharmaceutique);
    const normEspeces = (m.especes || []).map((e) => normalizeSearchText(e));
    if (pred({ m, subs, comps, normNom, normForme, normEspeces })) {
      ids.push(m.num);
    }
  }
  return ids;
}

async function main() {
  await loadData();
  await loadVetData();
  const { corpus: bdpm } = getBdpmCorpusStats();
  const { corpus: vet } = getVetCorpusStats();
  const bdpmL = makeSubLookup(bdpm);
  const vetL = makeVetLookup(vet);

  const cases = [];
  function addCase(spec) {
    cases.push(spec);
  }

  // =========================================================================
  // PART 1: CURATED REALISTIC CASES (Disjoint drug clusters: DEV vs HELDOUT)
  // =========================================================================
  // DEV CLUSTERS: doliprane/paracetamol, esomeprazole, hexamidine, mag 2,
  //   cerulyse, levothyrox, amoxicilline, amoxicilline+clav, ibuprofene,
  //   salbutamol, atorvastatine, meloxicam (vet), sultrian (vet)
  //
  // HELDOUT CLUSTERS: spasfon/phloroglucinol, eliquis/apixaban, kardegic/aspirine,
  //   janumet/sitagliptine+metformine, tramadol+paracetamol/ixprim, lamaline,
  //   solupred/prednisolone, uvedose/cholecalciferol, oramorph/morphine,
  //   methotrexate, zovirax/aciclovir, bisoprolol, furosemide/lasilix,
  //   desloratadine/aerius, perindopril, bravecto/fluralaner (vet),
  //   milbemax/milbemycine (vet), apoquel/oclacitinib (vet), kesium (vet)

  // Helper to resolve curated cases concisely
  const curatedSpecs = [
    // ---------------- F1_exact_codes_prefix (DEV) ----------------
    {
      id: 'c_dev_f1_doliprane_exact_cis',
      split: 'dev',
      cluster: 'doliprane',
      family: 'F1_exact_codes_prefix',
      provenance: 'curated',
      q: '60234100',
      expectQualityAt1: 'exact',
      identity: () => ['60234100'],
      variant: () => ['60234100']
    },
    {
      id: 'c_dev_f1_doliprane_cip13',
      split: 'dev',
      cluster: 'doliprane',
      family: 'F1_exact_codes_prefix',
      provenance: 'curated',
      q: '3400935955838',
      expectQualityAt1: 'exact',
      identity: () => ['60234100'],
      variant: () => ['60234100']
    },
    {
      id: 'c_dev_f1_doli_prefix',
      split: 'dev',
      cluster: 'doliprane',
      family: 'F1_exact_codes_prefix',
      provenance: 'curated',
      q: 'doliprane',
      expectQualityAt1: 'prefix',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => /\bdoliprane/.test(normDenom)),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => /\bdoliprane/.test(normDenom))
    },

    // ---------------- F1_exact_codes_prefix (HELDOUT) ----------------
    {
      id: 'c_ho_f1_eliquis_exact_cis',
      split: 'heldout',
      cluster: 'eliquis',
      family: 'F1_exact_codes_prefix',
      provenance: 'curated',
      q: '69340279',
      expectQualityAt1: 'exact',
      identity: () => ['69340279'],
      variant: () => ['69340279']
    },
    {
      id: 'c_ho_f1_spasfon_name',
      split: 'heldout',
      cluster: 'spasfon',
      family: 'F1_exact_codes_prefix',
      provenance: 'curated',
      q: 'spasfon',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.startsWith('spasfon')),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.startsWith('spasfon'))
    },
    {
      id: 'c_ho_f1_bad_cis_no_fake_match',
      split: 'heldout',
      cluster: 'badcode',
      family: 'F1_exact_codes_prefix',
      provenance: 'curated',
      q: '99999998',
      impossible: true,
      identity: () => [],
      variant: () => []
    },
    {
      id: 'c_ho_f1_bad_cip13_no_fake_match',
      split: 'heldout',
      cluster: 'badcode',
      family: 'F1_exact_codes_prefix',
      provenance: 'curated',
      q: '3400999999999',
      impossible: true,
      identity: () => [],
      variant: () => []
    },

    // ---------------- F2_typos_glued_accents_abbrev (DEV) ----------------
    {
      id: 'c_dev_f2_esomeprazole_40mg_glued',
      split: 'dev',
      cluster: 'esomeprazole',
      family: 'F2_typos_glued_accents_abbrev',
      provenance: 'curated',
      q: 'esoméprazole 40mg',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, subs }) => normDenom.includes('esomeprazole') || subs.some(x => x.startsWith('esomeprazole'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, subs }) => (normDenom.includes('esomeprazole') || subs.some(x => x.startsWith('esomeprazole'))) && /\b40\s*mg\b/.test(normDenom)),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.includes('esomeprazole') && /\b20\s*mg\b/.test(normDenom))
    },
    {
      id: 'c_dev_f2_dolipranr_typo',
      split: 'dev',
      cluster: 'doliprane',
      family: 'F2_typos_glued_accents_abbrev',
      provenance: 'curated',
      q: 'dolipranr',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.includes('doliprane')),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.includes('doliprane'))
    },
    {
      id: 'c_dev_f2_ibuprofene_400_cp',
      split: 'dev',
      cluster: 'ibuprofene',
      family: 'F2_typos_glued_accents_abbrev',
      provenance: 'curated',
      q: 'ibuprofene 400mg cp',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, subs }) => subs.some(x => x === 'ibuprofene') || normDenom.includes('ibuprofene')),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, normForme, subs }) => (subs.some(x => x === 'ibuprofene') || normDenom.includes('ibuprofene')) && /\b400\s*mg\b/.test(normDenom) && normForme.includes('comprime'))
    },

    // ---------------- F2_typos_glued_accents_abbrev (HELDOUT) ----------------
    {
      id: 'c_ho_f2_apixaban_5mg_no_space',
      split: 'heldout',
      cluster: 'eliquis',
      family: 'F2_typos_glued_accents_abbrev',
      provenance: 'curated',
      q: 'apixaban 5mg',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, subs }) => subs.some(x => x.includes('apixaban')) || normDenom.includes('eliquis')),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, subs }) => (subs.some(x => x.includes('apixaban')) || normDenom.includes('eliquis')) && /\b5\s*mg\b/.test(normDenom)),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.includes('eliquis') && /\b2,5\s*mg\b/.test(normDenom))
    },
    {
      id: 'c_ho_f2_furosemide_typo_noaccent',
      split: 'heldout',
      cluster: 'furosemide',
      family: 'F2_typos_glued_accents_abbrev',
      provenance: 'curated',
      q: 'furosemide 40 mg cpr',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('furosemide'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, normForme, subs }) => subs.some(x => x.includes('furosemide')) && /\b40\s*mg\b/.test(normDenom) && normForme.includes('comprime'))
    },
    {
      id: 'c_ho_f2_solupred_oro_abbrev',
      split: 'heldout',
      cluster: 'solupred',
      family: 'F2_typos_glued_accents_abbrev',
      provenance: 'curated',
      q: 'solupred 20mg oro',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.includes('solupred')),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, normForme }) => normDenom.includes('solupred') && /\b20\s*mg\b/.test(normDenom) && normForme.includes('orodispersible')),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.includes('solupred') && /\b5\s*mg\b/.test(normDenom))
    },
    {
      id: 'c_ho_f2_azithromycine_typo',
      split: 'heldout',
      cluster: 'azithromycine',
      family: 'F2_typos_glued_accents_abbrev',
      provenance: 'curated',
      q: 'azitromycine 250 mg',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('azithromycine'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, subs }) => subs.some(x => x.includes('azithromycine')) && /\b250\s*mg\b/.test(normDenom))
    },
    {
      id: 'c_ho_f2_kardegic_sach_abbrev',
      split: 'heldout',
      cluster: 'kardegic',
      family: 'F2_typos_glued_accents_abbrev',
      provenance: 'curated',
      q: 'kardegic 75mg sach',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.includes('kardegic')),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.includes('kardegic') && /\b75\s*mg\b/.test(normDenom) && normDenom.includes('sachet')),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.includes('kardegic') && /\b(?:160|300)\s*mg\b/.test(normDenom))
    },

    // ---------------- F3_mixed_name_dosage_forme_voie (DEV) ----------------
    {
      id: 'c_dev_f3_doliprane_1g_comprime',
      split: 'dev',
      cluster: 'doliprane',
      family: 'F3_mixed_name_dosage_forme_voie',
      provenance: 'curated',
      q: 'Doliprane 1 g comprimé',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => /\bdoliprane\b/.test(normDenom)),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, normForme }) => /\bdoliprane\b/.test(normDenom) && /\b1000\s*mg\b/.test(normDenom) && normForme.includes('comprime')),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, normForme }) => /\bdoliprane\b/.test(normDenom) && (/\b500\s*mg\b/.test(normDenom) || normForme.includes('suppositoire') || normForme.includes('gelule')))
    },
    {
      id: 'c_dev_f3_hexamidine_collyre',
      split: 'dev',
      cluster: 'hexamidine',
      family: 'F3_mixed_name_dosage_forme_voie',
      provenance: 'curated',
      q: 'Hexamidine collyre',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('hexamidine'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ subs, normForme }) => subs.some(x => x.includes('hexamidine')) && normForme.includes('collyre')),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ subs, normForme }) => subs.some(x => x.includes('hexamidine')) && !normForme.includes('collyre'))
    },
    {
      id: 'c_dev_f3_levothyroxine_25ug',
      split: 'dev',
      cluster: 'levothyroxine',
      family: 'F3_mixed_name_dosage_forme_voie',
      provenance: 'curated',
      q: 'levothyroxine 25 µg',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('levothyroxine'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, subs }) => subs.some(x => x.includes('levothyroxine')) && /\b25\s*microgrammes\b/.test(normDenom)),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, subs }) => subs.some(x => x.includes('levothyroxine')) && /\b(?:50|75|100|125)\s*microgrammes\b/.test(normDenom))
    },
    {
      id: 'c_dev_f3_mag_2_100mg',
      split: 'dev',
      cluster: 'mag2',
      family: 'F3_mixed_name_dosage_forme_voie',
      provenance: 'curated',
      q: 'MAG 2 100 mg',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.startsWith('mag 2')),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.startsWith('mag 2') && /\b100\s*mg\b/.test(normDenom)),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => !normDenom.startsWith('mag 2') && /\b100\s*mg\b/.test(normDenom))
    },
    {
      id: 'c_dev_f3_cerulyse_auriculaire',
      split: 'dev',
      cluster: 'cerulyse',
      family: 'F3_mixed_name_dosage_forme_voie',
      provenance: 'curated',
      q: 'Cerulyse auriculaire',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.startsWith('cerulyse')),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, normVoie }) => normDenom.startsWith('cerulyse') && normVoie.includes('auriculaire'))
    },

    // ---------------- F3_mixed_name_dosage_forme_voie (HELDOUT) ----------------
    {
      id: 'c_ho_f3_methotrexate_per_os',
      split: 'heldout',
      cluster: 'methotrexate',
      family: 'F3_mixed_name_dosage_forme_voie',
      provenance: 'curated',
      q: 'méthotrexate per os',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('methotrexate'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ subs, normVoie }) => subs.some(x => x.includes('methotrexate')) && normVoie.includes('orale')),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ subs, normVoie }) => subs.some(x => x.includes('methotrexate')) && !normVoie.includes('orale'))
    },
    {
      id: 'c_ho_f3_spasfon_injectable_iv',
      split: 'heldout',
      cluster: 'spasfon',
      family: 'F3_mixed_name_dosage_forme_voie',
      provenance: 'curated',
      q: 'spasfon intraveineuse',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.startsWith('spasfon')),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, normVoie }) => normDenom.startsWith('spasfon') && normVoie.includes('intraveineuse')),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, normVoie }) => normDenom.startsWith('spasfon') && !normVoie.includes('intraveineuse'))
    },
    {
      id: 'c_ho_f3_spasfon_suppositoire_rectale',
      split: 'heldout',
      cluster: 'spasfon',
      family: 'F3_mixed_name_dosage_forme_voie',
      provenance: 'curated',
      q: 'phloroglucinol suppositoire',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('phloroglucinol'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ subs, normForme }) => subs.some(x => x.includes('phloroglucinol')) && normForme.includes('suppositoire')),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ subs, normForme }) => subs.some(x => x.includes('phloroglucinol')) && normForme.includes('injectable'))
    },
    {
      id: 'c_ho_f3_uvedose_100000ui_capsule_vs_ampoule',
      split: 'heldout',
      cluster: 'uvedose',
      family: 'F3_mixed_name_dosage_forme_voie',
      provenance: 'curated',
      q: 'uvedose 50 000 UI capsule molle',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.includes('uvedose')),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, normForme }) => normDenom.includes('uvedose') && normDenom.includes('50 000') && normForme.includes('capsule')),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, normForme }) => normDenom.includes('uvedose') && !normForme.includes('capsule'))
    },
    {
      id: 'c_ho_f3_cholecalciferol_100000ui',
      split: 'heldout',
      cluster: 'uvedose',
      family: 'F3_mixed_name_dosage_forme_voie',
      provenance: 'curated',
      q: 'cholecalciferol 100000 UI',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('cholecalciferol'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, subs }) => subs.some(x => x.includes('cholecalciferol')) && /100\s*000\s*u/.test(normDenom)),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, subs }) => subs.some(x => x.includes('cholecalciferol')) && /50\s*000\s*u/.test(normDenom))
    },
    {
      id: 'c_ho_f3_aciclovir_5pct_creme',
      split: 'heldout',
      cluster: 'aciclovir',
      family: 'F3_mixed_name_dosage_forme_voie',
      provenance: 'curated',
      q: 'aciclovir 5 pour cent creme',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('aciclovir'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, normForme, subs }) => subs.some(x => x.includes('aciclovir')) && normDenom.includes('5 %') && normForme.includes('creme')),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ normForme, subs }) => subs.some(x => x.includes('aciclovir')) && normForme.includes('comprime'))
    },
    {
      id: 'c_ho_f3_bisoprolol_10mg_cp',
      split: 'heldout',
      cluster: 'bisoprolol',
      family: 'F3_mixed_name_dosage_forme_voie',
      provenance: 'curated',
      q: 'bisoprolol 10 mg comprime',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('bisoprolol'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ s, normDenom, normForme, subs }) => subs.some(x => x.includes('bisoprolol')) && distinctActiveEntityCount(s.cis, bdpmL.compByCis) === 1 && /\b10\s*mg\b/.test(normDenom) && normForme.includes('comprime')),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ s, normDenom, subs }) => subs.some(x => x.includes('bisoprolol')) && (distinctActiveEntityCount(s.cis, bdpmL.compByCis) > 1 || /\b5\s*mg\b/.test(normDenom)))
    },

    // ---------------- F4_associations_concentrations_units (DEV) ----------------
    {
      id: 'c_dev_f4_amox_clav_1g',
      split: 'dev',
      cluster: 'amox_clav',
      family: 'F4_associations_concentrations_units',
      provenance: 'curated',
      q: 'amoxicilline acide clavulanique 1 g',
      multiSubstanceExpected: 2,
      identity: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('amoxicilline')) && subs.some(x => x.includes('clavulanique'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, subs }) => subs.some(x => x.includes('amoxicilline')) && subs.some(x => x.includes('clavulanique')) && /\b1\s*g\b/.test(normDenom)),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('amoxicilline')) && !subs.some(x => x.includes('clavulanique')))
    },
    {
      id: 'c_dev_f4_amox_mono_500mg',
      split: 'dev',
      cluster: 'amox_mono',
      family: 'F4_associations_concentrations_units',
      provenance: 'curated',
      q: 'amoxicilline 500 mg',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ s, subs }) => distinctActiveEntityCount(s.cis, bdpmL.compByCis) === 1 && subs.some(x => x.includes('amoxicilline'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ s, normDenom, subs }) => distinctActiveEntityCount(s.cis, bdpmL.compByCis) === 1 && subs.some(x => x.includes('amoxicilline')) && /\b500\s*mg\b/.test(normDenom)),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ s, subs }) => distinctActiveEntityCount(s.cis, bdpmL.compByCis) > 1 && subs.some(x => x.includes('amoxicilline')))
    },
    {
      id: 'c_dev_f4_codoliprane_combo',
      split: 'dev',
      cluster: 'paracetamol_codeine',
      family: 'F4_associations_concentrations_units',
      provenance: 'curated',
      q: 'paracetamol codeine 500 mg',
      multiSubstanceExpected: 2,
      identity: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('paracetamol')) && subs.some(x => x.includes('codeine'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, subs }) => subs.some(x => x.includes('paracetamol')) && subs.some(x => x.includes('codeine')) && /\b500\s*mg\b/.test(normDenom)),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ s, subs }) => distinctActiveEntityCount(s.cis, bdpmL.compByCis) === 1 && subs.includes('paracetamol'))
    },

    // ---------------- F4_associations_concentrations_units (HELDOUT) ----------------
    {
      id: 'c_ho_f4_sitagliptine_metformine',
      split: 'heldout',
      cluster: 'janumet',
      family: 'F4_associations_concentrations_units',
      provenance: 'curated',
      q: 'sitagliptine metformine 50 mg/1000 mg',
      multiSubstanceExpected: 2,
      identity: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('sitagliptine')) && subs.some(x => x.includes('metformine'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, subs }) => subs.some(x => x.includes('sitagliptine')) && subs.some(x => x.includes('metformine')) && normDenom.includes('50 mg/1000 mg')),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ s, subs }) => distinctActiveEntityCount(s.cis, bdpmL.compByCis) === 1 && subs.some(x => x.includes('sitagliptine') || x.includes('metformine')))
    },
    {
      id: 'c_ho_f4_tramadol_paracetamol',
      split: 'heldout',
      cluster: 'ixprim',
      family: 'F4_associations_concentrations_units',
      provenance: 'curated',
      q: 'paracetamol tramadol effervescent',
      multiSubstanceExpected: 2,
      identity: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('paracetamol')) && subs.some(x => x.includes('tramadol'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normForme, subs }) => subs.some(x => x.includes('paracetamol')) && subs.some(x => x.includes('tramadol')) && normForme.includes('effervescent')),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ s, subs }) => distinctActiveEntityCount(s.cis, bdpmL.compByCis) === 1 && subs.some(x => x === 'paracetamol' || x.includes('tramadol')))
    },
    {
      id: 'c_ho_f4_methotrexate_conc_25mg_ml',
      split: 'heldout',
      cluster: 'methotrexate',
      family: 'F4_associations_concentrations_units',
      provenance: 'curated',
      q: 'methotrexate 25 mg/ml',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('methotrexate'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, subs }) => subs.some(x => x.includes('methotrexate')) && /\b25\s*mg\/ml\b/.test(normDenom)),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, subs }) => subs.some(x => x.includes('methotrexate')) && /\b2,5\s*mg\b|\b10\s*mg\b/.test(normDenom) && !normDenom.includes('25 mg/ml'))
    },
    {
      id: 'c_ho_f4_oramorph_20mg_ml',
      split: 'heldout',
      cluster: 'oramorph',
      family: 'F4_associations_concentrations_units',
      provenance: 'curated',
      q: 'oramorph 20 mg/1 ml',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.startsWith('oramorph')),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.startsWith('oramorph') && normDenom.includes('20 mg/1 ml')),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.startsWith('oramorph') && !normDenom.includes('20 mg/1 ml'))
    },

    // ---------------- F5_ambiguous_impossible_oos (DEV & HELDOUT) ----------------
    {
      id: 'c_dev_f5_impossible_dose_route_doliprane',
      split: 'dev',
      cluster: 'doliprane',
      family: 'F5_ambiguous_impossible_oos',
      provenance: 'curated',
      q: 'doliprane 500 g intraveineux',
      impossible: true,
      forbidCriteriaSatisfied: ['dosage', 'voie'],
      identity: () => [],
      variant: () => []
    },
    {
      id: 'c_dev_f5_oos_symptom_headache',
      split: 'dev',
      cluster: 'oos',
      family: 'F5_ambiguous_impossible_oos',
      provenance: 'curated',
      q: 'que prendre contre mal de tete',
      oos: true,
      identity: () => [],
      variant: () => []
    },
    {
      id: 'c_ho_f5_impossible_amox_collyre_750',
      split: 'heldout',
      cluster: 'amox_impossible',
      family: 'F5_ambiguous_impossible_oos',
      provenance: 'curated',
      q: 'amoxicilline 750 mg collyre',
      impossible: true,
      forbidCriteriaSatisfied: ['dosage', 'forme'],
      identity: () => [],
      variant: () => []
    },
    {
      id: 'c_ho_f5_nonexistent_combo_paracetamol_amox',
      split: 'heldout',
      cluster: 'combo_impossible',
      family: 'F5_ambiguous_impossible_oos',
      provenance: 'curated',
      q: 'paracetamol amoxicilline',
      impossible: true,
      multiSubstanceExpected: 2,
      identity: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('paracetamol')) && subs.some(x => x.includes('amoxicilline'))),
      variant: () => []
    },
    {
      id: 'c_ho_f5_oos_croquettes_chat',
      split: 'heldout',
      cluster: 'oos',
      family: 'F5_ambiguous_impossible_oos',
      provenance: 'curated',
      q: 'croquettes hypoallergeniques chat sterilise',
      oos: true,
      identity: () => [],
      variant: () => []
    },
    {
      id: 'c_ho_f5_oos_mutuelle_optique',
      split: 'heldout',
      cluster: 'oos',
      family: 'F5_ambiguous_impossible_oos',
      provenance: 'curated',
      q: 'remboursement mutuelle optique lunettes',
      oos: true,
      identity: () => [],
      variant: () => []
    },
    {
      id: 'c_ho_f5_oos_brosse_dents',
      split: 'heldout',
      cluster: 'oos',
      family: 'F5_ambiguous_impossible_oos',
      provenance: 'curated',
      q: 'brosse a dents electrique sonique',
      oos: true,
      identity: () => [],
      variant: () => []
    },

    // ---------------- F6_source_vet_dedup_pagination (DEV & HELDOUT) ----------------
    {
      id: 'c_dev_f6_vet_meloxicam_chien_auto',
      split: 'dev',
      cluster: 'vet_meloxicam',
      family: 'F6_source_vet_dedup_pagination',
      provenance: 'curated',
      q: 'meloxicam chien',
      source: 'auto',
      expectSourceWithResults: ['anmv'],
      isVet: true,
      identity: () => findVetBy(vet, vetL, ({ subs }) => subs.some(x => x.includes('meloxicam'))),
      variant: () => findVetBy(vet, vetL, ({ subs, normEspeces }) => subs.some(x => x.includes('meloxicam')) && normEspeces.some(e => e.includes('chien'))),
      traps: () => findVetBy(vet, vetL, ({ subs, normEspeces }) => subs.some(x => x.includes('meloxicam')) && !normEspeces.some(e => e.includes('chien')))
    },
    {
      id: 'c_dev_f6_vet_sultrian_auto',
      split: 'dev',
      cluster: 'vet_sultrian',
      family: 'F6_source_vet_dedup_pagination',
      provenance: 'curated',
      q: 'SULTRIAN 100',
      source: 'auto',
      expectSourceWithResults: ['anmv'],
      isVet: true,
      identity: () => findVetBy(vet, vetL, ({ normNom }) => normNom.includes('sultrian')),
      variant: () => findVetBy(vet, vetL, ({ normNom }) => normNom.includes('sultrian 100'))
    },
    {
      id: 'c_ho_f6_vet_fluralaner_chien_auto',
      split: 'heldout',
      cluster: 'vet_bravecto',
      family: 'F6_source_vet_dedup_pagination',
      provenance: 'curated',
      q: 'fluralaner chien comprime',
      source: 'auto',
      expectSourceWithResults: ['anmv'],
      isVet: true,
      identity: () => findVetBy(vet, vetL, ({ subs }) => subs.some(x => x.includes('fluralaner'))),
      variant: () => findVetBy(vet, vetL, ({ subs, normForme, normEspeces }) => subs.some(x => x.includes('fluralaner')) && normEspeces.some(e => e.includes('chien')) && normForme.includes('comprime')),
      traps: () => findVetBy(vet, vetL, ({ subs, normForme, normEspeces }) => subs.some(x => x.includes('fluralaner')) && (!normEspeces.some(e => e.includes('chien')) || !normForme.includes('comprime')))
    },
    {
      id: 'c_ho_f6_vet_apoquel_5_4_pellicule',
      split: 'heldout',
      cluster: 'vet_apoquel',
      family: 'F6_source_vet_dedup_pagination',
      provenance: 'curated',
      q: 'apoquel 5,4 mg pellicule chien',
      source: 'auto',
      expectSourceWithResults: ['anmv'],
      isVet: true,
      identity: () => findVetBy(vet, vetL, ({ normNom }) => normNom.includes('apoquel')),
      variant: () => findVetBy(vet, vetL, ({ normNom, normForme, normEspeces }) => normNom.includes('apoquel') && /5,4\s*mg/.test(normNom) && normForme.includes('pellicule') && normEspeces.some(e => e.includes('chien'))),
      traps: () => findVetBy(vet, vetL, ({ normNom, normForme }) => normNom.includes('apoquel') && normForme.includes('croquer'))
    },
    {
      id: 'c_ho_f6_vet_milbemax_chat',
      split: 'heldout',
      cluster: 'vet_milbemax',
      family: 'F6_source_vet_dedup_pagination',
      provenance: 'curated',
      q: 'milbemax chat',
      source: 'auto',
      expectSourceWithResults: ['anmv'],
      isVet: true,
      identity: () => findVetBy(vet, vetL, ({ normNom }) => normNom.includes('milbemax')),
      variant: () => findVetBy(vet, vetL, ({ normNom, normEspeces }) => normNom.includes('milbemax') && normEspeces.some(e => e.includes('chat'))),
      traps: () => findVetBy(vet, vetL, ({ normNom, normEspeces }) => normNom.includes('milbemax') && !normEspeces.some(e => e.includes('chat')))
    },
    {
      id: 'c_ho_f6_vet_kesium_50_chien',
      split: 'heldout',
      cluster: 'vet_kesium',
      family: 'F6_source_vet_dedup_pagination',
      provenance: 'curated',
      q: 'kesium 50 mg chat',
      source: 'auto',
      expectSourceWithResults: ['anmv'],
      isVet: true,
      identity: () => findVetBy(vet, vetL, ({ normNom }) => normNom.includes('kesium')),
      variant: () => findVetBy(vet, vetL, ({ normNom, normEspeces }) => normNom.includes('kesium') && /\b50\s*mg\b/.test(normNom) && normEspeces.some(e => e.includes('chat')))
    },
    {
      id: 'c_ho_f6_human_auto_blocks_vet',
      split: 'heldout',
      cluster: 'kardegic',
      family: 'F6_source_vet_dedup_pagination',
      provenance: 'curated',
      q: 'kardegic',
      source: 'auto',
      expectSourceNotQueried: ['anmv'],
      identity: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.startsWith('kardegic')),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.startsWith('kardegic'))
    },

    // ---------------- F7_residual_semantic_probes (A.4 probes: DEV vs HELDOUT) ----------------
    // Strict non-clinical paraphrase probes where surface form/paraphrase differs from BDPM nomenclature
    {
      id: 'c_dev_f7_cerulyse_spray_flacon',
      split: 'dev',
      cluster: 'cerulyse',
      family: 'F7_residual_semantic_probes',
      provenance: 'curated',
      q: 'Cerulyse spray',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.startsWith('cerulyse')),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.startsWith('cerulyse'))
    },
    {
      id: 'c_dev_f7_piqure_salbutamol_ou_inj',
      split: 'dev',
      cluster: 'doliprane',
      family: 'F7_residual_semantic_probes',
      provenance: 'curated',
      q: 'cachet doliprane 1000',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.startsWith('doliprane')),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, normForme }) => normDenom.startsWith('doliprane') && /\b1000\s*mg\b/.test(normDenom) && normForme.includes('comprime'))
    },
    {
      id: 'c_dev_f7_gouttes_yeux_hexamidine',
      split: 'dev',
      cluster: 'hexamidine',
      family: 'F7_residual_semantic_probes',
      provenance: 'curated',
      q: 'gouttes yeux hexamidine',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('hexamidine'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ subs, normForme }) => subs.some(x => x.includes('hexamidine')) && normForme.includes('collyre'))
    },
    {
      id: 'c_ho_f7_piqure_methotrexate',
      split: 'heldout',
      cluster: 'methotrexate',
      family: 'F7_residual_semantic_probes',
      provenance: 'curated',
      q: 'piqure methotrexate',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('methotrexate'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ subs, normForme }) => subs.some(x => x.includes('methotrexate')) && (normForme.includes('injectable') || normForme.includes('seringue') || normForme.includes('stylo'))),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ subs, normVoie }) => subs.some(x => x.includes('methotrexate')) && normVoie === 'orale')
    },
    {
      id: 'c_ho_f7_fond_sous_langue_spasfon',
      split: 'heldout',
      cluster: 'spasfon',
      family: 'F7_residual_semantic_probes',
      provenance: 'curated',
      q: 'spasfon fond sous la langue',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ normDenom }) => normDenom.startsWith('spasfon')),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, normVoie }) => normDenom.startsWith('spasfon') && normVoie.includes('sublinguale')),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, normForme }) => normDenom.startsWith('spasfon') && (normForme.includes('injectable') || normForme.includes('suppositoire')))
    },
    {
      id: 'c_ho_f7_patch_fentanyl',
      split: 'heldout',
      cluster: 'fentanyl',
      family: 'F7_residual_semantic_probes',
      provenance: 'curated',
      q: 'patch fentanyl 25',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('fentanyl'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, normVoie, subs }) => subs.some(x => x.includes('fentanyl')) && normVoie.includes('transdermique') && /\b25\b/.test(normDenom)),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ normVoie, subs }) => subs.some(x => x.includes('fentanyl')) && normVoie.includes('intraveineuse'))
    },
    {
      id: 'c_ho_f7_generique_eliquis',
      split: 'heldout',
      cluster: 'eliquis',
      family: 'F7_residual_semantic_probes',
      provenance: 'curated',
      q: 'generique apixaban 5 mg',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('apixaban'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, subs }) => subs.some(x => x.includes('apixaban')) && /\b5\s*mg\b/.test(normDenom))
    },
    {
      id: 'c_ho_f7_sirop_desloratadine',
      split: 'heldout',
      cluster: 'desloratadine',
      family: 'F7_residual_semantic_probes',
      provenance: 'curated',
      q: 'sirop desloratadine',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('desloratadine'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normForme, subs }) => subs.some(x => x.includes('desloratadine')) && (normForme.includes('sirop') || normForme.includes('solution buvable'))),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ normForme, subs }) => subs.some(x => x.includes('desloratadine')) && normForme.includes('comprime'))
    },
    {
      id: 'c_ho_f7_cachet_sertraline_50',
      split: 'heldout',
      cluster: 'sertraline',
      family: 'F7_residual_semantic_probes',
      provenance: 'curated',
      q: 'cachet sertraline 50 mg',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('sertraline'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, normForme, subs }) => subs.some(x => x.includes('sertraline')) && /\b50\s*mg\b/.test(normDenom) && (normForme.includes('gelule') || normForme.includes('comprime'))),
      traps: () => findBdpmBy(bdpm, bdpmL, ({ normDenom, subs }) => subs.some(x => x.includes('sertraline')) && !/\b50\s*mg\b/.test(normDenom))
    },
    {
      id: 'c_ho_f7_perindopril_sel_vs_ft',
      split: 'heldout',
      cluster: 'perindopril',
      family: 'F7_residual_semantic_probes',
      provenance: 'curated',
      q: 'perindopril 5 mg comprime',
      identity: () => findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some(x => x.includes('perindopril'))),
      variant: () => findBdpmBy(bdpm, bdpmL, ({ s, normDenom, normForme, subs }) => subs.some(x => x.includes('perindopril')) && distinctActiveEntityCount(s.cis, bdpmL.compByCis) === 1 && /\b5\s*mg\b/.test(normDenom) && normForme.includes('comprime'))
    }
  ];

  // Exclude curated clusters from corpus_generated pool so there is zero drug overlap
  const curatedClusterRoots = [
    'doliprane', 'paracetamol', 'esomeprazole', 'hexamidine', 'desomedine',
    'mag 2', 'cerulyse', 'levothyroxine', 'levothyrox', 'amoxicilline',
    'ibuprofene', 'salbutamol', 'atorvastatine', 'spasfon', 'phloroglucinol',
    'eliquis', 'apixaban', 'kardegic', 'janumet', 'sitagliptine', 'metformine',
    'ixprim', 'tramadol', 'lamaline', 'solupred', 'prednisolone', 'uvedose',
    'cholecalciferol', 'oramorph', 'morphine', 'methotrexate', 'aciclovir',
    'bisoprolol', 'furosemide', 'azithromycine', 'fentanyl', 'desloratadine',
    'sertraline', 'perindopril', 'meloxicam', 'sultrian', 'fluralaner', 'bravecto',
    'milbemax', 'apoquel', 'kesium'
  ];

  for (const spec of curatedSpecs) {
    const idHits = spec.identity();
    const varHits = spec.variant();
    const trapHits = spec.traps ? spec.traps() : [];
    if (!spec.impossible && !spec.oos && (idHits.length === 0 || varHits.length === 0)) {
      throw new Error(`Curated case ${spec.id} resolved empty targets: id=${idHits.length}, var=${varHits.length}`);
    }
    addCase({
      id: spec.id,
      split: spec.split,
      cluster: spec.cluster,
      family: spec.family,
      provenance: spec.provenance,
      q: spec.q,
      source: spec.source || 'auto',
      isVet: Boolean(spec.isVet),
      impossible: Boolean(spec.impossible),
      oos: Boolean(spec.oos),
      forbidCriteriaSatisfied: spec.forbidCriteriaSatisfied || null,
      multiSubstanceExpected: spec.multiSubstanceExpected || null,
      expectQualityAt1: spec.expectQualityAt1 || null,
      expectSourceWithResults: spec.expectSourceWithResults || null,
      expectSourceNotQueried: spec.expectSourceNotQueried || null,
      expectedIdentityIds: idHits,
      expectedVariantIds: varHits,
      trapIds: trapHits.filter((x) => !varHits.includes(x))
    });
  }

  // =========================================================================
  // PART 2: CORPUS-GENERATED STRATIFIED CASES (Disjoint brand roots / buckets)
  // =========================================================================
  const rng = seededRng(20261113);
  const pool = [];
  for (const s of bdpm.specialites) {
    if (s.commercialisation !== 'Commercialisée') continue;
    const nd = normalizeSearchText(s.denomination);
    if (nd.includes(' ch') || nd.includes(' dh')) continue; // skip homeopathy dilutions for unit/dosage generation
    if (curatedClusterRoots.some((r) => nd.includes(r))) continue;
    const comps = bdpmL.compByCis.get(s.cis) || [];
    const subs = [...activeSubsNormalized(s.cis, bdpmL.compByCis)];
    if (subs.length === 0) continue;
    if (subs.some((x) => curatedClusterRoots.some((r) => x.includes(r)))) continue;
    const firstPart = s.denomination.split(',')[0].trim();
    const mDose = firstPart.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)\s*(mg|g|microgrammes)\b/i);
    if (!mDose) continue;
    const brandRaw = mDose[1].trim();
    if (brandRaw.length < 4 || /\d/.test(brandRaw)) continue;
    const rootToken = normalizeSearchText(brandRaw.split(/\s+/)[0]);
    if (!rootToken || rootToken.length < 4) continue;
    const pres = bdpmL.presByCis.get(s.cis) || [];
    const doseVal = mDose[2];
    const doseUnit = mDose[3].toLowerCase();
    const formeTok = normalizeSearchText((s.forme_pharma || '').split(/\s+/)[0]);
    if (!formeTok || !['comprime', 'gelule', 'collyre', 'suppositoire', 'sirop', 'creme', 'pommade'].includes(formeTok)) continue;
    pool.push({
      s,
      nd,
      rootToken,
      subs,
      doseStr: `${doseVal} ${doseUnit}`,
      doseVal,
      doseUnit,
      formeTok,
      pres,
      bucket: stableBucket(rootToken) === 0 ? 'dev' : 'heldout'
    });
  }

  // Group by rootToken so no rootToken appears in multiple generated cases across dev/heldout
  const byRoot = new Map();
  for (const row of pool) {
    if (!byRoot.has(row.rootToken)) byRoot.set(row.rootToken, []);
    byRoot.get(row.rootToken).push(row);
  }
  const distinctRoots = [...byRoot.entries()]
    .filter(([, rows]) => rows.length >= 2)
    .sort((a, b) => a[0].localeCompare(b[0]));

  // Shuffle deterministically
  for (let i = distinctRoots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [distinctRoots[i], distinctRoots[j]] = [distinctRoots[j], distinctRoots[i]];
  }

function extractMainMoleculeToken(comps) {
  const ft = comps.find((c) => c.nature_composant === 'FT' && c.denomination_substance);
  const picked = ft || comps[0];
  if (!picked || !picked.denomination_substance) return '';
  const saltWords = new Set([
    'de', 'du', 'd', 'l', 'la', 'le', 'en', 'et', 'pour', 'anhydre',
    'chlorhydrate', 'maleate', 'bitartrate', 'besilate', 'tartrate', 'sulfate',
    'fumarate', 'hemifumarate', 'succinate', 'oxalate', 'mesilate', 'citrate',
    'benzoate', 'bromhydrate', 'dihydrate', 'monohydrate', 'trihydrate',
    'sodique', 'potassique', 'calcique', 'magnesien', 'sodium', 'potassium',
    'calcium', 'hemisuccinate', 'tosylate', 'valerate', 'propionate', 'acetate'
  ]);
  const tokens = normalizeSearchText(picked.denomination_substance)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !saltWords.has(t));
  return tokens[0] || '';
}

  let genDevCount = 0;
  let genHeldoutCount = 0;
  const maxPerSplit = 25;
  const genSubSplit = new Map();

  for (const [rootToken, rows] of distinctRoots) {
    const split = stableBucket(rootToken) === 0 ? 'dev' : 'heldout';
    if (split === 'dev' && genDevCount >= maxPerSplit) continue;
    if (split === 'heldout' && genHeldoutCount >= maxPerSplit) continue;

    const pick = rows[Math.floor(rng() * rows.length)];
    const otherDosages = rows.filter((r) => r.doseStr !== pick.doseStr || r.formeTok !== pick.formeTok);
    const idAll = rows.map((r) => r.s.cis);
    const varAll = rows
      .filter((r) => normalizeSearchText(r.doseStr) === normalizeSearchText(pick.doseStr) && r.formeTok === pick.formeTok)
      .map((r) => r.s.cis);
    const trapAll = otherDosages.map((r) => r.s.cis);

    const mod = (genDevCount + genHeldoutCount) % 5;
    if (mod === 0 && pick.pres[0]?.cip13) {
      addCase({
        id: `g_${split}_f1_cip13_${pick.s.cis}`,
        split,
        cluster: `gen_${rootToken}`,
        family: 'F1_exact_codes_prefix',
        provenance: 'corpus_generated',
        q: pick.pres[0].cip13,
        source: 'auto',
        expectQualityAt1: 'exact',
        expectedIdentityIds: [pick.s.cis],
        expectedVariantIds: [pick.s.cis],
        trapIds: []
      });
    } else if (mod === 1) {
      // glued dosage + no accent form
      const q = `${pick.rootToken} ${pick.doseVal.replace(/\s+/g, '')}${pick.doseUnit === 'microgrammes' ? 'µg' : pick.doseUnit} ${pick.formeTok}`;
      addCase({
        id: `g_${split}_f2_glued_${pick.s.cis}`,
        split,
        cluster: `gen_${rootToken}`,
        family: 'F2_typos_glued_accents_abbrev',
        provenance: 'corpus_generated',
        q,
        source: 'auto',
        expectedIdentityIds: idAll,
        expectedVariantIds: varAll,
        trapIds: trapAll
      });
    } else if (mod === 2) {
      // mixed substance + dosage + forme (unit conversion + salt-free INN)
      const pickComps = bdpmL.compByCis.get(pick.s.cis) || [];
      if (distinctActiveEntityCount(pick.s.cis, bdpmL.compByCis) !== 1) continue;
      const molTok = extractMainMoleculeToken(pickComps);
      if (!molTok) continue;
      const prevSplit = genSubSplit.get(molTok);
      if (prevSplit && prevSplit !== split) continue;
      genSubSplit.set(molTok, split);
      let doseText = pick.doseStr;
      if (pick.doseUnit === 'mg' && pick.doseVal === '1000') doseText = '1 g';
      else if (pick.doseUnit === 'microgrammes') doseText = `${pick.doseVal} µg`;
      const q = `${molTok} ${doseText} ${pick.formeTok}`;
      const doseRegex = new RegExp(`(?:^|[^0-9])${pick.doseVal.replace('.', '[.,]')}\\s*${pick.doseUnit}\\b`, 'i');
      const subMatches = findBdpmBy(bdpm, bdpmL, ({ subs }) => subs.some((x) => x.includes(molTok)));
      const subVarMatches = findBdpmBy(bdpm, bdpmL, ({ normDenom, normForme, subs }) =>
        subs.some((x) => x.includes(molTok)) &&
        doseRegex.test(normDenom) &&
        normForme.includes(pick.formeTok)
      );
      if (subVarMatches.length === 0) continue;
      addCase({
        id: `g_${split}_f3_sub_dose_form_${pick.s.cis}`,
        split,
        cluster: `gen_sub_${molTok}`,
        family: 'F3_mixed_name_dosage_forme_voie',
        provenance: 'corpus_generated',
        q,
        source: 'auto',
        expectedIdentityIds: subMatches,
        expectedVariantIds: subVarMatches,
        trapIds: []
      });
    } else if (mod === 3) {
      // 1-char transposition/deletion typo on brand + dosage
      const tok = pick.rootToken;
      if (tok.length < 6) continue;
      const typo = tok.slice(0, -1);
      addCase({
        id: `g_${split}_f2_typo_${pick.s.cis}`,
        split,
        cluster: `gen_${rootToken}`,
        family: 'F2_typos_glued_accents_abbrev',
        provenance: 'corpus_generated',
        q: `${typo} ${pick.doseStr}`,
        source: 'auto',
        expectedIdentityIds: idAll,
        expectedVariantIds: varAll,
        trapIds: trapAll
      });
    } else {
      // exact denomination + forme mixed
      const q = `${pick.rootToken} ${pick.doseStr} ${pick.formeTok}`;
      addCase({
        id: `g_${split}_f3_brand_dose_form_${pick.s.cis}`,
        split,
        cluster: `gen_${rootToken}`,
        family: 'F3_mixed_name_dosage_forme_voie',
        provenance: 'corpus_generated',
        q,
        source: 'auto',
        expectedIdentityIds: idAll,
        expectedVariantIds: varAll,
        trapIds: trapAll
      });
    }

    if (split === 'dev') genDevCount++;
    else genHeldoutCount++;
  }

  // Assert zero cluster overlap between dev and heldout
  const devClusters = new Set(cases.filter((c) => c.split === 'dev').map((c) => c.cluster));
  const hoClusters = new Set(cases.filter((c) => c.split === 'heldout').map((c) => c.cluster));
  const overlap = [...devClusters].filter((x) => hoClusters.has(x) && x !== 'oos');
  if (overlap.length > 0) {
    throw new Error(`Cluster leak between dev and heldout: ${overlap.join(', ')}`);
  }

  const summary = {
    total: cases.length,
    dev: cases.filter((c) => c.split === 'dev').length,
    heldout: cases.filter((c) => c.split === 'heldout').length,
    byProvenance: {
      curated: cases.filter((c) => c.provenance === 'curated').length,
      corpus_generated: cases.filter((c) => c.provenance === 'corpus_generated').length
    },
    byFamily: {}
  };
  for (const c of cases) {
    summary.byFamily[c.family] ??= { dev: 0, heldout: 0 };
    summary.byFamily[c.family][c.split]++;
  }

  const outFile = path.join(__dirname, 'eval_suite_v3.json');
  fs.writeFileSync(outFile, `${JSON.stringify({ summary, cases }, null, 2)}\n`);
  console.log('Generated eval_suite_v3.json:', JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
