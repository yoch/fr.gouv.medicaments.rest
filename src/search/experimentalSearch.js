'use strict';

/**
 * Pipeline expérimental opt-in (étapes B1 / B2).
 *
 * - mode='structured' (B1) : interpréteur de requête strict (sans alias externes)
 *   + recherche MiniSearch existante + scoring tri-état (matched/contradicted/unknown)
 *   + résolution explicite sans perte silencieuse.
 * - mode='concepts' (B2) : B1 + alias pharmaceutiques traçables (galénique, voies)
 *   + ConceptStore par entité (jointures CIS_COMPO SA<->FT, CIS_GENER princeps/génériques,
 *   ANMV substances x espèces, préférence mono-principe actif sur requête simple).
 *
 * Aucun impact sur le chemin par défaut (`executeHybridSearchPage` dans searchOrchestrator.js).
 */

const {
  searchKeyMatches,
  getSpecialiteByCis,
  getSpecialiteLabelByCis,
  getRelatedByCis,
  bdpmExtraitUrl,
  HYDRATE_RELATED_LIMIT
} = require('../services/dataLoader');
const {
  searchVetKeyMatches,
  getMedicamentByNum,
  getMedicamentLabelByNum,
  getRelatedByNum
} = require('../services/vetDataLoader');
const { collectBdpmMatches } = require('../services/searchOrchestrator');
const { parseListPaging } = require('../utils/corpusPaging');
const {
  normalizeSearchText,
  createMatchPriorityClassifier,
  isStrongMatchQuality,
  MATCH_QUALITY_RANK
} = require('../utils/searchRanking');
const {
  parseDosageTokens,
  matchDosageTokens
} = require('../utils/structuredSearchCriteria');
const { parseStructuredQuery } = require('./structuredQueryParser');
const { analyzeQuerySafetyAndIntent, inspectCriterionConstraint } = require('./queryIntentGuard');
const {
  SALT_WORDS,
  extractTokens,
  canonicalizeSpeciesWord,
  getTaxonomyVocab,
  getConceptStore
} = require('./conceptStore');

const VALID_EXPERIMENTAL_MODES = new Set(['structured', 'concepts']);
const VIA_BONUS = {
  cis: 5,
  num: 5,
  atc: 4,
  denomination: 3,
  generique: 2.5,
  presentation: 2,
  composition: 1,
  concept: 1
};

function normalizeSource(source) {
  const value = (source || 'auto').toLowerCase();
  return ['auto', 'human', 'veterinary', 'mixed'].includes(value) ? value : 'auto';
}

function hydrateExperimentalHit(ref, matchesBySource) {
  let result;
  if (ref.source === 'bdpm') {
    const m = matchesBySource.bdpm;
    result = {
      type: 'medicament',
      match_quality: ref.match_quality,
      ...(getSpecialiteByCis(ref.key) || { cis: ref.key, url_bdpm: bdpmExtraitUrl(ref.key) }),
      presentations: getRelatedByCis('presentations', ref.key, HYDRATE_RELATED_LIMIT),
      compositions: getRelatedByCis('compositions', ref.key, HYDRATE_RELATED_LIMIT)
    };
    const via = ref.match_via || (m && m.metaByKey[ref.key] && m.metaByKey[ref.key].via);
    if (via) result.match_via = via;
  } else {
    const m = matchesBySource.vet;
    result = {
      type: 'medicament_veterinaire',
      match_quality: ref.match_quality,
      ...(getMedicamentByNum(ref.key) || { num: ref.key }),
      presentations: getRelatedByNum('presentations', ref.key),
      compositions: getRelatedByNum('compositions', ref.key)
    };
    const via = ref.match_via || (m && m.metaByKey[ref.key] && m.metaByKey[ref.key].via);
    if (via) result.match_via = via;
  }
  if (ref.criteria_match) result.criteria_match = ref.criteria_match;
  if (ref.criteria_status) result.criteria_status = ref.criteria_status;
  return result;
}

function collectLegacyVetMatches(q) {
  const qualityByKey = {};
  const metaByKey = {};
  const searches = [
    { items: searchVetKeyMatches('medicaments', q), via: 'denomination' },
    { items: searchVetKeyMatches('compositions', q), via: 'composition' }
  ];
  for (const { items, via } of searches) {
    for (const item of items) {
      const key = item.num;
      if (!key) continue;
      const prevMeta = metaByKey[key];
      if (
        !prevMeta ||
        MATCH_QUALITY_RANK[item.match_quality] > MATCH_QUALITY_RANK[prevMeta.quality] ||
        (item.match_quality === prevMeta.quality && (VIA_BONUS[via] || 0) > (VIA_BONUS[prevMeta.via] || 0))
      ) {
        metaByKey[key] = { quality: item.match_quality, via };
      }
      if (!qualityByKey[key] || MATCH_QUALITY_RANK[item.match_quality] > MATCH_QUALITY_RANK[qualityByKey[key]]) {
        qualityByKey[key] = item.match_quality;
      }
    }
  }
  const trimmed = String(q || '').trim();
  if (/^\d+$/.test(trimmed)) {
    const num = trimmed.padStart(7, '0');
    if (qualityByKey[num] === 'exact') metaByKey[num] = { quality: 'exact', via: 'num' };
  }
  return { qualityByKey, metaByKey };
}

/**
 * Recherche BDPM par entités via ConceptStore (résout les multi-substances
 * sur lignes CIS_COMPO distinctes, SA<->FT, et fallback dénomination).
 */
