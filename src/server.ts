import { app } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/index.js';

const server = app.listen(env.PORT, () => {
  console.log(`=========================================`);
  console.log(`  LLM Gateway listening on port ${env.PORT}`);
  console.log(`  Environment: ${env.NODE_ENV}`);
  console.log(`  Fallback Mode: ${env.FALLBACK_MODE}`);
  console.log(`=========================================`);
});

async function gracefulShutdown(signal: string) {
  console.log(`Received ${signal}. Gracefully closing HTTP server and PostgreSQL pool...`);
  server.close(async () => {
    try {
      await pool.end();
      console.log('Database connections drained. Exiting cleanly.');
      process.exit(0);
    } catch (err) {
      console.error('Error during database teardown:', err);
      process.exit(1);
    }
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
