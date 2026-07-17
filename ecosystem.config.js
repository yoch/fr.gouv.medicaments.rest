module.exports = {
  apps: [
    {
      name: 'medicaments-api',
      // Bun en binaire direct : évite ProcessContainerForkBun.js qui
      // casse `require.main === module` et empêche startServer().
      script: `${process.env.HOME}/.bun/bin/bun`,
      args: '--env-file=.env src/server.js',
      interpreter: 'none',
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env: {
        PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
        NODE_ENV: 'production',
        RELOAD_STRATEGY: 'restart',
        CORPUS_LIGHT_PROFILE: 'true',
        VET_LOAD_DEFERRED: 'true',
        VET_LOAD_DELAY_MS: '5000'
      }
    }
  ]
};
