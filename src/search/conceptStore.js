'use strict';

/**
 * Représentation conceptuelle par entité (CIS côté BDPM, num côté ANMV).
 *
 * Construit à la demande à partir des corpus déjà chargés en mémoire (0 octet
 * tant que la recherche expérimentale n'est pas activée), avec invalidation
 * automatique lors d'un rechargement BDPM ou vétérinaire.
 *
 * Source des concepts et relations : exclusivement BDPM et ANMV (aucun RCP ni
 * dictionnaire thérapeutique externe).
 */

const bdpmState = require('../services/bdpm/state');
const vetState = require('../services/vet/state');
const { normalizeSearchText } = require('../utils/searchRanking');
const { parseDosageTokens } = require('../utils/structuredSearchCriteria');
const { buildTaxonomyVocab } = require('./structuredQueryParser');

const TOKEN_SPLIT_RE = /[\s/;,+()'"’\-:.]+/u;
const SALT_WORDS = new Set([
  'de', 'du', 'des', 'd', 'l', 'sodium', 'sodique', 'potassium', 'potassique',
  'calcium', 'calcique', 'magnesium', 'magnesique', 'chlorhydrate', 'bromhydrate',
  'sulfate', 'phosphate', 'citrate', 'maleate', 'tartrate', 'fumarate', 'succinate',
  'mesilate', 'besilate', 'tosylate', 'valerate', 'propionate', 'acetate', 'benzoate',
  'gluconate', 'lactate', 'hydrate', 'monohydrate', 'dihydrate', 'trihydrate',
  'hemihydrate', 'sesquihydrate', 'anhydre', 'lysine', 'arginine', 'trometamol',
  'ester', 'sels', 'base'
]);

let cachedEntry = null;

function extractTokens(text, minLen = 2) {
  const norm = normalizeSearchText(text);
  if (!norm) return [];
  const raw = norm.split(TOKEN_SPLIT_RE);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (t.length >= minLen) out.push(t);
  }
  return out;
}

function canonicalizeSpeciesWord(raw) {
  const w = normalizeSearchText(raw).trim();
  if (!w) return '';
  if (w.endsWith('aux') && w.length > 4) return `${w.slice(0, -3)}al`;
  if (w.endsWith('s') && w.length > 3) return w.slice(0, -1);
  return w;
}

function pushUniqueCisList(map, key, id) {
  let arr = map.get(key);
  if (!arr) {
    arr = [id];
    map.set(key, arr);
    return;
  }
  if (arr[arr.length - 1] !== id) {
    arr.push(id);
  }
}

function addPhraseAlias(aliasMap, phraseA, phraseB) {
  if (!phraseA || !phraseB || phraseA === phraseB) return;
  let setA = aliasMap.get(phraseA);
  if (!setA) {
    setA = new Set();
    aliasMap.set(phraseA, setA);
  }
  setA.add(phraseB);
}

function indexSaFtPairsForRows(compRows, saFtAliases) {
  const byOrder = new Map();
  let allHaveOrder = true;
  for (let i = 0; i < compRows.length; i++) {
    const row = compRows[i];
    if (row.numero_ordre == null || row.numero_ordre === '') {
      allHaveOrder = false;
      break;
    }
    const k = String(row.numero_ordre);
    if (!byOrder.has(k)) byOrder.set(k, { sa: [], ft: [] });
    if (row.nature_composant === 'SA') byOrder.get(k).sa.push(row);
    else if (row.nature_composant === 'FT') byOrder.get(k).ft.push(row);
  }

  const groups = allHaveOrder
    ? [...byOrder.values()]
    : [{
      sa: compRows.filter((r) => r.nature_composant === 'SA'),
      ft: compRows.filter((r) => r.nature_composant === 'FT')
    }];

  for (const grp of groups) {
    if (grp.sa.length !== 1 || grp.ft.length !== 1) continue;
    const normSa = normalizeSearchText(grp.sa[0].denomination_substance).replace(/\s+/g, ' ').trim();
    const normFt = normalizeSearchText(grp.ft[0].denomination_substance).replace(/\s+/g, ' ').trim();
    if (!normSa || !normFt || normSa === normFt) continue;
    addPhraseAlias(saFtAliases, normSa, normFt);
    addPhraseAlias(saFtAliases, normFt, normSa);
  }
}

