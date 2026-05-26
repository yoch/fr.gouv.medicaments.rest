module.exports = {
  apps: [
    {
      name: 'medicaments-api',
      script: 'src/server.js',
      node_args: '--env-file=.env',
      env: {
        NODE_ENV: 'production',
        RELOAD_STRATEGY: 'restart',
        VET_LOAD_DEFERRED: 'true',
        VET_LOAD_DELAY_MS: '1000'
      }
    }
  ]
};
