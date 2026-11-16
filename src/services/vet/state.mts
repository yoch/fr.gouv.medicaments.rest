/**
 * État mutable partagé du domaine vétérinaire : corpus, index de recherche,
 * index par num, metadata, temps d'attente. Centralisé ici pour permettre
 * aux sous-modules (loadPipeline, exportApi) de partager la même source.
 *
 * Objet unique à propriétés mutables — pas de getters/setters partiels.
 * Le reset synchrone invalide les index avant le rechargement progressif.
 */

import { createCorpus, type Corpus, type CorpusRecordLike } from '../../utils/corpusStore.mts';
import type { SearchIndexLike } from '../../utils/corpusSearch.mts';

export interface VetState {
  corpus: Record<string, Corpus<CorpusRecordLike>>;
  metadata: {
    last_updated: string | null;
    source: string;
  };
  searchIndexes: Record<string, SearchIndexLike | null>;
  numIndexes: {
    medicamentsByNum: Map<string, number>;
    compositionsByNum: Map<string, number[]>;
    presentationsByNum: Map<string, number[]>;
  } | null;
  tempsAttente: Map<string, CorpusRecordLike[]>;
  RELATED_BY_NUM_MAPS: Record<string, string>;
  reset(): void;
}

export const state: VetState = {
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
   * Remet l'état à zéro avant un reload. Appelé en tête de
   * `loadVetData()`. Les corpus sont vidés par `clearCorpus` côté pipeline.
   */
  reset() {
    this.searchIndexes.medicaments = null;
    this.searchIndexes.compositions = null;
    this.numIndexes = null;
    this.tempsAttente = new Map();
  }
};

