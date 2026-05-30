'use strict';

const { miniSearchOptions } = require('./searchRanking');

function miniSearchIndexConfig(fields, boost = null) {
  const indexConfig = {
    fields,
    storeFields: ['id'],
    ...miniSearchOptions
  };
  if (boost) indexConfig.boost = boost;
  return indexConfig;
}

module.exports = {
  miniSearchIndexConfig
};