function collectBdpmConceptMatches(parsed, store) {
  const qualityByKey = {};
  const metaByKey = {};
  const tokens = (parsed.nameTokens || []).filter((t) => t.length >= 2);
  if (tokens.length === 0) return { qualityByKey, metaByKey };

  // Codes ATC exacts via MITM
  if (parsed.kind === 'exact_code' && parsed.code && parsed.code.kind === 'atc_code') {
    const list = store.bdpmAtcToCis.get(parsed.code.code) || [];
    for (const cis of list) {
      qualityByKey[cis] = 'exact';
      metaByKey[cis] = { quality: 'exact', via: 'atc', coveredTokens: 1, totalTokens: 1 };
    }
    return { qualityByKey, metaByKey };
  }

  const substantiveTokens = tokens.filter((t) => t.length >= 3 && !SALT_WORDS.has(t));
  const queryToks = substantiveTokens.length > 0 ? substantiveTokens : tokens;
  if (queryToks.length === 0) return { qualityByKey, metaByKey };

  // Compter pour chaque CIS combien de tokens de la requête trouvent un appui
  // (dénomination OU substance active / fraction thérapeutique)
  const hitCountByCis = new Map();
  const denomHitByCis = new Map();

  for (const tok of queryToks) {
    const cisVisitedThisToken = new Set();

    const denomHits = store.bdpmDenomTokenToCis.get(tok) || [];
    for (let i = 0; i < denomHits.length; i++) {
      const cis = denomHits[i];
      denomHitByCis.set(cis, (denomHitByCis.get(cis) || 0) + 1);
      if (!cisVisitedThisToken.has(cis)) {
        cisVisitedThisToken.add(cis);
        hitCountByCis.set(cis, (hitCountByCis.get(cis) || 0) + 1);
      }
    }

    const subHits = store.bdpmSubTokenToCis.get(tok) || [];
    for (let i = 0; i < subHits.length; i++) {
      const cis = subHits[i];
      if (!cisVisitedThisToken.has(cis)) {
        cisVisitedThisToken.add(cis);
        hitCountByCis.set(cis, (hitCountByCis.get(cis) || 0) + 1);
      }
    }
  }

  // Exiger couverture complète des tokens substantifs pour éviter les faux positifs
  const requiredHits = queryToks.length;
  const normQuery = normalizeSearchText(parsed.nameQuery);
  const classifier = createMatchPriorityClassifier(normQuery);

  for (const [cis, count] of hitCountByCis.entries()) {
    if (count < requiredHits) continue;
    const rec = store.bdpmByCis.get(cis);
    if (!rec) continue;

    const denomHits = denomHitByCis.get(cis) || 0;
    const allInDenom = denomHits >= requiredHits;
    const cls = classifier(rec.denomination, { idValue: cis });
    let quality = 'prefix';
    if (cls === 2) quality = 'exact';
    else if (!allInDenom && requiredHits >= 2) quality = 'prefix';

    const via = allInDenom ? 'denomination' : 'composition';
    qualityByKey[cis] = quality;
    metaByKey[cis] = {
      quality,
      via,
      coveredTokens: count,
      totalTokens: requiredHits,
      allSubstancesMatched: requiredHits >= 2 && rec.distinctActiveCount >= 2
    };
  }

  return { qualityByKey, metaByKey };
}

/**
 * Résout l'intention explicite « générique de X » / « équivalent X » via CIS_GENER.
 */
function expandGenericGroupMatches(parsed, baseMatches, store) {
  if (!parsed.extracted.intents.includes('generic_equivalent')) return null;

  const anchorKeys = Object.keys(baseMatches.qualityByKey);
  const groupIds = new Set();

  for (const cis of anchorKeys) {
    const rec = store.bdpmByCis.get(cis);
    if (!rec) continue;
    for (const gid of rec.genericGroupIds) groupIds.add(gid);
  }

  // Fallback si l'ancre exacte n'était pas directement dans CIS_GENER mais partage brandRoot
  if (groupIds.size === 0) {
    for (const cis of anchorKeys) {
      const rec = store.bdpmByCis.get(cis);
      if (!rec || !rec.brandRoot) continue;
      const gSet = store.brandRootToGroupIds.get(rec.brandRoot);
      if (gSet) {
        for (const gid of gSet) groupIds.add(gid);
      }
    }
  }

  // Dernier repli : chercher le nom de marque dans libelle_groupe
  if (groupIds.size === 0 && parsed.nameTokens.length > 0) {
    const core = parsed.nameTokens.filter((t) => t.length >= 3);
    if (core.length > 0) {
      for (const [gid, grp] of store.generiquesByGroup.entries()) {
        if (core.every((t) => grp.normLibelle.includes(t))) {
          groupIds.add(gid);
        }
      }
    }
  }

  if (groupIds.size === 0) return null;

  const qualityByKey = { ...baseMatches.qualityByKey };
  const metaByKey = { ...baseMatches.metaByKey };

  for (const gid of groupIds) {
    const grp = store.generiquesByGroup.get(gid);
    if (!grp) continue;
    for (const cis of grp.allCis) {
      if (!qualityByKey[cis]) {
        qualityByKey[cis] = 'prefix';
        metaByKey[cis] = { quality: 'prefix', via: 'generique', genericExpanded: true };
      } else {
        metaByKey[cis] = { ...metaByKey[cis], genericExpanded: true };
      }
    }
  }

  return { qualityByKey, metaByKey };
}

/**
 * Recherche vétérinaire par entités (substances x espèces x dosage).
 */
