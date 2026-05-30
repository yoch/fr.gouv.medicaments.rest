'use strict';

const rcp = require('./rcp');
const records = require('./records');

module.exports = {
  ...rcp,
  ...records
};
