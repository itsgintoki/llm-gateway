import { app } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/index.js';
import { reclaimStaleReservations } from './services/budget.service.js';

const server = app.listen(env.PORT, async () => {
  console.log(`=========================================`);
  console.log(`  LLM Gateway listening on port ${env.PORT}`);
  console.log(`  Environment: ${env.NODE_ENV}`);
  console.log(`  Fallback Mode: ${env.FALLBACK_MODE}`);
  console.log(`=========================================`);

  // Recover any orphaned reservations from prior crashes
  try {
    const { reclaimedCount, restoredMicroUsd } = await reclaimStaleReservations();
    if (reclaimedCount > 0) {
      console.log(`[RECOVERY] Cleaned up ${reclaimedCount} stale reservations. Restored ${restoredMicroUsd} µUSD.`);
    }
  } catch (err) {
    console.error('Initial stale reservation sweep failed:', err);
  }
});

// Periodic sweeper to reclaim orphaned reservations (every 30s)
const sweeperInterval = setInterval(async () => {
  try {
    const { reclaimedCount, restoredMicroUsd } = await reclaimStaleReservations();
    if (reclaimedCount > 0) {
      console.log(`[SWEEPER] Reclaimed ${reclaimedCount} expired reservations, restored ${restoredMicroUsd} µUSD.`);
    }
  } catch (err) {
    console.error('Periodic reservation sweeper error:', err);
  }
}, 30_000);

async function gracefulShutdown(signal: string) {
  console.log(`Received ${signal}. Gracefully closing HTTP server and PostgreSQL pool...`);
  clearInterval(sweeperInterval);
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
