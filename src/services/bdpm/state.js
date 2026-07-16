'use strict';

/**
 * État mutable partagé du domaine BDPM : corpus, index de recherche, index
 * par CIS, metadata. Centralisé ici pour permettre aux sous-modules
 * (loadPipeline, exportApi) de partager la même source de vérité.
 *
 * Objet unique à propriétés mutables — pas de getters/setters partiels.
 * Le reload passe par `reset()` pour rester atomique.
 */

const { createCorpus } = require('../../utils/corpusStore');

const state = {
  corpus: {
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
  },

  metadata: {
    last_updated: null,
    source: 'base de données publique des médicaments - gouv.fr'
  },

  searchIndexes: {
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
  },

  cisIndexes: null,

  RELATED_BY_CIS_MAPS: {
    presentations: 'presentationsByCis',
    compositions: 'compositionsByCis',
    avis_smr: 'avisSmrByCis',
    avis_asmr: 'avisAsmrByCis',
    conditions: 'conditionsByCis',
    ruptures: 'rupturesByCis'
  },

  /**
   * Remet l'état à zéro avant un reload (index nullés). Atomique : appelé
   * en tête de `loadData()`. Les corpus sont vidés par `clearCorpus` côté
   * loader (conserve les instances de tableau).
   */
  reset() {
    for (const key of Object.keys(this.searchIndexes)) {
      this.searchIndexes[key] = null;
    }
    this.cisIndexes = null;
  }
};

module.exports = state;
