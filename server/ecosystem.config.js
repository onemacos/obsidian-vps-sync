module.exports = {
  apps: [
    {
      name: 'vps-sync',
      script: './dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production',
        PORT: 3241,
        // Set these in your .env file or as actual environment variables — DO NOT commit secrets here
        // API_KEY: 'your_key_here',
        // VAULT_PATH: '/opt/vault',
      },
      log_file: '/var/log/vps-sync/combined.log',
      error_file: '/var/log/vps-sync/error.log',
      out_file: '/var/log/vps-sync/out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
