module.exports = {
  apps: [
    {
      name: 'medicaments-api',
      script: 'src/server.js',
      interpreter: 'bun',
      interpreter_args: '--env-file=.env',
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
