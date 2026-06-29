'use strict';

/**
 * État mutable partagé du domaine vétérinaire : corpus, index de recherche,
 * index par num, metadata, temps d'attente. Centralisé ici pour permettre
 * aux sous-modules (loadPipeline, exportApi) de partager la même source.
 *
 * Objet unique à propriétés mutables — pas de getters/setters partiels.
 * Le reload passe par `reset()` pour rester atomique.
 */

const { createCorpus } = require('../../utils/corpusStore');

const state = {
  corpus: {
    medicaments: createCorpus(),
    compositions: createCorpus(),
    presentations: createCorpus()
  },

  metadata: {
    last_updated: null,
    source:
      'base de données publique des médicaments vétérinaires autorisés en France - Anses/ANMV'
  },

  searchIndexes: {
    medicaments: null,
    compositions: null
  },

  numIndexes: null,
  tempsAttente: new Map(),

  RELATED_BY_NUM_MAPS: {
    compositions: 'compositionsByNum',
    presentations: 'presentationsByNum'
  },

  /**
   * Remet l'état à zéro avant un reload. Atomique : appelé en tête de
   * `loadVetData()`. Les corpus sont vidés par `clearCorpus` côté pipeline.
   */
  reset() {
    this.searchIndexes.medicaments = null;
    this.searchIndexes.compositions = null;
    this.numIndexes = null;
    this.tempsAttente = new Map();
  }
};

module.exports = state;
