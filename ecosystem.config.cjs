// pm2 start ecosystem.config.cjs   (run `npm ci && npm run build` first)
// Settings live in .env next to this file; the app loads it itself.
module.exports = {
  apps: [
    {
      name: 'music-party',
      script: 'dist/server.js',
      cwd: __dirname,
      instances: 1, // must stay 1: the queue and connected sockets live in this one process
      exec_mode: 'fork',
      max_memory_restart: '300M',
      kill_timeout: 4000, // gives the app time to save the queue on restart
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