function collectVetConceptMatches(parsed, store) {
  const qualityByKey = {};
  const metaByKey = {};

  if (parsed.kind === 'exact_code' && parsed.code && parsed.code.kind === 'atc_code') {
    const list = store.vetAtcToNum.get(parsed.code.code) || [];
    for (const num of list) {
      qualityByKey[num] = 'exact';
      metaByKey[num] = { quality: 'exact', via: 'atc' };
    }
    return { qualityByKey, metaByKey };
  }

  const tokens = (parsed.nameTokens || []).filter((t) => t.length >= 2);
  const substantiveTokens = tokens.filter((t) => t.length >= 3 && !SALT_WORDS.has(t));
  const queryToks = substantiveTokens.length > 0 ? substantiveTokens : tokens;
  if (queryToks.length === 0) return { qualityByKey, metaByKey };

  const hitCountByNum = new Map();
  const nomHitByNum = new Map();

  for (const tok of queryToks) {
    const visited = new Set();
    for (const num of store.vetNomTokenToNum.get(tok) || []) {
      nomHitByNum.set(num, (nomHitByNum.get(num) || 0) + 1);
      if (!visited.has(num)) {
        visited.add(num);
        hitCountByNum.set(num, (hitCountByNum.get(num) || 0) + 1);
      }
    }
    for (const num of store.vetSubTokenToNum.get(tok) || []) {
      if (!visited.has(num)) {
        visited.add(num);
        hitCountByNum.set(num, (hitCountByNum.get(num) || 0) + 1);
      }
    }
  }

  const reqHits = queryToks.length;
  for (const [num, count] of hitCountByNum.entries()) {
    if (count < reqHits) continue;
    const rec = store.vetByNum.get(num);
    if (!rec) continue;
    const allInNom = (nomHitByNum.get(num) || 0) >= reqHits;
    qualityByKey[num] = 'prefix';
    metaByKey[num] = {
      quality: 'prefix',
      via: allInNom ? 'denomination' : 'composition'
    };
  }

  return { qualityByKey, metaByKey };
}

function mergeMatchMaps(primary, secondary) {
  const qualityByKey = { ...primary.qualityByKey };
  const metaByKey = { ...primary.metaByKey };
  for (const [k, q] of Object.entries(secondary.qualityByKey)) {
    const secMeta = secondary.metaByKey[k] || { quality: q, via: 'concept' };
    const prevQ = qualityByKey[k];
    if (!prevQ || MATCH_QUALITY_RANK[q] > MATCH_QUALITY_RANK[prevQ]) {
      qualityByKey[k] = q;
      metaByKey[k] = secMeta;
    } else if (prevQ === q && metaByKey[k]) {
      metaByKey[k] = {
        ...metaByKey[k],
        ...(secMeta.allSubstancesMatched ? { allSubstancesMatched: true } : {}),
        ...(secMeta.genericExpanded ? { genericExpanded: true } : {})
      };
    }
  }
  return { qualityByKey, metaByKey };
}

function buildStructuredEntityRecord(source, key, parsed) {
  const needCompoDosage = Boolean(parsed?.effectiveCriteria?.dosage);
  const needSpecies = Boolean(parsed?.effectiveCriteria?.species?.length);

  if (source === 'bdpm') {
    const spec = getSpecialiteByCis(key);
    if (!spec) return null;
    const denom = spec.denomination || '';
    const denomDosages = parseDosageTokens(denom);
    let compoDosages = [];
    if (needCompoDosage && denomDosages.length === 0) {
      const comps = getRelatedByCis('compositions', key, 50) || [];
      for (let i = 0; i < comps.length; i++) {
        if (comps[i].dosage) {
          for (const p of parseDosageTokens(comps[i].dosage)) compoDosages.push(p);
        }
      }
    }
    return {
      cis: key,
      denomination: denom,
      normDenom: normalizeSearchText(denom),
      denomDosages,
      compoDosages,
      normForme: normalizeSearchText(spec.forme_pharma),
      normVoie: normalizeSearchText(spec.voies_admin),
      normPresText: ''
    };
  }

  const med = getMedicamentByNum(key);
  if (!med) return null;
  const nom = med.nom || '';
  const denomDosages = parseDosageTokens(nom);
  let compoDosages = [];
  if (needCompoDosage && denomDosages.length === 0) {
    const comps = getRelatedByNum('compositions', key) || [];
    for (let i = 0; i < comps.length; i++) {
      const c = comps[i];
      if (c.quantite != null && c.quantite !== '' && c.unite) {
        for (const p of parseDosageTokens(`${c.quantite} ${c.unite}`)) compoDosages.push(p);
      }
    }
  }
  const speciesTokens = new Set();
  if (needSpecies) {
    for (const esp of med.especes || []) {
      const canonical = canonicalizeSpeciesWord(esp);
      if (canonical) speciesTokens.add(canonical);
      for (const w of extractTokens(esp, 3)) {
        speciesTokens.add(canonicalizeSpeciesWord(w));
      }
    }
  }
  return {
    num: key,
    nom,
    normNom: normalizeSearchText(nom),
    normDenom: normalizeSearchText(nom),
    denomDosages,
    compoDosages,
    normForme: normalizeSearchText(med.forme_pharmaceutique),
    normVoie: '',
    normPresText: '',
    speciesTokens
  };
}

