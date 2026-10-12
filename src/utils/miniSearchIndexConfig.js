'use strict';

const { miniSearchOptions } = require('./searchRanking');

function miniSearchIndexConfig(fields, boost = null) {
  const indexConfig = {
    fields,
    storeFields: [],
    ...miniSearchOptions
  };
  if (boost) indexConfig.searchOptions = { ...indexConfig.searchOptions, boost };
  return indexConfig;
}

module.exports = {
  miniSearchIndexConfig
};
