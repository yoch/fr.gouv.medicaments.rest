module.exports = {
    apps: [
        {
            name: 'medicaments-api',
            script: 'src/server.js',
            node_args: '--env-file=.env',
            env: {
                NODE_ENV: 'production'
            }
        }
    ]
};
