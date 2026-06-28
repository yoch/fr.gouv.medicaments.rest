'use strict';

/**
 * État mutable partagé du domaine vétérinaire : corpus, index de recherche,
 * index par num, metadata, temps d'attente. Centralisé ici pour permettre
 * aux sous-modules (exportApi) de partager la même source de vérité.
 */

const { createCorpus } = require('../../utils/corpusStore');

const corpus = {
  medicaments: createCorpus(),
  compositions: createCorpus(),
  presentations: createCorpus()
};

let tempsAttente = new Map();

const metadata = {
  last_updated: null,
  source:
    'base de données publique des médicaments vétérinaires autorisés en France - Anses/ANMV'
};

const searchIndexes = {
  medicaments: null,
  compositions: null
};

let numIndexes = null;

function getNumIndexes() {
  return numIndexes;
}

function setNumIndexes(value) {
  numIndexes = value;
}

function getTempsAttente() {
  return tempsAttente;
}

function setTempsAttente(value) {
  tempsAttente = value;
}

const RELATED_BY_NUM_MAPS = {
  compositions: 'compositionsByNum',
  presentations: 'presentationsByNum'
};

module.exports = {
  corpus,
  metadata,
  searchIndexes,
  getNumIndexes,
  setNumIndexes,
  getTempsAttente,
  setTempsAttente,
  RELATED_BY_NUM_MAPS
};
