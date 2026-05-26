module.exports = {
  apps: [
    {
      name: 'medicaments-api',
      script: 'src/server.js',
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      node_args: '--env-file=.env',
      env: {
        NODE_ENV: 'production',
        RELOAD_STRATEGY: 'restart',
        VET_LOAD_DEFERRED: 'true',
        VET_LOAD_DELAY_MS: '10000'
      }
    }
  ]
};
