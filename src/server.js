'use strict';

const server = require('./server.mts');

if (require.main === module) {
  server.startServer();
}

module.exports = server;
