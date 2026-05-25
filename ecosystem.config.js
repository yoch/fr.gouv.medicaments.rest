module.exports = {
  apps: [
    {
      name: 'medicaments-api',
      script: 'src/server.js',
      node_args: '--env-file=.env',
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        RELOAD_STRATEGY: 'restart'
      },
      env_production: {
        NODE_OPTIONS: '--max-old-space-size=384'
      }
    }
  ]
};
