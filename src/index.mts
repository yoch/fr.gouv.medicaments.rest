import { createApp } from './app.mts';
import * as bdpm from './services/dataLoader.mts';
import * as vet from './services/vetDataLoader.mts';
import { executeHybridSearch } from './services/searchOrchestrator.mts';
import { getRuntimeConfig } from './runtimeConfig.mts';
import swaggerSpecs from './swagger.js';

const api = {
  createApp,
  executeHybridSearch,
  getRuntimeConfig,
  swaggerSpecs,
  bdpm: {
    loadData: bdpm.loadData,
    search: bdpm.search,
    listCorpusPage: bdpm.listCorpusPage,
    getMetadata: bdpm.getMetadata,
    getSpecialiteByCis: bdpm.getSpecialiteByCis,
    getRelatedByCis: bdpm.getRelatedByCis,
    getGeneriquesForCis: bdpm.getGeneriquesForCis,
    exportSearchIndexes: bdpm.exportBdpmSearchIndexes,
    exportCorpusDocuments: bdpm.exportBdpmCorpusDocuments
  },
  vet: {
    loadVetData: vet.loadVetData,
    searchVet: vet.searchVet,
    listVetCorpusPage: vet.listVetCorpusPage,
    getVetMetadata: vet.getVetMetadata,
    getMedicamentByNum: vet.getMedicamentByNum,
    getRelatedByNum: vet.getRelatedByNum,
    exportSearchIndexes: vet.exportVetSearchIndexes,
    exportCorpusDocuments: vet.exportVetCorpusDocuments
  }
};

export default api;
export {
  createApp,
  executeHybridSearch,
  getRuntimeConfig,
  swaggerSpecs
};
