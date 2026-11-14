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
  'calcium', 'calcique', 'magnesium', 'magnesique', 'chlorure', 'chlorhydrate', 'bromhydrate',
  'sulfate', 'phosphate', 'citrate', 'maleate', 'tartrate', 'fumarate', 'succinate',
  'mesilate', 'besilate', 'tosylate', 'valerate', 'propionate', 'acetate', 'benzoate',
  'gluconate', 'lactate', 'hydrate', 'monohydrate', 'dihydrate', 'trihydrate',
  'hemihydrate', 'sesquihydrate', 'anhydre', 'lysine', 'arginine', 'trometamol',
  'ester', 'sels', 'base'
]);
const CONCEPT_IGNORED_TOKENS = new Set([
  'de', 'du', 'des', 'l', 'le', 'la', 'les', 'au', 'aux', 'en', 'et',
  'hydrate', 'monohydrate', 'dihydrate', 'trihydrate', 'tetrahydrate',
  'pentahydrate', 'heptahydrate', 'hemihydrate', 'sesquihydrate', 'anhydre',
  'sels', 'base', 'ester'
]);

let cachedEntry = null;
let cachedTaxonomy = null;
let warmedMode = null;

const RECONSTITUTED_REF_RE = /\b(?:reconstitu[a-z]*|melange|dilution)\b/i;
const RELEASE_RATE_REF_RE = /\b(?:24\s*h(?:eures?)?|par\s+heure|\/h\b|dose\s+delivree)/i;

function parseReferenceBasis(referenceDosage) {
  const norm = normalizeSearchText(referenceDosage || '').trim();
  if (!norm) return { kind: 'none', amount: null };
  if (RECONSTITUTED_REF_RE.test(norm)) {
    return { kind: 'reconstituted_concentration', amount: null };
  }
  if (RELEASE_RATE_REF_RE.test(norm)) {
    return { kind: 'release_rate', amount: null };
  }
  const refTokens = parseDosageTokens(norm);
  if (refTokens.length === 1) {
    if (refTokens[0].unit === 'ml' && refTokens[0].amount > 0) {
      return { kind: 'volume_ml', amount: refTokens[0].amount };
    }
    if (refTokens[0].unit === 'mg' && refTokens[0].amount > 0) {
      return { kind: 'mass_mg', amount: refTokens[0].amount };
    }
  }
  if (/^\s*un[e]?\s+(?:ml|millilitre)\b/i.test(norm)) {
    return { kind: 'volume_ml', amount: 1 };
  }
  if (/^\s*un[e]?\s+(?:l|litre)\b/i.test(norm)) {
    return { kind: 'volume_ml', amount: 1000 };
  }
  if (/^\s*un[e]?\s+(?:g|gramme)\b/i.test(norm)) {
    return { kind: 'mass_mg', amount: 1000 };
  }
  return { kind: 'other', amount: null };
}

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

