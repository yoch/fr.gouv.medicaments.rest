'use strict';

/**
 * État mutable partagé du domaine BDPM : corpus, index de recherche, index
 * par CIS, metadata. Centralisé ici pour permettre aux sous-modules
 * (loadPipeline, corpusApi, exportApi) de partager la même source de vérité.
 */

const config = require('../../config');
const { createCorpus } = require('../../utils/corpusStore');

const HYDRATE_RELATED_LIMIT = config.searchHydrateRelatedLimit;
const DETAIL_HYDRATE_RELATED_LIMIT = config.detailHydrateRelatedLimit;
const LOAD_HAS_AVIS = config.loadHasAvis;
const LOAD_MITM = config.loadMitm;

const corpus = {
  specialites: createCorpus(),
  presentations: createCorpus(),
  compositions: createCorpus(),
  avis_smr: createCorpus(),
  avis_asmr: createCorpus(),
  generiques: createCorpus(),
  conditions: createCorpus(),
  ruptures: createCorpus(),
  substances: createCorpus(),
  mitm: createCorpus()
};

const metadata = {
  last_updated: null,
  source: 'base de données publique des médicaments - gouv.fr'
};

const searchIndexes = {
  specialites: null,
  presentations: null,
  compositions: null,
  avis_smr: null,
  avis_asmr: null,
  generiques: null,
  conditions: null,
  ruptures: null,
  substances: null,
  mitm: null
};

let cisIndexes = null;

function getCisIndexes() {
  return cisIndexes;
}

function setCisIndexes(value) {
  cisIndexes = value;
}

const RELATED_BY_CIS_MAPS = {
  presentations: 'presentationsByCis',
  compositions: 'compositionsByCis',
  avis_smr: 'avisSmrByCis',
  avis_asmr: 'avisAsmrByCis',
  conditions: 'conditionsByCis'
};

module.exports = {
  corpus,
  metadata,
  searchIndexes,
  getCisIndexes,
  setCisIndexes,
  RELATED_BY_CIS_MAPS,
  HYDRATE_RELATED_LIMIT,
  DETAIL_HYDRATE_RELATED_LIMIT,
  loadHasAvis: LOAD_HAS_AVIS,
  loadMitm: LOAD_MITM
};