const FORME_STOP_WORDS = new Set([
  'a', 'au', 'aux', 'd', 'dans', 'de', 'des', 'du', 'en', 'et', 'l', 'la', 'le', 'les', 'ou', 'par', 'pour', 'sans', 'sur', 'un', 'une'
]);
const GENERIC_GALENIC_CARRIERS = new Set([
  'solution', 'poudre', 'suspension', 'dispersion', 'emulsion', 'preparation', 'liquide', 'solvant'
]);
const FORME_CANONICAL_TOKENS = new Map([
  ['comprimes', 'comprime'],
  ['cpr', 'comprime'],
  ['cp', 'comprime'],
  ['comp', 'comprime'],
  ['gelules', 'gelule'],
  ['gels', 'gel'],
  ['capsules', 'capsule'],
  ['sirops', 'sirop'],
  ['collyres', 'collyre'],
  ['suppositoires', 'suppositoire'],
  ['suppos', 'suppositoire'],
  ['suppo', 'suppositoire'],
  ['sachets', 'sachet'],
  ['sach', 'sachet'],
  ['ampoules', 'ampoule'],
  ['amp', 'ampoule'],
  ['flacons', 'flacon'],
  ['fl', 'flacon'],
  ['ovules', 'ovule'],
  ['poudres', 'poudre'],
  ['pdr', 'poudre'],
  ['solutions', 'solution'],
  ['suspensions', 'suspension'],
  ['emulsions', 'emulsion'],
  ['pommades', 'pommade'],
  ['cremes', 'creme'],
  ['granules', 'granule'],
  ['granule', 'granule'],
  ['patchs', 'patch'],
  ['effervescents', 'effervescent'],
  ['effervescente', 'effervescent'],
  ['effervescentes', 'effervescent'],
  ['eff', 'effervescent'],
  ['pellicules', 'pellicule'],
  ['pelliculee', 'pellicule'],
  ['pelliculees', 'pellicule'],
  ['secables', 'secable'],
  ['orodispersibles', 'orodispersible'],
  ['oro', 'orodispersible'],
  ['dispersibles', 'dispersible'],
  ['resistants', 'resistant'],
  ['resistante', 'resistant'],
  ['resistantes', 'resistant'],
  ['prolongee', 'prolonge'],
  ['prolonges', 'prolonge'],
  ['prolongees', 'prolonge'],
  ['buvables', 'buvable'],
  ['buv', 'buvable'],
  ['injectables', 'injectable'],
  ['inj', 'injectable'],
  ['sublinguales', 'sublingual'],
  ['sublinguale', 'sublingual'],
  ['auriculaires', 'auriculaire']
]);

const VOIE_CANONICAL_ALIASES = new Map([
  ['voie orale', 'orale'],
  ['per os', 'orale'],
  ['po', 'orale'],
  ['voie per os', 'orale'],
  ['oral', 'orale'],
  ['orale', 'orale'],
  ['iv', 'intraveineuse'],
  ['voie iv', 'intraveineuse'],
  ['intraveineux', 'intraveineuse'],
  ['voie intraveineuse', 'intraveineuse'],
  ['intraveineuse', 'intraveineuse'],
  ['im', 'intramusculaire'],
  ['voie im', 'intramusculaire'],
  ['voie intramusculaire', 'intramusculaire'],
  ['intramusculaire', 'intramusculaire'],
  ['sc', 'sous cutanee'],
  ['voie sc', 'sous cutanee'],
  ['sous cutane', 'sous cutanee'],
  ['sous cutanee', 'sous cutanee'],
  ['voie sous cutanee', 'sous cutanee'],
  ['cutane', 'cutanee'],
  ['cutanee', 'cutanee'],
  ['voie cutanee', 'cutanee'],
  ['ophtalmique', 'ophtalmique'],
  ['voie ophtalmique', 'ophtalmique'],
  ['auriculaire', 'auriculaire'],
  ['voie auriculaire', 'auriculaire'],
  ['nasal', 'nasale'],
  ['nasale', 'nasale'],
  ['voie nasale', 'nasale'],
  ['rectal', 'rectale'],
  ['rectale', 'rectale'],
  ['voie rectale', 'rectale'],
  ['vaginal', 'vaginale'],
  ['vaginale', 'vaginale'],
  ['voie vaginale', 'vaginale'],
  ['sublingual', 'sublinguale'],
  ['sublinguale', 'sublinguale'],
  ['voie sublinguale', 'sublinguale'],
  ['transdermique', 'transdermique'],
  ['voie transdermique', 'transdermique'],
  ['inhale', 'inhalee'],
  ['inhalee', 'inhalee'],
  ['inhalation', 'inhalee'],
  ['voie inhalee', 'inhalee'],
  ['buccale autre', 'voie buccale autre'],
  ['extracorporelle autre', 'voie extracorporelle autre'],
  ['parenterale autre', 'voie parenterale autre']
]);

function normalizeGalenicWord(token) {
  return FORME_CANONICAL_TOKENS.get(token) || token;
}

