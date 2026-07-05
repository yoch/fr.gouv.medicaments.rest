'use strict';

const { createApp } = require('./app');
const bdpm = require('./services/dataLoader');
const vet = require('./services/vetDataLoader');
const { executeHybridSearch } = require('./services/searchOrchestrator');
const { getRuntimeConfig } = require('./runtimeConfig');
const swaggerSpecs = require('./swagger');

module.exports = {
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