function buildIngredientGroups(compRows) {
  const byKey = new Map();
  const distinctSaCodes = new Set();
  const distinctFtCodes = new Set();
  const allTokens = new Set();
  const compoDosages = [];

  for (let i = 0; i < compRows.length; i++) {
    const row = compRows[i];
    const normSub = normalizeSearchText(row.denomination_substance);
    const subTokens = extractTokens(normSub, 2);
    for (const t of subTokens) allTokens.add(t);

    if (row.dosage) {
      const parsed = parseDosageTokens(row.dosage);
      for (const p of parsed) compoDosages.push(p);
    }

    if (row.nature_composant === 'SA' && row.code_substance) {
      distinctSaCodes.add(row.code_substance);
    } else if (row.nature_composant === 'FT' && row.code_substance) {
      distinctFtCodes.add(row.code_substance);
    }

    const hasOrder = row.numero_ordre != null && row.numero_ordre !== '';
    const groupKey = hasOrder
      ? `ord:${row.numero_ordre}`
      : `code:${row.code_substance || normSub}`;

    let grp = byKey.get(groupKey);
    if (!grp) {
      grp = { coreTokens: new Set(), allTokens: new Set(), phrases: [] };
      byKey.set(groupKey, grp);
    }
    if (normSub) grp.phrases.push(normSub.replace(/\s+/g, ' ').trim());
    for (const t of subTokens) {
      grp.allTokens.add(t);
      if (!SALT_WORDS.has(t) && t.length >= 3) grp.coreTokens.add(t);
    }
  }

  const distinctActiveCount = distinctSaCodes.size > 0
    ? distinctSaCodes.size
    : (distinctFtCodes.size > 0 ? distinctFtCodes.size : byKey.size);

  return {
    allSubstanceTokens: allTokens,
    substanceGroups: [...byKey.values()],
    distinctActiveCount,
    compoDosages
  };
}

function buildGenericsStructures(generiquesRows) {
  const generiquesByGroup = new Map();
  const roleByCis = new Map();
  const groupIdsByCis = new Map();

  for (let i = 0; i < generiquesRows.length; i++) {
    const row = generiquesRows[i];
    const gid = String(row.id_groupe || '');
    const cis = row.cis;
    if (!gid || !cis) continue;

    let grp = generiquesByGroup.get(gid);
    if (!grp) {
      grp = {
        id_groupe: gid,
        libelle_groupe: row.libelle_groupe || '',
        normLibelle: normalizeSearchText(row.libelle_groupe || ''),
        princepsCis: [],
        genericCis: [],
        allCis: []
      };
      generiquesByGroup.set(gid, grp);
    }
    grp.allCis.push(cis);
    const typeGen = String(row.type_generique ?? '');
    if (typeGen === '0') {
      grp.princepsCis.push(cis);
      roleByCis.set(cis, 'princeps');
    } else {
      grp.genericCis.push(cis);
      if (!roleByCis.has(cis)) roleByCis.set(cis, 'generic');
    }

    let cGroups = groupIdsByCis.get(cis);
    if (!cGroups) {
      cGroups = [];
      groupIdsByCis.set(cis, cGroups);
    }
    if (!cGroups.includes(gid)) cGroups.push(gid);
  }

  return { generiquesByGroup, roleByCis, groupIdsByCis };
}

function buildMitmAtcByCis(mitmRows, bdpmAtcToCis) {
  const atcByCis = new Map();
  for (let i = 0; i < mitmRows.length; i++) {
    const row = mitmRows[i];
    const cis = row.cis;
    const code = normalizeSearchText(row.code_atc).toUpperCase();
    if (!cis || !code) continue;
    let list = atcByCis.get(cis);
    if (!list) {
      list = [];
      atcByCis.set(cis, list);
    }
    if (!list.includes(code)) list.push(code);
    pushUniqueCisList(bdpmAtcToCis, code, cis);
  }
  return atcByCis;
}

