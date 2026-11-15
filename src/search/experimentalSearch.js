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
  getMedicamentByNum,
  getMedicamentLabelByNum,
  getRelatedByNum
} = require('../services/vetDataLoader');
const {
  collectBdpmMatches,
  collectVeterinaryMatches,
  normalizeSource
} = require('../services/searchOrchestrator');
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
const {
  tokenizeGalenicText,
  significantTokens,
  significantFormeTokens,
  canonicalizeVoieEntry,
  extractVoieEntries
} = require('./galenicVocab');
const { analyzeQuerySafetyAndIntent, inspectCriterionConstraint } = require('./queryIntentGuard');
const {
  SALT_WORDS,
  extractTokens,
  extractConceptTokens,
  canonicalizeSpeciesWord,
  buildIngredientGroups,
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

// La requête interprétée est immuable : ses mots ne sont découpés qu'une fois par
// requête, pas à chaque candidat scoré.
// Choix assumé (revue PR #8) : cache indexé sur l'objet `parsed` plutôt que des valeurs
// passées en paramètre. L'alternative explicite — calculer ces valeurs une fois dans
// `executeExperimentalSearchPage` et les transmettre jusqu'au scoring — changerait la
// signature de `matchFormeCriterion` / `evaluateEntityCriteria` (exportées, appelées
// directement par les tests) et de `buildEntitySignals` ; à faire dans un refactoring
// dédié si ces fonctions évoluent. La `WeakMap` ne retient rien au-delà de la requête.
const conceptQueryTokensCache = new WeakMap();

// Seule unité d'une lettre que le parseur laisse dans le nom (non interprétée comme dosage) :
// `h` (`24 h`). `g` et `l` sont extraits comme dosages ; `400 f` garde son `f`.
const UNIT_LETTER_RE = /\d\s*(h)(?![\p{L}\d])/gu;

/**
 * Mots de la requête pour l'étape concepts, découpés par la même fonction que
 * l'index (`extractConceptTokens`) : `paracetamol-codeine` -> `paracetamol`, `codeine`
 * comme `PARACETAMOL-CODEINE` à l'indexation ; les lettres isolées sont indexées et
 * donc exigées comme les autres mots (`octaplex facteur x` couvert par la composition
 * « FACTEUR X »). Seule exception : une unité laissée dans le nom (`24 h`). L'article
 * « l » isolé n'arrive pas jusqu'ici, le parseur le retire comme mot vide.
 */
function conceptQueryTokens(parsed) {
  let tokens = conceptQueryTokensCache.get(parsed);
  if (!tokens) {
    const nameQuery = normalizeSearchText(parsed.nameQuery || '');
    const unitLetters = new Set();
    for (const m of nameQuery.matchAll(UNIT_LETTER_RE)) unitLetters.add(m[1]);
    tokens = [...new Set(extractConceptTokens(nameQuery))].filter((t) => !unitLetters.has(t));
    conceptQueryTokensCache.set(parsed, tokens);
  }
  return tokens;
}

// Lettres isolées pouvant désigner une substance (vitamines A, B, C, D, E, K… : lettres
// indexées avant l'indexation de toutes les lettres). Les autres lettres isolées sont des
// tailles, abréviations ou codes (`chien s`, `l.p`, `400-f`) et ne comptent pas comme
// substance demandée, sinon `fipronil s` perdrait la préférence mono-substance.
const SUBSTANCE_LETTER_RE = /^[abcegkvd]$/;

function countRequestedSubstanceEntities(tokens) {
  const nonSalt = tokens.filter((t) =>
    !/^\d+$/.test(t) && !SALT_WORDS.has(t) && (t.length > 1 || SUBSTANCE_LETTER_RE.test(t))
  );
  if (nonSalt.length <= 1) return nonSalt.length;
  let count = 0;
  for (let i = 0; i < nonSalt.length; i++) {
    const t = nonSalt[i];
    if (t === 'acide' || t === 'acides' || t === 'vitamine' || t === 'vitamines') {
      continue;
    }
    count++;
  }
  return Math.max(1, count);
}

/**
 * Recherche BDPM par entités via ConceptStore (résout les multi-substances
 * sur lignes CIS_COMPO distinctes, SA<->FT, et fallback dénomination).
 */
function collectBdpmConceptMatches(parsed, store) {
  const qualityByKey = {};
  const metaByKey = {};
  const queryToks = conceptQueryTokens(parsed);
  if (queryToks.length === 0) return { qualityByKey, metaByKey };

  // Codes ATC exacts via MITM
  if (parsed.kind === 'exact_code' && parsed.code && parsed.code.kind === 'atc_code') {
    const list = store.bdpmAtcToCis.get(parsed.code.code) || [];
    for (const cis of list) {
      qualityByKey[cis] = 'exact';
      metaByKey[cis] = { quality: 'exact', via: 'atc', coveredTokens: 1, totalTokens: 1 };
    }
    return { qualityByKey, metaByKey };
  }

  const requestedSubstanceCount = countRequestedSubstanceEntities(queryToks);

  // Compter pour chaque CIS combien de tokens de la requête trouvent un appui
  // (dénomination OU substance active / fraction thérapeutique)
  const hitCountByCis = new Map();
  const denomHitByCis = new Map();

  for (const tok of queryToks) {
    const cisVisitedThisToken = new Set();

    const denomHits = store.bdpmDenomTokenToCis.get(tok) || [];
    for (let i = 0; i < denomHits.length; i++) {
      const cis = denomHits[i];
      if (!cisVisitedThisToken.has(cis)) {
        denomHitByCis.set(cis, (denomHitByCis.get(cis) || 0) + 1);
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

  // Exiger couverture complète de tous les tokens distinctifs (y compris codes courts B1/B6/D3/9/5/40)
  const requiredHits = queryToks.length;
  const normQuery = normalizeSearchText(parsed.nameQuery);
  const classifier = createMatchPriorityClassifier(normQuery);

  for (const [cis, count] of hitCountByCis.entries()) {
    if (count < requiredHits) continue;
    const rec = store.bdpmByCis.get(cis);
    if (!rec) continue;

    const denomHits = denomHitByCis.get(cis) || 0;
    const allInDenom = denomHits >= requiredHits || denominationCoversTokens(rec, queryToks);
    const cls = classifier(rec.denomination, { idValue: cis });
    const quality = cls === 2 ? 'exact' : 'prefix';

    const via = allInDenom ? 'denomination' : 'composition';
    qualityByKey[cis] = quality;
    metaByKey[cis] = {
      quality,
      via,
      coveredTokens: count,
      totalTokens: requiredHits,
      allSubstancesMatched:
        requestedSubstanceCount >= 2 &&
        rec.distinctActiveCount >= 2 &&
        rec.distinctActiveCount <= requestedSubstanceCount
    };
  }

  return { qualityByKey, metaByKey };
}

const GENERIC_DENOMINATION_HEADS = new Set([
  'acide', 'acides', 'vitamine', 'vitamines', 'association', 'solution', 'serum', 'vaccin',
  ...SALT_WORDS
]);

function denominationCoversTokens(rec, queryToks) {
  if (!rec || !rec.denomination || queryToks.length === 0) return false;
  const dToks = extractConceptTokens(rec.denomination);
  return queryToks.every((qt) => dToks.some((dt) => dt === qt || (qt.length >= 4 && dt.startsWith(qt))));
}

/**
 * Résout l'intention explicite « générique de X » / « équivalent X » via CIS_GENER.
 */
function expandGenericGroupMatches(parsed, baseMatches, store) {
  if (!parsed.extracted.intents.includes('generic_equivalent')) return null;

  // Seules les spécialités dont la dénomination porte le nom demandé amorcent l'expansion :
  // une association trouvée via sa composition ou ses présentations (« RHINOFEBRAL » pour
  // « vitamine c ») n'est pas le produit visé. Les ancres fortes (exact/prefix) priment ;
  // à défaut, une ancre approchée (fuzzy) sur la dénomination n'est retenue que pour un
  // nom d'un seul mot (faute de frappe sur une marque : « oflocat »), jamais pour une
  // expression où un mot approché importerait un produit sans rapport (« vitamine » ≈ « viramune »).
  const queryToks = conceptQueryTokens(parsed);
  const keys = Object.keys(baseMatches.qualityByKey);
  const strongAnchors = keys.filter((cis) =>
    isStrongMatchQuality(baseMatches.qualityByKey[cis]) &&
    denominationCoversTokens(store.bdpmByCis.get(cis), queryToks)
  );
  const anchorKeys = strongAnchors.length > 0 || queryToks.length !== 1
    ? strongAnchors
    : keys.filter((cis) => baseMatches.metaByKey[cis] && baseMatches.metaByKey[cis].via === 'denomination');
  const groupIds = new Set();
  const requestedNameTokens = new Set(queryToks);

  for (const cis of anchorKeys) {
    const rec = store.bdpmByCis.get(cis);
    if (!rec) continue;
    for (const gid of rec.genericGroupIds) groupIds.add(gid);
  }

  // Fallback si l'ancre exacte n'était pas directement dans CIS_GENER mais partage brandRoot.
  // Le premier mot n'est une marque que s'il a été saisi et n'est pas un mot de tête
  // générique de dénomination (« acide », « vitamine », sels...).
  if (groupIds.size === 0) {
    for (const cis of anchorKeys) {
      const rec = store.bdpmByCis.get(cis);
      if (!rec || !rec.brandRoot) continue;
      if (!requestedNameTokens.has(rec.brandRoot) || GENERIC_DENOMINATION_HEADS.has(rec.brandRoot)) continue;
      const gSet = store.brandRootToGroupIds.get(rec.brandRoot);
      if (gSet) {
        for (const gid of gSet) groupIds.add(gid);
      }
    }
  }

  // Dernier repli, seulement sans aucune ancre de dénomination (marque absente du
  // référentiel chargé) : chercher le nom dans libelle_groupe, par mots entiers.
  // Avec des ancres, ce repli ramènerait les associations citant la substance.
  // Tous les mots demandés doivent figurer dans le libellé (`pour-on` exige `pour` ET `on`),
  // dont au moins un mot alphabétique significatif : un nombre seul (`200`) n'identifie
  // pas un groupe.
  if (groupIds.size === 0 && anchorKeys.length === 0 && queryToks.length > 0) {
    const core = queryToks.filter((t) => t.length >= 2);
    if (core.some((t) => t.length >= 3 && /\p{L}/u.test(t))) {
      for (const [gid, grp] of store.generiquesByGroup.entries()) {
        if (core.every((t) => grp.libelleTokens.has(t))) {
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
      if (!store.bdpmByCis.has(cis)) continue; // CIS du groupe absent du référentiel chargé
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

  const queryToks = conceptQueryTokens(parsed);
  if (queryToks.length === 0) return { qualityByKey, metaByKey };

  const hitCountByNum = new Map();
  const nomHitByNum = new Map();

  for (const tok of queryToks) {
    const visited = new Set();
    for (const num of store.vetNomTokenToNum.get(tok) || []) {
      if (!visited.has(num)) {
        nomHitByNum.set(num, (nomHitByNum.get(num) || 0) + 1);
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
      via: allInNom ? 'denomination' : 'composition',
      coveredTokens: count,
      totalTokens: reqHits
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
    } else if (metaByKey[k]) {
      metaByKey[k] = {
        ...metaByKey[k],
        ...(secMeta.coveredTokens ? { coveredTokens: secMeta.coveredTokens, totalTokens: secMeta.totalTokens } : {}),
        ...(prevQ === q && secMeta.allSubstancesMatched ? { allSubstancesMatched: true } : {}),
        ...(prevQ === q && secMeta.genericExpanded ? { genericExpanded: true } : {})
      };
    }
  }
  return { qualityByKey, metaByKey };
}

function buildVetSpeciesTokens(med) {
  const speciesTokens = new Set();
  for (const esp of (med && med.especes) || []) {
    const canonical = canonicalizeSpeciesWord(esp);
    if (canonical) speciesTokens.add(canonical);
    for (const w of extractTokens(esp, 3)) {
      speciesTokens.add(canonicalizeSpeciesWord(w));
    }
  }
  return speciesTokens;
}

/** Le médicament vétérinaire est-il autorisé pour toutes les espèces demandées ? */
function vetRefTargetsSpecies(num, species, store) {
  const tokens = store
    ? (store.vetByNum.get(num) || {}).speciesTokens
    : buildVetSpeciesTokens(getMedicamentByNum(num));
  return Boolean(tokens) && species.every((sp) => tokens.has(sp));
}

function buildStructuredEntityRecord(source, key, parsed, { mode = 'structured' } = {}) {
  const needCompoDosage = Boolean(parsed?.effectiveCriteria?.dosage);
  // Les volumes de présentation ne servent qu'à la conversion de concentration (alias B2)
  const needPresVolumes = needCompoDosage && mode === 'concepts';
  const needSpecies = Boolean(parsed?.effectiveCriteria?.species?.length);

  if (source === 'bdpm') {
    const spec = getSpecialiteByCis(key);
    if (!spec) return null;
    const denom = spec.denomination || '';
    const denomDosages = parseDosageTokens(denom);
    let compoDosages = [];
    let compoConcentrationBasis = 'unknown';
    let compoConcMgMl = null;
    let distinctActiveCount = 1;
    let presVolumesMl = [];
    if (needCompoDosage) {
      const comps = getRelatedByCis('compositions', key, 50) || [];
      const grp = buildIngredientGroups(comps);
      if (denomDosages.length === 0) compoDosages = grp.compoDosages;
      compoConcentrationBasis = grp.compoConcentrationBasis;
      compoConcMgMl = grp.compoConcMgMl;
      distinctActiveCount = grp.distinctActiveCount;
    }
    if (needPresVolumes) {
      const pres = getRelatedByCis('presentations', key, 50) || [];
      const presText = pres.map((p) => p.libelle || '').join(' ');
      if (presText) {
        presVolumesMl = parseDosageTokens(presText).filter((t) => t.unit === 'ml').map((t) => t.amount);
      }
    }
    return {
      cis: key,
      denomination: denom,
      normDenom: normalizeSearchText(denom),
      denomDosages,
      compoDosages,
      compoConcentrationBasis,
      compoConcMgMl,
      presVolumesMl,
      distinctActiveCount,
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
  let distinctActiveCount = 1;
  let presVolumesMl = [];
  if (needCompoDosage) {
    const comps = getRelatedByNum('compositions', key) || [];
    distinctActiveCount = Math.max(1, comps.length);
    if (denomDosages.length === 0) {
      for (let i = 0; i < comps.length; i++) {
        const c = comps[i];
        if (c.quantite != null && c.quantite !== '' && c.unite) {
          for (const p of parseDosageTokens(`${c.quantite} ${c.unite}`)) compoDosages.push(p);
        }
      }
    }
  }
  if (needPresVolumes) {
    const pres = getRelatedByNum('presentations', key) || [];
    const presText = pres.map((p) => p.libelle || '').join(' ');
    if (presText) {
      presVolumesMl = parseDosageTokens(presText).filter((t) => t.unit === 'ml').map((t) => t.amount);
    }
  }
  const speciesTokens = needSpecies ? buildVetSpeciesTokens(med) : new Set();
  return {
    num: key,
    nom,
    normNom: normalizeSearchText(nom),
    normDenom: normalizeSearchText(nom),
    denomDosages,
    compoDosages,
    compoConcentrationBasis: 'unknown',
    compoConcMgMl: null,
    presVolumesMl,
    distinctActiveCount,
    normForme: normalizeSearchText(med.forme_pharmaceutique),
    normVoie: '',
    normPresText: '',
    speciesTokens
  };
}

const GENERIC_GALENIC_CARRIERS = new Set([
  'solution', 'poudre', 'suspension', 'dispersion', 'emulsion', 'preparation', 'liquide', 'solvant'
]);
function splitGalenicClauses(value) {
  const norm = normalizeSearchText(value)
    .replace(/([a-z0-9])\((?:e|es|s)\)/g, '$1');
  if (!norm) return [];
  const parts = norm.split(/\s*;\s*|\s+\bet\b\s+/);
  const clauses = [];
  for (const part of parts) {
    const allTokens = tokenizeGalenicText(part);
    if (allTokens.length === 0) continue;
    const sigTokens = significantTokens(allTokens);
    clauses.push({
      allTokens,
      tokenSet: new Set(allTokens),
      sigTokens,
      sigSet: new Set(sigTokens)
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

const NEUTRAL_FORME_ADMIN_TOKENS = new Set([
  'application', 'administration', 'usage', 'voie', 'locale', 'local', 'externe'
]);

// La forme demandée est identique pour tous les candidats d'une requête :
// mémoïser sa tokenisation évite de la refaire à chaque candidat scoré.
// Cache à une entrée, partagé au niveau du module : correct car la signature ne dépend
// que de la chaîne demandée (une autre chaîne invalide l'entrée). Même alternative et
// même raison de la différer que pour `conceptQueryTokensCache` ci-dessus.
let lastRequestedForme = null;
let lastRequestedFormeSignature = null;

function requestedFormeSignature(requestedForme) {
  if (requestedForme !== lastRequestedForme) {
    const reqSig = significantFormeTokens(requestedForme);
    lastRequestedForme = requestedForme;
    lastRequestedFormeSignature = { reqSig, reqSigSet: new Set(reqSig) };
  }
  return lastRequestedFormeSignature;
}

/**
 * Évalue la satisfaction métier d'une forme galénique sur des tokens/expressions
 * complets (jamais par simple sous-chaîne : `gel` != `gelule`, `comprime` != `compresse`).
 * L'assistance par la voie utilise exclusivement les voies canoniques complètes du
 * candidat (`sous-cutanée` != `cutanée`) et n'efface jamais un qualificatif de forme
 * contradictoire (`solution injectable` + `sous-cutanée` != `solution cutanée`).
 */
function matchFormeCriterion(requestedForme, candidateNormForme, { useAliases = false, altFormes = [], normPresText = '', normVoie = '' } = {}) {
  const candClauses = splitGalenicClauses(candidateNormForme);
  if (candClauses.length === 0) {
    return { matched: false, status: 'unknown', boost: 0 };
  }

  const { reqSig, reqSigSet } = requestedFormeSignature(requestedForme);
  if (reqSig.length === 0) {
    return { matched: false, status: 'unknown', boost: 0 };
  }

  const candVoieEntries = new Set(extractVoieEntries(normVoie));
  let bestNonCarrierRatio = 0;

  for (const clause of candClauses) {
    let hits = 0;
    let nonCarrierHits = 0;
    const unmatchedReqTokens = [];

    for (const tok of reqSig) {
      if (clause.sigSet.has(tok) || clause.tokenSet.has(tok)) {
        hits++;
        if (!GENERIC_GALENIC_CARRIERS.has(tok)) nonCarrierHits++;
      } else {
        unmatchedReqTokens.push(tok);
      }
    }

    if (hits === reqSig.length) {
      return { matched: true, status: 'matched', boost: 2.5 };
    }

    if (hits > 0 && unmatchedReqTokens.length > 0 && candVoieEntries.size > 0) {
      const hasConflictingFormeQualifier = clause.sigTokens.some(
        (t) => !reqSigSet.has(t) && !NEUTRAL_FORME_ADMIN_TOKENS.has(t)
      );
      const missingRoutePhrase = canonicalizeVoieEntry(unmatchedReqTokens.join(' '));
      if (
        !hasConflictingFormeQualifier &&
        missingRoutePhrase &&
        candVoieEntries.has(missingRoutePhrase)
      ) {
        return { matched: true, status: 'matched', boost: 2.5 };
      }
    }

    // Un recouvrement partiel n'est une expansion que si le candidat est seulement
    // moins spécifique : un qualificatif demandé absent (`effervescent`) face à un
    // qualificatif propre au candidat (`pellicule`) est une contradiction.
    const missesQualifier = unmatchedReqTokens.some((t) => !GENERIC_GALENIC_CARRIERS.has(t));
    const hasOwnQualifier = clause.sigTokens.some(
      (t) => !reqSigSet.has(t) && !GENERIC_GALENIC_CARRIERS.has(t) && !NEUTRAL_FORME_ADMIN_TOKENS.has(t)
    );
    if (nonCarrierHits > 0 && !(missesQualifier && hasOwnQualifier)) {
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

// Tolérance numérique strictement limitée à l'arrondi virgule flottante IEEE-754
// (jamais une tolérance pharmacologique implicite de 2 %).
const ROUNDING_TOLERANCE_RATIO = 1e-6;

const NON_COMPARABLE_DOSAGE_RATIO_RE =
  /\b\d+(?:[.,]\d+)?\s*(?:mg|g|grammes?|ug|µg|μg|mcg|microgrammes?|ui|iu|u|unites?|ml|l)\s*\/\s*(?:\d+(?:[.,]\d+)?\s*)?(?:kg|mg|ug|µg|μg|mcg|microgrammes?)\b/i;
const MASS_PER_MASS_RATIO_RE =
  /\b(\d+(?:[.,]\d+)?)\s*(mg|g|grammes?|ug|µg|μg|mcg|microgrammes?)\s*(?:\/\s*|\s+pour\s+)(\d+(?:[.,]\d+)?)?\s*(?:g|grammes?|kg)(?![\p{L}])/iu;
const VOL_PER_VOL_RATIO_RE =
  /\b(\d+(?:[.,]\d+)?)\s*(ml|l)\s*(?:\/\s*|\s+pour\s+)(\d+(?:[.,]\d+)?)?\s*(?:ml|l)(?![\p{L}])/iu;
const CONTIGUOUS_MASS_PER_VOL_RE =
  /\b(\d+(?:[.,]\d+)?)\s*(mg|g|grammes?|ug|µg|μg|mcg|microgrammes?)\s*(?:\/\s*|\s+pour\s+)(\d+(?:[.,]\d+)?)\s*(ml|l)\b/i;
const EXPLICIT_PCT_MV_RE =
  /\b\d+(?:[.,]\d+)?\s*(?:%|pour\s+cent)\s*\(?\s*(?:m\s*\/\s*v|p\s*\/\s*v|masse\s*\/\s*volume|poids\s*\/\s*volume)\s*\)?/i;
const EXPLICIT_PCT_MM_RE =
  /\b\d+(?:[.,]\d+)?\s*(?:%|pour\s+cent)\s*\(?\s*(?:m\s*\/\s*m|p\s*\/\s*p|masse\s*\/\s*masse|poids\s*\/\s*poids)\s*\)?/i;
const EXPLICIT_PCT_VV_RE =
  /\b\d+(?:[.,]\d+)?\s*(?:%|pour\s+cent)\s*\(?\s*(?:v\s*\/\s*v|volume\s*\/\s*volume)\s*\)?/i;
const RELEASE_RATE_TEXT_RE =
  /\b\d+(?:[.,]\d+)?\s*(?:mg|g|grammes?|ug|µg|μg|mcg|microgrammes?|ui|iu|u|unites?)\s*\/\s*(?:24\s*h(?:eures?)?|h(?:eures?)?|doses?|bouffees?|pulverisations?)\b/i;
const RECONSTITUTED_TEXT_RE =
  /\b(?:apres\s+reconstitution|reconstitue[es]?|apres\s+melange|apres\s+dilution)\b/i;

function closeValues(a, b, toleranceRatio = ROUNDING_TOLERANCE_RATIO) {
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * toleranceRatio;
}

/**
 * Détermine la base dimensionnelle d'une expression de dosage à partir de son
 * texte explicite et de ses tokens parsés, sans aucune heuristique sur la forme
 * pharmaceutique.
 */
function detectTextDosageBasis(rawText, tokens = []) {
  const norm = normalizeSearchText(rawText || '');
  if (RECONSTITUTED_TEXT_RE.test(norm)) return 'reconstituted_concentration';
  if (RELEASE_RATE_TEXT_RE.test(norm)) return 'release_rate';
  if (EXPLICIT_PCT_MM_RE.test(norm) || MASS_PER_MASS_RATIO_RE.test(rawText || '')) return 'mass_mass';
  if (EXPLICIT_PCT_VV_RE.test(norm) || VOL_PER_VOL_RATIO_RE.test(rawText || '')) return 'volume_volume';
  if (EXPLICIT_PCT_MV_RE.test(norm)) return 'mass_volume';
  if (
    (Array.isArray(tokens) && tokens.some((t) => t.unit === 'mg/ml')) ||
    CONTIGUOUS_MASS_PER_VOL_RE.test(rawText || '')
  ) {
    return 'mass_volume';
  }
  if (Array.isArray(tokens) && tokens.some((t) => t.unit === '%')) {
    return 'percent_unspecified';
  }
  return 'quantity';
}

/**
 * Résout la base de concentration d'un candidat : un pourcentage nu (`%`) n'est
 * qualifié en `mass_volume`, `mass_mass` ou `volume_volume` que si la donnée
 * source BDPM (`CIS_COMPO` : `dosage` + `reference_dosage` sur spécialité
 * mono-substance) ou une mention explicite (`% m/v`, `% m/m`, `% v/v`) l'établit.
 */
function resolveCandidateDosageBasis(candText, candTokens, record) {
  const textBasis = detectTextDosageBasis(candText, candTokens);
  if (!record) return textBasis;

  const compoBasis = record.compoConcentrationBasis || 'unknown';
  if (compoBasis === 'reconstituted_concentration' && (textBasis === 'mass_volume' || textBasis === 'percent_unspecified')) {
    return 'reconstituted_concentration';
  }
  if (compoBasis === 'release_rate' && textBasis !== 'release_rate') {
    return 'release_rate';
  }
  if (textBasis === 'percent_unspecified' && (record.distinctActiveCount || 1) === 1) {
    if (compoBasis === 'mass_volume' && typeof record.compoConcMgMl === 'number' && record.compoConcMgMl > 0) {
      const pctTok = (candTokens || []).find((t) => t.unit === '%');
      if (pctTok && closeValues(pctTok.amount * 10, record.compoConcMgMl, ROUNDING_TOLERANCE_RATIO)) {
        return 'mass_volume';
      }
    }
    if (compoBasis === 'mass_mass') return 'mass_mass';
    if (compoBasis === 'volume_volume') return 'volume_volume';
  }
  return textBasis;
}

function matchesVerbatimSansClause(record, verbatimQualifier) {
  if (!record || !verbatimQualifier) return false;
  const normQual = normalizeSearchText(verbatimQualifier).trim();
  const parts = normQual.split(/\s+/);
  const target = parts[parts.length - 1];
  if (!target) return false;
  const stem = target.replace(/s$/, '');
  const hay = `${record.normDenom || record.normNom || ''} ; ${record.normForme || ''} ; ${record.normPresText || ''}`;
  const re = new RegExp(`\\bsans\\s+(?:[a-z0-9]+\\s+ni\\s+)?${stem}s?\\b`, 'i');
  return re.test(hay);
}

function hasConvertedConcentrationMatch(
  requested,
  candidate,
  { rawRequested = '', record = null, toleranceRatio = ROUNDING_TOLERANCE_RATIO } = {}
) {
  if (!Array.isArray(requested) || !Array.isArray(candidate) || candidate.length === 0) return false;
  // Interdire toute conversion sur préparations multi-substances
  if ((record?.distinctActiveCount || 1) > 1) return false;
  if (requested.filter((t) => t.unit === 'mg').length > 1) return false;
  if (candidate.filter((t) => t.unit === 'mg').length > 1) return false;

  const candText = record ? `${record.denomination || record.nom || ''}` : '';
  const reqBasis = detectTextDosageBasis(rawRequested, requested);
  const candBasis = resolveCandidateDosageBasis(candText, candidate, record);

  // Toute conversion de concentration exige que les deux côtés soient établis en `mass_volume`
  if (reqBasis !== 'mass_volume' || candBasis !== 'mass_volume') return false;

  const close = (a, b) => closeValues(a, b, toleranceRatio);

  if (requested.length === 2) {
    if (rawRequested && !CONTIGUOUS_MASS_PER_VOL_RE.test(rawRequested)) return false;
    // Si le candidat exprime lui aussi une quantité totale + volume (ex. 50 mg/5 ml vs 100 mg/10 ml),
    // la même concentration ne valide pas un volume ou une quantité totale différents.
    const candHasMassAndVol =
      candidate.some((c) => c.unit === 'mg') && candidate.some((c) => c.unit === 'ml');
    if (candHasMassAndVol) return false;

    const mg = requested.find((t) => t.unit === 'mg');
    const ml = requested.find((t) => t.unit === 'ml');
    if (mg && ml && ml.amount > 0) {
      const presVolumes = record?.presVolumesMl;
      if (Array.isArray(presVolumes) && presVolumes.length > 0) {
        if (!presVolumes.some((v) => close(v, ml.amount))) return false;
      }
      const concMgMl = mg.amount / ml.amount;
      const pct = concMgMl / 10;
      return candidate.some((c) =>
        (c.unit === 'mg/ml' && close(c.amount, concMgMl)) ||
        (c.unit === '%' && close(c.amount, pct))
      );
    }
  } else if (requested.length === 1) {
    const req = requested[0];
    const candHasContiguousRatio = Boolean(candText && CONTIGUOUS_MASS_PER_VOL_RE.test(candText));
    const candMg = candidate.length === 2 ? candidate.find((t) => t.unit === 'mg') : null;
    const candMl = candidate.length === 2 ? candidate.find((t) => t.unit === 'ml') : null;

    if (req.unit === '%') {
      const concMgMl = req.amount * 10;
      if (candidate.some((c) => c.unit === 'mg/ml' && close(c.amount, concMgMl))) return true;
      if (candMg && candMl && candMl.amount > 0 && candHasContiguousRatio) {
        return close(candMg.amount / candMl.amount, concMgMl);
      }
      return false;
    }
    if (req.unit === 'mg/ml') {
      const pct = req.amount / 10;
      if (candidate.some((c) => c.unit === '%' && close(c.amount, pct))) return true;
      if (candMg && candMl && candMl.amount > 0 && candHasContiguousRatio) {
        return close(candMg.amount / candMl.amount, req.amount);
      }
      return false;
    }
  }
  return false;
}

function isNonComparableConcentrationBasis(rawRequested, requested, candidate, record) {
  const candText = record ? `${record.denomination || record.nom || ''}` : '';
  const reqBasis = detectTextDosageBasis(rawRequested, requested);
  const candBasis = resolveCandidateDosageBasis(candText, candidate, record);

  if ((reqBasis === 'release_rate') !== (candBasis === 'release_rate')) return true;
  if ((reqBasis === 'reconstituted_concentration') !== (candBasis === 'reconstituted_concentration')) return true;

  const reqHasExplicitMmOrVv =
    EXPLICIT_PCT_MM_RE.test(normalizeSearchText(rawRequested || '')) ||
    MASS_PER_MASS_RATIO_RE.test(rawRequested || '') ||
    EXPLICIT_PCT_VV_RE.test(normalizeSearchText(rawRequested || '')) ||
    VOL_PER_VOL_RATIO_RE.test(rawRequested || '');
  const candHasExplicitMmOrVv =
    EXPLICIT_PCT_MM_RE.test(normalizeSearchText(candText)) ||
    MASS_PER_MASS_RATIO_RE.test(candText) ||
    EXPLICIT_PCT_VV_RE.test(normalizeSearchText(candText)) ||
    VOL_PER_VOL_RATIO_RE.test(candText);
  if (reqHasExplicitMmOrVv !== candHasExplicitMmOrVv && reqBasis !== candBasis) {
    return true;
  }

  // Comparaison croisée entre pourcentage (%) et concentration masse/volume (mg/mL ou M mg / V mL) :
  // non comparable ('unknown') dès que l'un des deux côtés n'est pas établi en `mass_volume`.
  const reqHasPct = requested.some((t) => t.unit === '%');
  const candHasPct = candidate.some((t) => t.unit === '%');
  const reqHasMvRatio =
    requested.some((t) => t.unit === 'mg/ml') || CONTIGUOUS_MASS_PER_VOL_RE.test(rawRequested || '');
  const candHasMvRatio =
    candidate.some((t) => t.unit === 'mg/ml') || CONTIGUOUS_MASS_PER_VOL_RE.test(candText);

  if ((reqHasPct && candHasMvRatio) || (candHasPct && reqHasMvRatio)) {
    if (reqBasis !== 'mass_volume' || candBasis !== 'mass_volume') {
      return true;
    }
  }

  return false;
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
    } else if (NON_COMPARABLE_DOSAGE_RATIO_RE.test(eff.dosage)) {
      cs.dosage = 'unknown';
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
          if (isNonComparableConcentrationBasis(eff.dosage, requested, denomTokens, record)) {
            cm.dosage = false;
            cs.dosage = 'unknown';
          } else {
            const { matched, extra } = matchDosageTokens(requested, denomTokens, {
              toleranceRatio: ROUNDING_TOLERANCE_RATIO
            });
            cm.dosage = matched === requested.length;
            cs.dosage = cm.dosage ? 'matched' : 'contradicted';
            if (matched > 0) {
              boost += (3 * matched) / requested.length;
              dosageExtra = extra;
            } else if (useAliases && hasConvertedConcentrationMatch(requested, denomTokens, { rawRequested: eff.dosage, record })) {
              cs.dosage = 'expanded';
              boost += 1.0;
            } else {
              boost -= 2.5; // contredit explicitement
            }
          }
        } else if (compoTokens.length > 0) {
          if (isNonComparableConcentrationBasis(eff.dosage, requested, compoTokens, record)) {
            cm.dosage = false;
            cs.dosage = 'unknown';
          } else {
            const { matched, extra } = matchDosageTokens(requested, compoTokens, {
              toleranceRatio: ROUNDING_TOLERANCE_RATIO
            });
            cm.dosage = matched === requested.length;
            cs.dosage = cm.dosage ? 'matched' : 'contradicted';
            if (matched > 0) {
              boost += (2 * matched) / requested.length;
              dosageExtra = extra;
            } else if (useAliases && hasConvertedConcentrationMatch(requested, compoTokens, { rawRequested: eff.dosage, record })) {
              cs.dosage = 'expanded';
              boost += 1.0;
            } else {
              boost -= 2.5;
            }
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
        normPresText: record.normPresText || '',
        normVoie: record.normVoie || ''
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

  // 4. Qualificatifs galéniques (effervescent, lp, orodispersible, pelliculé, à croquer, sans <X>)
  if (useAliases && eff.qualifiers && eff.qualifiers.length > 0 && record) {
    const qualClauses = splitGalenicClauses(`${record.normDenom || record.normNom || ''} ; ${record.normForme || ''}`);
    let matchedQual = 0;
    for (const q of eff.qualifiers) {
      const isSansQual = q.startsWith('sans ');
      if (
        (isSansQual && matchesVerbatimSansClause(record, q)) ||
        (!isSansQual && (
          matchesGalenicPhrase(qualClauses, q) ||
          (q === 'orodispersible' && matchesGalenicPhrase(qualClauses, 'lyophilisat'))
        ))
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
  const isGenericIntent = Boolean(parsed?.extracted?.intents?.includes('generic_equivalent'));
  if (mode === 'concepts' && record) {
    const nameTokens = conceptQueryTokens(parsed);
    const requestedSubstanceCount = countRequestedSubstanceEntities(nameTokens);
    const reqDosages = parsed.effectiveCriteria.dosage ? parseDosageTokens(parsed.effectiveCriteria.dosage) : [];
    const multiDoseRequested = reqDosages.filter((d) => d.unit === 'mg' || d.unit === 'ui').length >= 2;

    // Préférer mono-substance sur requête mono-molécule sans dosage d'association
    const singleRequested = nameTokens.length >= 1 && requestedSubstanceCount <= 1 && !multiDoseRequested;
    if (singleRequested && record.distinctActiveCount === 1) {
      conceptBonus += 1.2;
    } else if (singleRequested && record.distinctActiveCount > 1) {
      conceptBonus -= 0.4;
    }

    // Sur requête générique, mettre en avant les génériques ('generic') avant princeps ('0')
    if (isGenericIntent) {
      if (record.genericRole === 'generic') conceptBonus += 1.5;
      else if (record.genericRole === 'princeps') conceptBonus -= 0.3;
    }

    const active = ref.source === 'bdpm' ? record.isCommercialised : record.isActive;
    if (active) conceptBonus += 0.25;

    if (meta && meta.allSubstancesMatched) {
      conceptBonus += 1.0;
    }
  }

  const hasContradictedCriterion =
    criteria_status.dosage === 'contradicted' ||
    criteria_status.forme === 'contradicted' ||
    criteria_status.voie === 'contradicted' ||
    criteria_status.species === 'contradicted';
  const hasSatisfiedCriterion =
    criteria_status.dosage === 'matched' ||
    criteria_status.dosage === 'expanded' ||
    criteria_status.forme === 'matched' ||
    criteria_status.forme === 'expanded' ||
    criteria_status.voie === 'matched' ||
    criteria_status.voie === 'expanded' ||
    criteria_status.species === 'matched' ||
    criteria_status.species === 'expanded';
  const hasFullTokenCoverage =
    Boolean(meta && meta.coveredTokens && meta.totalTokens && meta.coveredTokens >= meta.totalTokens);
  let qualityRank = MATCH_QUALITY_RANK[ref.match_quality] || 0;
  if (mode === 'concepts') {
    if (
      ref.match_quality === 'prefix' &&
      hasFullTokenCoverage &&
      hasSatisfiedCriterion &&
      !hasContradictedCriterion
    ) {
      qualityRank = 2.5;
    } else if (ref.match_quality === 'exact' && ref.match_via === 'composition' && hasContradictedCriterion) {
      qualityRank = 2.2;
    }
  }

  const viaRank = VIA_BONUS[ref.match_via] || 0;
  return {
    ...ref,
    criteria_match,
    criteria_status,
    _qualityRank: qualityRank,
    _score: boost + conceptBonus,
    _dosageExtra: dosage_extra,
    _speciesMatched: speciesMatched,
    _viaRank: viaRank,
    _activePriority: record ? (ref.source === 'bdpm' ? (record.isCommercialised ? 1 : 0) : (record.isActive ? 1 : 0)) : 0
  };
}

function compareExperimentalRefs(a, b) {
  const qA = a._qualityRank ?? (MATCH_QUALITY_RANK[a.match_quality] || 0);
  const qB = b._qualityRank ?? (MATCH_QUALITY_RANK[b.match_quality] || 0);
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
    const lexical = collectVeterinaryMatches(parsed.raw);
    if (mode === 'concepts' && parsed.code.kind === 'atc_code') {
      return mergeMatchMaps(lexical, collectVetConceptMatches(parsed, store));
    }
    return lexical;
  }

  const queryText = parsed.nameQuery || parsed.raw;
  let matches = collectVeterinaryMatches(queryText);
  if (mode === 'concepts') {
    matches = mergeMatchMaps(matches, collectVetConceptMatches(parsed, store));
  }
  return matches;
}

// Limite connue (revue PR #8) : les mots d'espèce sont remis en fin de requête, pas à
// leur position d'origine (« abeille venin alyostal » -> « venin alyostal abeille »).
// Sans effet mesurable : la recherche lexicale exige tous les mots quel que soit leur
// ordre, et le classement `exact` (dénomination entière égale à la requête) n'est
// quasiment jamais atteint par une requête contenant un mot d'espèce ; le reste du
// classement compare des mots entiers. Correctif si besoin : enregistrer dans
// `provenance` la position de chaque mot d'espèce extrait et le réinsérer à cette place.
function withSpeciesRestoredInName(parsed) {
  const speciesSpans = parsed.provenance.filter((p) => p.role === 'species').map((p) => p.span);
  if (speciesSpans.length === 0) return parsed;
  const nameTokens = [...parsed.nameTokens, ...speciesSpans];
  return {
    ...parsed,
    nameTokens,
    nameQuery: nameTokens.join(' '),
    extracted: { ...parsed.extracted, species: [] },
    effectiveCriteria: { ...parsed.effectiveCriteria, species: [] }
  };
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
  const matchesBySource = {};
  let bdpmRefs = [];
  let vetRefs = [];

  // L'espèce est retirée du texte lexical dans les deux modes : elle doit donc
  // aussi router vers l'ANMV dans les deux modes, sinon elle serait perdue.
  const speciesHintVet = sourceMode === 'auto' && parsed.extracted.species.length > 0;

  // 1. Cas espèce explicite en mode auto : interroger ANMV en priorité. Seul un match
  // ANMV fort sur un produit autorisé pour l'espèce demandée court-circuite la BDPM
  // (certains mots d'espèce figurent aussi dans des dénominations humaines : « venin
  // d'abeille », « sérum d'anguille », « 170 bar » ; un « SERUM TRIVALENT EQUIN » ne
  // répond pas à « sérum d'anguille »).
  let vetStrongFromHint = false;
  if (speciesHintVet) {
    queried.push('anmv');
    matchesBySource.vet = runVetStage(parsed, { mode, store });
    vetRefs = buildRefsFromMatches(matchesBySource.vet, 'vet', getMedicamentLabelByNum, 'denomination');
    vetStrongFromHint = vetRefs.some((r) =>
      isStrongMatchQuality(r.match_quality) && vetRefTargetsSpecies(r.key, parsed.extracted.species, store)
    );
  }

  const needBdpm = sourceMode === 'human' || sourceMode === 'mixed' ||
    (sourceMode === 'auto' && !vetStrongFromHint);
  // Repli BDPM après un routage d'espèce sans match ANMV fort : le mot d'espèce fait
  // alors partie du nom (« venin d'abeille ») et n'est pas un critère d'espèce.
  const parsedBySource = {
    bdpm: speciesHintVet ? withSpeciesRestoredInName(parsed) : parsed,
    vet: parsed
  };

  if (needBdpm) {
    queried.push('bdpm');
    matchesBySource.bdpm = runBdpmStage(parsedBySource.bdpm, { mode, store });
    bdpmRefs = buildRefsFromMatches(matchesBySource.bdpm, 'bdpm', getSpecialiteLabelByCis, 'denomination');
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
  }

  let rawRefs;
  if (sourceMode === 'human') rawRefs = bdpmRefs;
  else if (sourceMode === 'veterinary') rawRefs = vetRefs;
  else if (sourceMode === 'mixed') rawRefs = [...bdpmRefs, ...vetRefs];
  else if (vetStrongFromHint) rawRefs = vetRefs;
  else if (bdpmStrong) rawRefs = bdpmRefs;
  // Même repli que legacy : sans match BDPM fort, l'ANMV remplace la BDPM si elle répond
  else rawRefs = vetRefs.length > 0 ? vetRefs : bdpmRefs;


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
    const refParsed = parsedBySource[ref.source];
    const record = store
      ? (ref.source === 'bdpm' ? store.bdpmByCis.get(ref.key) : store.vetByNum.get(ref.key))
      : buildStructuredEntityRecord(ref.source, ref.key, refParsed, { mode });
    if (
      safety.verbatimQualifiers.length > 0 &&
      !safety.verbatimQualifiers.every((vq) => matchesVerbatimSansClause(record, vq))
    ) {
      continue;
    }
    const meta = matchesBySource[ref.source] && matchesBySource[ref.source].metaByKey[ref.key];
    scored.push(buildEntitySignals(ref, record, meta, refParsed, { mode, store }));
  }

  scored.sort(compareExperimentalRefs);

  // `with_results` = référentiels effectivement présents dans les résultats renvoyés
  // (après repli source=auto et filtre des qualificatifs littéraux), dans l'ordre
  // d'interrogation. `queried` reste la liste des référentiels interrogés.
  // Écart volontaire avec legacy, qui annonce aussi un référentiel dont les
  // résultats faibles ont été remplacés par le repli ANMV.
  const sourcesInResults = new Set(scored.map((r) => (r.source === 'bdpm' ? 'bdpm' : 'anmv')));
  const withResults = queried.filter((src) => sourcesInResults.has(src));

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
  ROUNDING_TOLERANCE_RATIO,
  executeExperimentalSearchPage,
  evaluateEntityCriteria,
  matchFormeCriterion,
  matchVoieCriterion,
  detectTextDosageBasis,
  resolveCandidateDosageBasis,
  isNonComparableConcentrationBasis,
  hasConvertedConcentrationMatch
};
