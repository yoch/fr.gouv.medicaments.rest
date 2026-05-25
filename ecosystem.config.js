module.exports = {
  apps: [
    {
      name: 'medicaments-api',
      script: 'src/server.js',
      node_args: '--env-file=.env',
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        RELOAD_STRATEGY: 'restart',
        GC_BETWEEN_LOAD_PHASES: 'true',
        MEMORY_ALERT_RSS_MB: '450',
        MEMORY_CRITICAL_RSS_MB: '480'
      },
      env_production: {
        NODE_OPTIONS: '--max-old-space-size=384'
      }
    }
  ]
};