function buildBdpmConceptIndexes() {
  const corpus = bdpmState.corpus;
  const cisIndexes = bdpmState.cisIndexes;

  const bdpmByCis = new Map();
  const bdpmSubTokenToCis = new Map();
  const bdpmDenomTokenToCis = new Map();
  const bdpmAtcToCis = new Map();
  const brandRootToGroupIds = new Map();
  const saFtAliases = new Map();

  if (!corpus.specialites || corpus.specialites.length === 0 || !cisIndexes) {
    return {
      bdpmByCis,
      bdpmSubTokenToCis,
      bdpmDenomTokenToCis,
      bdpmAtcToCis,
      generiquesByGroup: new Map(),
      brandRootToGroupIds,
      saFtAliases
    };
  }

  const { generiquesByGroup, roleByCis, groupIdsByCis } = buildGenericsStructures(corpus.generiques || []);
  const atcByCis = buildMitmAtcByCis(corpus.mitm || [], bdpmAtcToCis);
  const compByCis = cisIndexes.compositionsByCis;
  const presByCis = cisIndexes.presentationsByCis;

  for (let i = 0; i < corpus.specialites.length; i++) {
    const spec = corpus.specialites[i];
    const cis = spec.cis;
    const normDenom = normalizeSearchText(spec.denomination);
    const denomTokens = extractTokens(normDenom, 2);
    for (let j = 0; j < denomTokens.length; j++) {
      pushUniqueCisList(bdpmDenomTokenToCis, denomTokens[j], cis);
    }

    const compIndices = compByCis ? (compByCis.get(cis) || []) : [];
    const compRows = new Array(compIndices.length);
    for (let j = 0; j < compIndices.length; j++) {
      compRows[j] = corpus.compositions[compIndices[j]];
    }
    if (compRows.length > 0) indexSaFtPairsForRows(compRows, saFtAliases);
    const {
      allSubstanceTokens,
      substanceGroups,
      distinctActiveCount,
      compoDosages
    } = buildIngredientGroups(compRows);

    for (const tok of allSubstanceTokens) {
      pushUniqueCisList(bdpmSubTokenToCis, tok, cis);
    }

    const presIndices = presByCis ? (presByCis.get(cis) || []) : [];
    const presParts = [];
    for (let j = 0; j < presIndices.length; j++) {
      const p = corpus.presentations[presIndices[j]];
      if (p.libelle) presParts.push(p.libelle);
      if (p.indications) presParts.push(p.indications);
    }
    const normPresText = normalizeSearchText(presParts.join(' '));

    const gids = groupIdsByCis.get(cis) || [];
    const brandRoot = denomTokens[0] || '';
    if (brandRoot.length >= 3 && gids.length > 0) {
      for (const gid of gids) {
        let gSet = brandRootToGroupIds.get(brandRoot);
        if (!gSet) {
          gSet = new Set();
          brandRootToGroupIds.set(brandRoot, gSet);
        }
        gSet.add(gid);
      }
    }

    const normForme = normalizeSearchText(spec.forme_pharma);
    const normVoie = normalizeSearchText(spec.voies_admin);

    bdpmByCis.set(cis, {
      cis,
      denomination: spec.denomination || '',
      normDenom,
      brandRoot,
      denomTokenSet: new Set(denomTokens),
      denomDosages: parseDosageTokens(spec.denomination || ''),
      compoDosages,
      normForme,
      formeTokenSet: new Set(extractTokens(normForme, 2)),
      normVoie,
      voieTokenSet: new Set(extractTokens(normVoie, 2)),
      normPresText,
      allSubstanceTokens,
      substanceGroups,
      distinctActiveCount,
      genericGroupIds: gids,
      genericRole: roleByCis.get(cis) || null,
      atcCodes: atcByCis.get(cis) || [],
      isCommercialised: spec.commercialisation === 'Commercialisée'
    });
  }

  return {
    bdpmByCis,
    bdpmSubTokenToCis,
    bdpmDenomTokenToCis,
    bdpmAtcToCis,
    generiquesByGroup,
    brandRootToGroupIds,
    saFtAliases
  };
}