function extractConceptTokens(rawText) {
  if (!rawText) return [];
  const precleaned = String(rawText)
    .replace(/\b[dlDL]['’]/gu, ' ')
    .replace(/\b[àÀ]\b/gu, ' ');
  const norm = normalizeSearchText(precleaned);
  if (!norm) return [];
  const raw = norm.split(TOKEN_SPLIT_RE);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (!t || CONCEPT_IGNORED_TOKENS.has(t)) continue;
    if (t.length >= 2 || /^\d$/.test(t) || /^[abcegkvd]$/.test(t)) {
      out.push(t);
    }
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

function buildIngredientGroups(compRows) {
  const seenKeys = new Set();
  const distinctSaCodes = new Set();
  const distinctFtCodes = new Set();
  const allTokens = new Set();
  const compoDosages = [];
  const rowBases = new Set();
  const rowConcMgMl = [];

  for (let i = 0; i < compRows.length; i++) {
    const row = compRows[i];
    const normSub = normalizeSearchText(row.denomination_substance);
    const subTokens = extractConceptTokens(row.denomination_substance);
    for (let k = 0; k < subTokens.length; k++) allTokens.add(subTokens[k]);

    const refBasis = parseReferenceBasis(row.reference_dosage);
    if (refBasis.kind === 'reconstituted_concentration') {
      rowBases.add('reconstituted_concentration');
    } else if (refBasis.kind === 'release_rate') {
      rowBases.add('release_rate');
    }

    if (row.dosage) {
      const normDose = normalizeSearchText(row.dosage);
      if (RECONSTITUTED_REF_RE.test(normDose)) {
        rowBases.add('reconstituted_concentration');
      } else if (RELEASE_RATE_REF_RE.test(normDose)) {
        rowBases.add('release_rate');
      }
      const parsed = parseDosageTokens(row.dosage);
      for (let k = 0; k < parsed.length; k++) {
        const d = parsed[k];
        compoDosages.push(d);
        if (refBasis.kind === 'volume_ml' && refBasis.amount > 0) {
          if (d.unit === 'mg') {
            rowBases.add('mass_volume');
            rowConcMgMl.push(d.amount / refBasis.amount);
          } else if (d.unit === 'ml') {
            rowBases.add('volume_volume');
          }
        } else if (refBasis.kind === 'mass_mg' && refBasis.amount > 0 && d.unit === 'mg') {
          rowBases.add('mass_mass');
        }
      }
    }

    if (row.nature_composant === 'SA' && row.code_substance) {
      distinctSaCodes.add(row.code_substance);
    } else if (row.nature_composant === 'FT' && row.code_substance) {
      distinctFtCodes.add(row.code_substance);
    }

    const hasOrder = row.numero_ordre != null && row.numero_ordre !== '';
    seenKeys.add(hasOrder ? `ord:${row.numero_ordre}` : `code:${row.code_substance || normSub}`);
  }

  const distinctActiveCount = distinctSaCodes.size > 0
    ? distinctSaCodes.size
    : (distinctFtCodes.size > 0 ? distinctFtCodes.size : seenKeys.size);

  let compoConcentrationBasis = 'unknown';
  let compoConcMgMl = null;
  if (rowBases.has('reconstituted_concentration')) {
    compoConcentrationBasis = 'reconstituted_concentration';
  } else if (rowBases.has('release_rate')) {
    compoConcentrationBasis = 'release_rate';
  } else if (distinctActiveCount === 1 && rowBases.size === 1) {
    const onlyBasis = [...rowBases][0];
    compoConcentrationBasis = onlyBasis;
    if (onlyBasis === 'mass_volume' && rowConcMgMl.length > 0) {
      compoConcMgMl = rowConcMgMl[0];
    }
  }

  return {
    allTokens,
    distinctActiveCount,
    compoDosages,
    compoConcentrationBasis,
    compoConcMgMl
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
        normLibelle: normalizeSearchText(row.libelle_groupe || ''),
        allCis: []
      };
      generiquesByGroup.set(gid, grp);
    }
    grp.allCis.push(cis);
    const typeGen = String(row.type_generique ?? '');
    if (typeGen === '0') {
      roleByCis.set(cis, 'princeps');
    } else if (!roleByCis.has(cis)) {
      roleByCis.set(cis, 'generic');
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

function populateBdpmAtcIndex(mitmRows, bdpmAtcToCis) {
  for (let i = 0; i < mitmRows.length; i++) {
    const row = mitmRows[i];
    const cis = row.cis;
    const code = normalizeSearchText(row.code_atc).toUpperCase();
    if (!cis || !code) continue;
    pushUniqueCisList(bdpmAtcToCis, code, cis);
  }
}

function buildBdpmConceptIndexes() {
  const corpus = bdpmState.corpus;
  const cisIndexes = bdpmState.cisIndexes;

  const bdpmByCis = new Map();
  const bdpmSubTokenToCis = new Map();
  const bdpmDenomTokenToCis = new Map();
  const bdpmAtcToCis = new Map();
  const brandRootToGroupIds = new Map();

  if (!corpus.specialites || corpus.specialites.length === 0 || !cisIndexes) {
    return {
      bdpmByCis,
      bdpmSubTokenToCis,
      bdpmDenomTokenToCis,
      bdpmAtcToCis,
      generiquesByGroup: new Map(),
      brandRootToGroupIds
    };
  }

  const { generiquesByGroup, roleByCis, groupIdsByCis } = buildGenericsStructures(corpus.generiques || []);
  populateBdpmAtcIndex(corpus.mitm || [], bdpmAtcToCis);
  const compByCis = cisIndexes.compositionsByCis;
  const presByCis = cisIndexes.presentationsByCis;

  for (let i = 0; i < corpus.specialites.length; i++) {
    const spec = corpus.specialites[i];
    const cis = spec.cis;
    const normDenom = normalizeSearchText(spec.denomination);
    const denomTokens = extractConceptTokens(spec.denomination);
    for (let j = 0; j < denomTokens.length; j++) {
      pushUniqueCisList(bdpmDenomTokenToCis, denomTokens[j], cis);
    }

    const compIndices = compByCis ? (compByCis.get(cis) || []) : [];
    const compRows = new Array(compIndices.length);
    for (let j = 0; j < compIndices.length; j++) {
      compRows[j] = corpus.compositions[compIndices[j]];
    }
    const {
      allTokens,
      distinctActiveCount,
      compoDosages,
      compoConcentrationBasis,
      compoConcMgMl
    } = buildIngredientGroups(compRows);

    for (const tok of allTokens) {
      pushUniqueCisList(bdpmSubTokenToCis, tok, cis);
    }

    const presIndices = presByCis ? (presByCis.get(cis) || []) : [];
    const presParts = [];
    for (let j = 0; j < presIndices.length; j++) {
      const p = corpus.presentations[presIndices[j]];
      if (p.libelle) presParts.push(p.libelle);
      if (p.indications) presParts.push(p.indications);
    }
    const normPresText = presParts.length > 0 ? normalizeSearchText(presParts.join(' ')) : '';
    const presVolumesMl = normPresText
      ? parseDosageTokens(normPresText).filter((t) => t.unit === 'ml').map((t) => t.amount)
      : [];

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
      denomDosages: parseDosageTokens(spec.denomination || ''),
      compoDosages,
      compoConcentrationBasis,
      compoConcMgMl,
      presVolumesMl,
      normForme,
      normVoie,
      normPresText,
      distinctActiveCount,
      genericGroupIds: gids,
      genericRole: roleByCis.get(cis) || null,
      isCommercialised: spec.commercialisation === 'Commercialisée'
    });
  }

  return {
    bdpmByCis,
    bdpmSubTokenToCis,
    bdpmDenomTokenToCis,
    bdpmAtcToCis,
    generiquesByGroup,
    brandRootToGroupIds
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
    const nomTokens = extractConceptTokens(med.nom);
    for (let j = 0; j < nomTokens.length; j++) {
      pushUniqueCisList(vetNomTokenToNum, nomTokens[j], num);
    }

    const compIndices = compByNum ? (compByNum.get(num) || []) : [];
    const subTokensSeen = new Set();
    const compoDosages = [];

    for (let j = 0; j < compIndices.length; j++) {
      const comp = corpus.compositions[compIndices[j]];
      const subTokens = extractConceptTokens(comp.substance);
      for (let k = 0; k < subTokens.length; k++) subTokensSeen.add(subTokens[k]);
      if (comp.quantite != null && comp.quantite !== '' && comp.unite) {
        const parsed = parseDosageTokens(`${comp.quantite} ${comp.unite}`);
        for (let k = 0; k < parsed.length; k++) compoDosages.push(parsed[k]);
      }
    }

    for (const tok of subTokensSeen) {
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

    for (const code of med.codes_atcvet || []) {
      const clean = normalizeSearchText(code).toUpperCase();
      if (!clean) continue;
      pushUniqueCisList(vetAtcToNum, clean, num);
    }

    const normForme = normalizeSearchText(med.forme_pharmaceutique);
    const normPresText = presParts.length > 0 ? normalizeSearchText(presParts.join(' ')) : '';
    const presVolumesMl = normPresText
      ? parseDosageTokens(normPresText).filter((t) => t.unit === 'ml').map((t) => t.amount)
      : [];

    vetByNum.set(num, {
      num,
      nom: med.nom || '',
      normNom,
      normDenom: normNom,
      denomDosages: parseDosageTokens(med.nom || ''),
      compoDosages,
      compoConcentrationBasis: 'unknown',
      compoConcMgMl: null,
      presVolumesMl,
      normForme,
      normVoie: '',
      normPresText,
      distinctActiveCount: Math.max(1, compIndices.length),
      speciesTokens,
      isActive: !/abrog|retir/i.test(med.statut_amm || '')
    });
  }

  return { vetByNum, vetSubTokenToNum, vetNomTokenToNum, vetAtcToNum };
}

/**
 * Retourne le vocabulaire taxonomique (formes/voies/especes) léger,
 * utilisable dès B1 sans matérialiser le ConceptStore complet.
 */
function getTaxonomyVocab({ force = false } = {}) {
  const bdpmRef = bdpmState.cisIndexes || null;
  const vetRef = vetState.numIndexes || null;
  if (
    !force &&
    cachedTaxonomy &&
    cachedTaxonomy.bdpmRef === bdpmRef &&
    cachedTaxonomy.vetRef === vetRef
  ) {
    return cachedTaxonomy.taxonomy;
  }
  const taxonomy = buildTaxonomyVocab(bdpmState.corpus, vetState.corpus);
  cachedTaxonomy = { bdpmRef, vetRef, taxonomy };
  return taxonomy;
}

function buildConceptStore() {
  const taxonomy = getTaxonomyVocab();
  const bdpm = buildBdpmConceptIndexes();
  const vet = buildVetConceptIndexes();

  return {
    taxonomy,
    ...bdpm,
    ...vet,
    stats: {
      bdpmCount: bdpm.bdpmByCis.size,
      vetCount: vet.vetByNum.size,
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

function hasConceptStoreCached() {
  const bdpmRef = bdpmState.cisIndexes || null;
  const vetRef = vetState.numIndexes || null;
  return Boolean(
    cachedEntry &&
    cachedEntry.bdpmRef === bdpmRef &&
    cachedEntry.vetRef === vetRef
  );
}

function hasTaxonomyCached() {
  const bdpmRef = bdpmState.cisIndexes || null;
  const vetRef = vetState.numIndexes || null;
  return Boolean(
    cachedTaxonomy &&
    cachedTaxonomy.bdpmRef === bdpmRef &&
    cachedTaxonomy.vetRef === vetRef
  );
}

function resetConceptStoreCache() {
  cachedEntry = null;
  cachedTaxonomy = null;
  warmedMode = 'legacy';
}

/**
 * Prépare explicitement hors du chemin de la première requête utilisateur les
 * structures nécessaires au mode demandé (`structured` -> taxonomie seule ;
 * `concepts` -> taxonomie + ConceptStore). En mode `legacy`, ne matérialise rien.
 */
function warmExperimentalSearch(mode = 'legacy') {
  const normalized = String(mode || 'legacy').toLowerCase();
  if (normalized === 'concepts') {
    warmedMode = 'concepts';
    getConceptStore({ force: true });
    return { mode: 'concepts', taxonomyWarmed: true, conceptStoreWarmed: true };
  }
  if (normalized === 'structured') {
    if (warmedMode !== 'concepts') warmedMode = 'structured';
    getTaxonomyVocab({ force: true });
    return { mode: 'structured', taxonomyWarmed: true, conceptStoreWarmed: hasConceptStoreCached() };
  }
  return {
    mode: 'legacy',
    taxonomyWarmed: hasTaxonomyCached(),
    conceptStoreWarmed: hasConceptStoreCached()
  };
}

/**
 * Appelé avant un rechargement de corpus (`clearLoadedData`) pour libérer
 * immédiatement les structures dérivées de la génération précédente.
 */
function onCorpusCleared() {
  cachedEntry = null;
  cachedTaxonomy = null;
}

/**
 * Appelé à la fin d'un chargement/rechargement de corpus (`loadData` / `loadVetData`)
 * pour maintenir la cohérence des structures préchauffées.
 */
function onCorpusLoaded(configuredWarmupMode = 'legacy') {
  const effectiveMode = warmedMode === 'concepts' || configuredWarmupMode === 'concepts'
    ? 'concepts'
    : (warmedMode === 'structured' || configuredWarmupMode === 'structured' ? 'structured' : 'legacy');
  if (effectiveMode === 'concepts') {
    return getConceptStore({ force: true });
  }
  if (effectiveMode === 'structured') {
    return getTaxonomyVocab({ force: true });
  }
  return null;
}

module.exports = {
  SALT_WORDS,
  CONCEPT_IGNORED_TOKENS,
  extractTokens,
  extractConceptTokens,
  canonicalizeSpeciesWord,
  parseReferenceBasis,
  buildIngredientGroups,
  getTaxonomyVocab,
  getConceptStore,
  hasConceptStoreCached,
  hasTaxonomyCached,
  resetConceptStoreCache,
  warmExperimentalSearch,
  onCorpusCleared,
  onCorpusLoaded
};
