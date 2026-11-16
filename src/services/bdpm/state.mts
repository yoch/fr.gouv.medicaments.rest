import { createCorpus, type Corpus, type CorpusRecordLike } from '../../utils/corpusStore.mts';
import type { SearchIndexLike } from '../../utils/corpusSearch.mts';

export interface BdpmState {
  corpus: Record<string, Corpus<CorpusRecordLike>>;
  metadata: {
    last_updated: string | null;
    source: string;
  };
  searchIndexes: Record<string, SearchIndexLike | null>;
  cisIndexes: {
    specialitesByCis: Map<string, number>;
    presentationsByCis: Map<string, number[]>;
    compositionsByCis: Map<string, number[]>;
    avisSmrByCis: Map<string, number[]>;
    avisAsmrByCis: Map<string, number[]>;
    conditionsByCis: Map<string, number[]>;
    rupturesByCis: Map<string, number[]>;
    generiquesByCis: Map<string, number[]>;
    generiquesByGroupe: Map<string, number[]>;
    rupturesByLienAnsm: Map<string, number[]>;
    rupturesByAlertId: Map<string, number>;
  } | null;
  RELATED_BY_CIS_MAPS: Record<string, string>;
  reset(): void;
}

export const state: BdpmState = {
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
   * Remet l'état à zéro avant un reload (index nullés). Appelé
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