function buildVetConceptIndexes() {
  const corpus = vetState.corpus;
  const numIndexes = vetState.numIndexes;

  const vetByNum = new Map();
  const vetSubTokenToNum = new Map();
  const vetNomTokenToNum = new Map();
  const vetAtcToNum = new Map();

  if (!corpus.medicaments || corpus.medicaments.length === 0 || !numIndexes) {
    return { vetByNum, vetSubTokenToNum, vetNomTokenToNum, vetAtcToNum };
  }

  const compByNum = numIndexes.compositionsByNum;
  const presByNum = numIndexes.presentationsByNum;

  for (let i = 0; i < corpus.medicaments.length; i++) {
    const med = corpus.medicaments[i];
    const num = med.num;
    const normNom = normalizeSearchText(med.nom);
    const nomTokens = extractTokens(normNom, 2);
    for (let j = 0; j < nomTokens.length; j++) {
      pushUniqueCisList(vetNomTokenToNum, nomTokens[j], num);
    }

    const compIndices = compByNum ? (compByNum.get(num) || []) : [];
    const allSubstanceTokens = new Set();
    const substanceGroups = [];
    const compoDosages = [];

    for (let j = 0; j < compIndices.length; j++) {
      const comp = corpus.compositions[compIndices[j]];
      const normSub = normalizeSearchText(comp.substance);
      const subTokens = extractTokens(normSub, 2);
      const grpCore = new Set();
      const grpAll = new Set();
      for (const t of subTokens) {
        allSubstanceTokens.add(t);
        grpAll.add(t);
        if (!SALT_WORDS.has(t) && t.length >= 3) grpCore.add(t);
      }
      if (subTokens.length > 0) {
        substanceGroups.push({
          coreTokens: grpCore,
          allTokens: grpAll,
          phrases: normSub ? [normSub] : []
        });
      }
      if (comp.quantite != null && comp.quantite !== '' && comp.unite) {
        const parsed = parseDosageTokens(`${comp.quantite} ${comp.unite}`);
        for (const p of parsed) compoDosages.push(p);
      }
    }

    for (const tok of allSubstanceTokens) {
      pushUniqueCisList(vetSubTokenToNum, tok, num);
    }

    const presIndices = presByNum ? (presByNum.get(num) || []) : [];
    const presParts = [];
    for (let j = 0; j < presIndices.length; j++) {
      const p = corpus.presentations[presIndices[j]];
      if (p.libelle) presParts.push(p.libelle);
    }

    const speciesTokens = new Set();
    for (const esp of med.especes || []) {
      const canonical = canonicalizeSpeciesWord(esp);
      if (canonical) speciesTokens.add(canonical);
      for (const w of extractTokens(esp, 3)) {
        speciesTokens.add(canonicalizeSpeciesWord(w));
      }
    }

    const atcVetCodes = [];
    for (const code of med.codes_atcvet || []) {
      const clean = normalizeSearchText(code).toUpperCase();
      if (!clean) continue;
      atcVetCodes.push(clean);
      pushUniqueCisList(vetAtcToNum, clean, num);
    }

    const normForme = normalizeSearchText(med.forme_pharmaceutique);

    vetByNum.set(num, {
      num,
      nom: med.nom || '',
      normNom,
      denomTokenSet: new Set(nomTokens),
      denomDosages: parseDosageTokens(med.nom || ''),
      compoDosages,
      normForme,
      formeTokenSet: new Set(extractTokens(normForme, 2)),
      normVoie: '',
      voieTokenSet: new Set(),
      normPresText: normalizeSearchText(presParts.join(' ')),
      allSubstanceTokens,
      substanceGroups,
      distinctActiveCount: Math.max(1, substanceGroups.length),
      speciesTokens,
      atcCodes: atcVetCodes,
      isActive: !/abrog|retir/i.test(med.statut_amm || '')
    });
  }

  return { vetByNum, vetSubTokenToNum, vetNomTokenToNum, vetAtcToNum };
}

function buildConceptStore() {
  const taxonomy = buildTaxonomyVocab(bdpmState.corpus, vetState.corpus);
  const bdpm = buildBdpmConceptIndexes();
  const vet = buildVetConceptIndexes();

  return {
    taxonomy,
    ...bdpm,
    ...vet,
    stats: {
      bdpmCount: bdpm.bdpmByCis.size,
      vetCount: vet.vetByNum.size,
      saFtAliasCount: bdpm.saFtAliases.size,
      generiquesGroupCount: bdpm.generiquesByGroup.size
    }
  };
}

/**
 * Retourne le ConceptStore actif, reconstruit paresseusement si les index
 * BDPM ou ANMV ont été rechargés depuis le dernier appel.
 */
function getConceptStore({ force = false } = {}) {
  const bdpmRef = bdpmState.cisIndexes || null;
  const vetRef = vetState.numIndexes || null;
  if (
    !force &&
    cachedEntry &&
    cachedEntry.bdpmRef === bdpmRef &&
    cachedEntry.vetRef === vetRef
  ) {
    return cachedEntry.store;
  }
  const store = buildConceptStore();
  cachedEntry = { bdpmRef, vetRef, store };
  return store;
}

function resetConceptStoreCache() {
  cachedEntry = null;
}

module.exports = {
  SALT_WORDS,
  extractTokens,
  canonicalizeSpeciesWord,
  buildConceptStore,
  getConceptStore,
  resetConceptStoreCache
};