function tokenizeGalenicText(value) {
  const cleaned = normalizeSearchText(value)
    .replace(/([a-z0-9])\((?:e|es|s)\)/g, '$1')
    .replace(/\blp\b/g, 'liberation prolonge')
    .replace(/\bsol\s+buv(?:able)?\b/g, 'solution buvable')
    .replace(/\bsol\s+inj(?:ectable)?\b/g, 'solution injectable');
  if (!cleaned) return [];
  const raw = cleaned.split(/[\s'’()\-–—,;:/]+/u);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (!t) continue;
    out.push(normalizeGalenicWord(t));
  }
  return out;
}

function splitGalenicClauses(value) {
  const norm = normalizeSearchText(value)
    .replace(/([a-z0-9])\((?:e|es|s)\)/g, '$1');
  if (!norm) return [];
  const parts = norm.split(/\s*;\s*|\s+\bet\b\s+/);
  const clauses = [];
  for (const part of parts) {
    const allTokens = tokenizeGalenicText(part);
    if (allTokens.length === 0) continue;
    const filtered = allTokens.filter((t) => !FORME_STOP_WORDS.has(t));
    clauses.push({
      allTokens,
      tokenSet: new Set(allTokens),
      sigTokens: filtered.length > 0 ? filtered : allTokens,
      sigSet: new Set(filtered.length > 0 ? filtered : allTokens)
    });
  }
  return clauses;
}

function containsTokenSequence(tokens, sequence) {
  if (sequence.length === 0 || tokens.length < sequence.length) return false;
  const limit = tokens.length - sequence.length;
  for (let i = 0; i <= limit; i++) {
    let ok = true;
    for (let j = 0; j < sequence.length; j++) {
      if (tokens[i + j] !== sequence[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function matchesGalenicPhrase(clauses, phrase) {
  const phraseTokens = tokenizeGalenicText(phrase);
  if (phraseTokens.length === 0) return false;
  for (const clause of clauses) {
    if (phraseTokens.length === 1) {
      if (clause.tokenSet.has(phraseTokens[0])) return true;
    } else if (containsTokenSequence(clause.allTokens, phraseTokens)) {
      return true;
    }
  }
  return false;
}

/**
 * Évalue la satisfaction métier d'une forme galénique sur des tokens/expressions
 * complets (jamais par simple sous-chaîne : `gel` != `gelule`, `comprime` != `compresse`).
 */
function matchFormeCriterion(requestedForme, candidateNormForme, { useAliases = false, altFormes = [], normPresText = '' } = {}) {
  const candClauses = splitGalenicClauses(candidateNormForme);
  if (candClauses.length === 0) {
    return { matched: false, status: 'unknown', boost: 0 };
  }

  const reqAll = tokenizeGalenicText(requestedForme);
  const reqFiltered = reqAll.filter((t) => !FORME_STOP_WORDS.has(t));
  const reqSig = [...new Set(reqFiltered.length > 0 ? reqFiltered : reqAll)];
  if (reqSig.length === 0) {
    return { matched: false, status: 'unknown', boost: 0 };
  }

  let bestNonCarrierRatio = 0;
  for (const clause of candClauses) {
    let hits = 0;
    let nonCarrierHits = 0;
    for (const tok of reqSig) {
      if (clause.sigSet.has(tok) || clause.tokenSet.has(tok)) {
        hits++;
        if (!GENERIC_GALENIC_CARRIERS.has(tok)) nonCarrierHits++;
      }
    }
    if (hits === reqSig.length) {
      return { matched: true, status: 'matched', boost: 2.5 };
    }
    if (nonCarrierHits > 0) {
      const ratio = hits / reqSig.length;
      if (ratio > bestNonCarrierRatio) bestNonCarrierRatio = ratio;
    }
  }

  if (bestNonCarrierRatio >= 0.5) {
    return { matched: false, status: 'expanded', boost: 1.25 };
  }

  if (useAliases && altFormes.length > 0) {
    const presClauses = normPresText ? splitGalenicClauses(normPresText) : [];
    const altMatchForme = altFormes.some((alt) => matchesGalenicPhrase(candClauses, alt));
    const altMatchPres = !altMatchForme && presClauses.length > 0 && altFormes.some((alt) => matchesGalenicPhrase(presClauses, alt));
    if (altMatchForme) {
      return { matched: false, status: 'expanded', boost: 1.5 };
    }
    if (altMatchPres) {
      return { matched: false, status: 'expanded', boost: 0.75 };
    }
  }

  return { matched: false, status: 'contradicted', boost: -1.5 };
}

function canonicalizeVoieEntry(raw) {
  const norm = normalizeSearchText(raw)
    .replace(/['’]/g, ' ')
    .replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!norm) return '';
  return VOIE_CANONICAL_ALIASES.get(norm) || norm;
}

function extractVoieEntries(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  const entries = [];
  for (const part of text.split(/[;,]+/)) {
    const canon = canonicalizeVoieEntry(part);
    if (canon && !entries.includes(canon)) entries.push(canon);
  }
  return entries;
}

/**
 * Évalue la satisfaction d'une voie d'administration sur la liste multivaluée
 * canonique du candidat (`cutanee` != `sous-cutanee`, `orale` != `intratumorale`,
 * `orale` dans `cutanee;orale;sublinguale` -> `matched`).
 */
function matchVoieCriterion(requestedVoies, candidateNormVoie, candidateNormForme, { useAliases = false } = {}) {
  if (requestedVoies.length === 0) {
    return { matched: false, status: 'unknown', boost: 0 };
  }
  const candEntries = new Set(extractVoieEntries(candidateNormVoie));
  const formeClauses = candidateNormForme ? splitGalenicClauses(candidateNormForme) : [];

  if (candEntries.size > 0) {
    let hits = 0;
    for (const req of requestedVoies) {
      if (candEntries.has(req)) hits++;
    }
    if (hits === requestedVoies.length) {
      return { matched: true, status: 'matched', boost: 1.5 };
    }
    if (hits > 0) {
      return { matched: false, status: 'expanded', boost: 0.75 };
    }
    if (
      useAliases &&
      requestedVoies.includes('ophtalmique') &&
      matchesGalenicPhrase(formeClauses, 'collyre')
    ) {
      return { matched: false, status: 'expanded', boost: 1.0 };
    }
    return { matched: false, status: 'contradicted', boost: -1.5 };
  }

  if (
    useAliases &&
    requestedVoies.includes('ophtalmique') &&
    matchesGalenicPhrase(formeClauses, 'collyre')
  ) {
    return { matched: false, status: 'expanded', boost: 1.0 };
  }
  if (
    useAliases &&
    requestedVoies.includes('auriculaire') &&
    matchesGalenicPhrase(formeClauses, 'auriculaire')
  ) {
    return { matched: false, status: 'expanded', boost: 1.0 };
  }
  return { matched: false, status: 'unknown', boost: 0 };
}

function evaluateEntityCriteria(record, parsed, { useAliases = false } = {}) {
  const eff = (parsed && parsed.effectiveCriteria) || {};
  const cm = { dosage: false, forme: false, voie: false };
  const cs = { dosage: 'not_requested', forme: 'not_requested', voie: 'not_requested' };
  let boost = 0;
  let dosageExtra = null;

  const formeOverridden =
    Boolean(parsed?.explicitOverrides?.forme) ||
    Boolean(parsed?.conflicts?.some((c) => c.field === 'forme'));
  const altFormes = !formeOverridden && Array.isArray(eff.altFormeTokens)
    ? eff.altFormeTokens
    : [];

  // 1. Dosage (dénomination prioritaire ; composition uniquement si dénomination muette)
  if (eff.dosage) {
    if (inspectCriterionConstraint(eff.dosage)) {
      cs.dosage = 'unsupported';
    } else {
      const requested = parseDosageTokens(eff.dosage);
      if (requested.length === 0) {
        cs.dosage = 'unsupported';
      } else if (!record) {
        cs.dosage = 'unknown';
      } else {
        const denomTokens = record.denomDosages || [];
        const compoTokens = record.compoDosages || [];
        if (denomTokens.length > 0) {
          const { matched, extra } = matchDosageTokens(requested, denomTokens);
          cm.dosage = matched === requested.length;
          cs.dosage = cm.dosage ? 'matched' : 'contradicted';
          if (matched > 0) {
            boost += (3 * matched) / requested.length;
            dosageExtra = extra;
          } else {
            boost -= 2.5; // contredit explicitement
          }
        } else if (compoTokens.length > 0) {
          const { matched, extra } = matchDosageTokens(requested, compoTokens);
          cm.dosage = matched === requested.length;
          cs.dosage = cm.dosage ? 'matched' : 'contradicted';
          if (matched > 0) {
            boost += (2 * matched) / requested.length;
            dosageExtra = extra;
          } else {
            boost -= 2.0;
          }
        } else {
          cs.dosage = 'unknown';
        }
      }
    }
  }

  // 2. Forme galénique (correspondance canonique par tokens/clauses != élargissement du rappel)
  if (eff.forme) {
    if (inspectCriterionConstraint(eff.forme)) {
      cs.forme = 'unsupported';
    } else if (!record || !record.normForme) {
      cs.forme = 'unknown';
    } else {
      const res = matchFormeCriterion(eff.forme, record.normForme, {
        useAliases,
        altFormes,
        normPresText: record.normPresText || ''
      });
      cm.forme = res.matched;
      cs.forme = res.status;
      boost += res.boost;
    }
  }

  // 3. Voie d'administration (entrées multivaluées exactes + aliases directionnels contrôlés)
  if (eff.voie) {
    if (inspectCriterionConstraint(eff.voie)) {
      cs.voie = 'unsupported';
    } else if (!record) {
      cs.voie = 'unknown';
    } else {
      const requestedVoies =
        !parsed?.explicitOverrides?.voie &&
        Array.isArray(parsed?.extracted?.voies) &&
        parsed.extracted.voies.length > 0
          ? [...new Set(parsed.extracted.voies.map(canonicalizeVoieEntry).filter(Boolean))]
          : extractVoieEntries(eff.voie);
      const res = matchVoieCriterion(
        requestedVoies,
        record.normVoie || '',
        record.normForme || '',
        { useAliases }
      );
      cm.voie = res.matched;
      cs.voie = res.status;
      boost += res.boost;
    }
  }

  // 4. Qualificatifs galéniques (effervescent, lp, orodispersible, pelliculé, à croquer)
  if (useAliases && eff.qualifiers && eff.qualifiers.length > 0 && record) {
    const qualClauses = splitGalenicClauses(`${record.normDenom || record.normNom || ''} ; ${record.normForme || ''}`);
    let matchedQual = 0;
    for (const q of eff.qualifiers) {
      if (
        matchesGalenicPhrase(qualClauses, q) ||
        (q === 'orodispersible' && matchesGalenicPhrase(qualClauses, 'lyophilisat'))
      ) {
        matchedQual++;
        boost += 1.5;
      }
    }
    if (matchedQual === 0) boost -= 1.0;
  }

  // 5. Espèces animales (ANMV)
  let speciesMatched = false;
  if (eff.species && eff.species.length > 0 && record) {
    if (record.speciesTokens && record.speciesTokens.size > 0) {
      speciesMatched = eff.species.every((sp) => record.speciesTokens.has(sp));
      if (speciesMatched) {
        cm.species = true;
        cs.species = 'matched';
        boost += 3.5;
      } else {
        cs.species = 'contradicted';
        boost -= 3.0;
      }
    } else {
      // Médicament humain sur une requête avec espèce animale explicite
      cs.species = 'contradicted';
      boost -= 3.0;
    }
  }

  return { boost, criteria_match: cm, criteria_status: cs, dosage_extra: dosageExtra, speciesMatched };
}

function buildEntitySignals(ref, record, meta, parsed, { mode, store }) {
  const { boost, criteria_match, criteria_status, dosage_extra, speciesMatched } = evaluateEntityCriteria(
    record,
    parsed,
    { useAliases: mode === 'concepts' }
  );

  let conceptBonus = 0;
  if (mode === 'concepts' && record) {
    const nameTokens = parsed.nameTokens || [];
    const substantiveTokens = nameTokens.filter((t) => t.length >= 3 && !SALT_WORDS.has(t));

    // Préférer mono-substance sur requête mono-molécule sans dosage d'association
    const singleRequested = substantiveTokens.length === 1 &&
      !(parsed.effectiveCriteria.dosage && parsed.effectiveCriteria.dosage.includes('/'));
    if (singleRequested && record.distinctActiveCount === 1) {
      conceptBonus += 1.2;
    } else if (singleRequested && record.distinctActiveCount > 1) {
      conceptBonus -= 0.4;
    }

    // Sur requête générique, mettre en avant les génériques ('generic') avant princeps ('0')
    if (parsed.extracted.intents.includes('generic_equivalent')) {
      if (record.genericRole === 'generic') conceptBonus += 1.5;
      else if (record.genericRole === 'princeps') conceptBonus -= 0.3;
    }

    if (meta && meta.allSubstancesMatched) {
      conceptBonus += 1.0;
    }

    // Tie-breaker doux sur statut de commercialisation actif
    const active = ref.source === 'bdpm' ? record.isCommercialised : record.isActive;
    if (active) conceptBonus += 0.25;
  }

  const viaRank = VIA_BONUS[ref.match_via] || 0;
  return {
    ...ref,
    criteria_match,
    criteria_status,
    _score: boost + conceptBonus,
    _dosageExtra: dosage_extra,
    _speciesMatched: speciesMatched,
    _viaRank: viaRank,
    _activePriority: record ? (ref.source === 'bdpm' ? (record.isCommercialised ? 1 : 0) : (record.isActive ? 1 : 0)) : 0
  };
}

function compareExperimentalRefs(a, b) {
  const qA = MATCH_QUALITY_RANK[a.match_quality] || 0;
  const qB = MATCH_QUALITY_RANK[b.match_quality] || 0;
  if (qB !== qA) return qB - qA;
  if (b._score !== a._score) return b._score - a._score;
  const exA = a._dosageExtra ?? Infinity;
  const exB = b._dosageExtra ?? Infinity;
  if (exA !== exB) return exA < exB ? -1 : 1;
  if (b._viaRank !== a._viaRank) return b._viaRank - a._viaRank;
  if (b._activePriority !== a._activePriority) return b._activePriority - a._activePriority;
  return a.label.localeCompare(b.label, 'fr');
}

function buildRefsFromMatches(matches, source, labelFn, metaFn) {
  return Object.keys(matches.qualityByKey).map((key) => ({
    source,
    key,
    match_quality: matches.qualityByKey[key],
    match_via: (matches.metaByKey[key] && matches.metaByKey[key].via) || metaFn,
    label: labelFn(key)
  }));
}

function runBdpmStage(parsed, { mode, store }) {
  if (parsed.kind === 'exact_code') {
    const lexical = collectBdpmMatches(parsed.raw);
    if (mode === 'concepts' && parsed.code.kind === 'atc_code') {
      return mergeMatchMaps(lexical, collectBdpmConceptMatches(parsed, store));
    }
    return lexical;
  }

  const queryText = parsed.nameQuery || parsed.raw;
  let matches = collectBdpmMatches(queryText);

  if (mode === 'concepts') {
    const conceptMatches = collectBdpmConceptMatches(parsed, store);
    matches = mergeMatchMaps(matches, conceptMatches);
    const expanded = expandGenericGroupMatches(parsed, matches, store);
    if (expanded) matches = expanded;
  }
  return matches;
}

function runVetStage(parsed, { mode, store }) {
  if (parsed.kind === 'exact_code') {
    const lexical = collectLegacyVetMatches(parsed.raw);
    if (mode === 'concepts' && parsed.code.kind === 'atc_code') {
      return mergeMatchMaps(lexical, collectVetConceptMatches(parsed, store));
    }
    return lexical;
  }

  const queryText = parsed.nameQuery || parsed.raw;
  let matches = collectLegacyVetMatches(queryText);
  if (mode === 'concepts') {
    matches = mergeMatchMaps(matches, collectVetConceptMatches(parsed, store));
  }
  return matches;
}

/**
 * Point d'entrée paginé expérimental (B1/B2). Respecte les invariants :
 * - source = auto | human | veterinary | mixed
 * - dédoublonnage strict par CIS/num avant pagination
 * - aucun filtrage destructif sur dosage/forme/voie
 * - précédence stricte des paramètres explicites + conflits exposés en métadonnées
 */
function executeExperimentalSearchPage(
  q,
  source,
  page = 1,
  limit = 50,
  explicitCriteria = {},
  { mode = 'concepts' } = {}
) {
  if (!VALID_EXPERIMENTAL_MODES.has(mode)) {
    throw new Error(`Mode de recherche expérimental inconnu : ${mode}`);
  }

  const sourceMode = normalizeSource(source);
  const taxonomy = getTaxonomyVocab();
  const parsed = parseStructuredQuery(q, explicitCriteria, taxonomy, {
    useAliases: mode === 'concepts'
  });
  const safety = analyzeQuerySafetyAndIntent(q, parsed, explicitCriteria);

  const buildParsedMeta = () => ({
    kind: parsed.kind,
    name_query: parsed.nameQuery,
    dosage: parsed.effectiveCriteria.dosage,
    forme: parsed.effectiveCriteria.forme,
    voie: parsed.effectiveCriteria.voie,
    species: parsed.extracted.species,
    qualifiers: parsed.extracted.qualifiers,
    intents: parsed.extracted.intents,
    conflicts: parsed.conflicts,
    patient_weight: safety.patientWeight,
    pediatric_inferred: safety.pediatricInferred,
    verbatim_qualifiers: safety.verbatimQualifiers,
    unsupported_criteria: safety.unsupportedCriteria
  });

  if (!safety.supported) {
    return {
      total: 0,
      results: [],
      search: {
        query: q,
        mode,
        source: sourceMode,
        referentiels: { queried: [], with_results: [] },
        abstained: true,
        abstain_reason: safety.abstainReason,
        parsed: buildParsedMeta(),
        safety: {
          supported: false,
          intent: safety.intent,
          negation: safety.negation,
          clinical_property: safety.clinicalProperty,
          unsupported_criteria: safety.unsupportedCriteria
        }
      }
    };
  }

  const needsConceptStore =
    mode === 'concepts' &&
    !(parsed.kind === 'exact_code' && parsed.code && parsed.code.kind === 'numeric_code');
  const store = needsConceptStore ? getConceptStore() : null;

  const queried = [];
  const withResults = [];
  const matchesBySource = {};
  let bdpmRefs = [];
  let vetRefs = [];

  const speciesHintVet = mode === 'concepts' && sourceMode === 'auto' && parsed.extracted.species.length > 0;

  // 1. Cas espèce explicite en mode auto : interroger ANMV en priorité
  if (speciesHintVet) {
    queried.push('anmv');
    matchesBySource.vet = runVetStage(parsed, { mode, store });
    vetRefs = buildRefsFromMatches(matchesBySource.vet, 'vet', getMedicamentLabelByNum, 'denomination');
    if (vetRefs.length > 0) withResults.push('anmv');
  }

  const needBdpm = sourceMode === 'human' || sourceMode === 'mixed' ||
    (sourceMode === 'auto' && vetRefs.length === 0);

  if (needBdpm) {
    queried.push('bdpm');
    matchesBySource.bdpm = runBdpmStage(parsed, { mode, store });
    bdpmRefs = buildRefsFromMatches(matchesBySource.bdpm, 'bdpm', getSpecialiteLabelByCis, 'denomination');
    if (bdpmRefs.length > 0) withResults.push('bdpm');
  }

  const bdpmStrong = bdpmRefs.some((r) => isStrongMatchQuality(r.match_quality));
  const needVet = !speciesHintVet && (
    sourceMode === 'veterinary' ||
    sourceMode === 'mixed' ||
    (sourceMode === 'auto' && !bdpmStrong)
  );

  if (needVet) {
    queried.push('anmv');
    matchesBySource.vet = runVetStage(parsed, { mode, store });
    vetRefs = buildRefsFromMatches(matchesBySource.vet, 'vet', getMedicamentLabelByNum, 'denomination');
    if (vetRefs.length > 0) withResults.push('anmv');
  }

  const vetStrong = vetRefs.some((r) => isStrongMatchQuality(r.match_quality));
  let rawRefs;
  if (sourceMode === 'human') rawRefs = bdpmRefs;
  else if (sourceMode === 'veterinary') rawRefs = vetRefs;
  else if (sourceMode === 'mixed') rawRefs = [...bdpmRefs, ...vetRefs];
  else if (speciesHintVet && vetRefs.length > 0) rawRefs = vetRefs;
  else if (bdpmStrong) rawRefs = bdpmRefs;
  else if (vetStrong || bdpmRefs.length === 0) rawRefs = vetRefs;
  else rawRefs = vetRefs.length > 0 ? [...bdpmRefs, ...vetRefs] : bdpmRefs;

  // Dédoublonnage strict (par source + clé) et scoring tri-état
  const dedup = new Map();
  for (const ref of rawRefs) {
    const dk = `${ref.source}:${ref.key}`;
    const existing = dedup.get(dk);
    if (!existing || MATCH_QUALITY_RANK[ref.match_quality] > MATCH_QUALITY_RANK[existing.match_quality]) {
      dedup.set(dk, ref);
    }
  }

  const scored = [];
  for (const ref of dedup.values()) {
    const record = store
      ? (ref.source === 'bdpm' ? store.bdpmByCis.get(ref.key) : store.vetByNum.get(ref.key))
      : buildStructuredEntityRecord(ref.source, ref.key, parsed);
    const meta = matchesBySource[ref.source] && matchesBySource[ref.source].metaByKey[ref.key];
    scored.push(buildEntitySignals(ref, record, meta, parsed, { mode, store }));
  }

  scored.sort(compareExperimentalRefs);

  const { offset, safeLimit } = parseListPaging(page, limit);
  const pageRefs = scored.slice(offset, offset + safeLimit);
  const results = pageRefs.map((ref) => hydrateExperimentalHit(ref, matchesBySource));

  const searchMeta = {
    query: q,
    mode,
    source: sourceMode,
    referentiels: { queried, with_results: withResults },
    abstained: false,
    parsed: buildParsedMeta(),
    safety: {
      supported: true,
      intent: safety.intent,
      negation: safety.negation,
      clinical_property: safety.clinicalProperty,
      unsupported_criteria: safety.unsupportedCriteria
    }
  };

  return {
    total: scored.length,
    results,
    search: searchMeta
  };
}

module.exports = {
  VALID_EXPERIMENTAL_MODES,
  executeExperimentalSearchPage,
  evaluateEntityCriteria
};
