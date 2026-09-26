import cron from 'node-cron';
import { env } from './config/env.js';
import { createServer } from './server.js';
import { loginAngelOne } from './helpers/login.js';
import {
  fetchAndCacheScripMaster,
  loadCachedScrips,
  extractLotSizes,
  verifyLotSizeOrBlock,
} from './helpers/scripMaster.js';
import { modeManager } from './helpers/modeManager.js';
import { runDailyJob } from './jobs/dailyEntryJob.js';
import { generateDailyReport } from '../analysis/generateReport.js';
import { initTelegramBot } from './telegram/bot.js';
import { webSocketManager } from './helpers/websocket.js';
import { bankNiftyPositionStore } from './store/positionStore.js';
import { logger } from './helpers/logger.js';
import { sendAlert } from './notifier.js';

async function bootstrap() {
  logger.info('🚀 Starting BANKNIFTY 45-DTE Delta-Hedged Short Strangle Engine...');

  // Initialize switches
  if (env.PAPER_MODE) {
    modeManager.setPaper(true);
  }

  // Express Server
  const app = createServer();
  app.listen(env.PORT, () => {
    logger.info(`Health check server listening on port ${env.PORT}`);
  });

  // Login Angel One
  try {
    await loginAngelOne();
  } catch (err: any) {
    logger.error(`Initial Angel One login failed: ${err.message}`);
    await sendAlert(`🚨 Initial Angel One login failed: ${err.message}`, true);
  }

  // Refresh and reconcile scrip master at startup (§2.10)
  try {
    let scrips = loadCachedScrips();
    if (scrips.length === 0) {
      scrips = await fetchAndCacheScripMaster();
    }
    const lotSizes = extractLotSizes(scrips, ['BANKNIFTY']);
    const derivedLot = lotSizes['BANKNIFTY'] || 30;
    verifyLotSizeOrBlock('BANKNIFTY', derivedLot, env.LOT_SIZE);
  } catch (err: any) {
    logger.error(`Scrip master initialization failed: ${err.message}`);
  }

  // Start Telegram Bot
  initTelegramBot();

  // If there's an open position from previous session, restore WebSocket monitoring
  if (bankNiftyPositionStore.hasOpenPosition()) {
    logger.info('Resuming continuous WebSocket monitoring for existing open 4-leg position.');
    webSocketManager.start();
  }

  // Morning Scrip Master Refresh Cron at 08:30 IST
  cron.schedule(
    '30 8 * * 1-5',
    async () => {
      logger.info('08:30 IST: Running morning scrip master sync and lot size reconciliation...');
      try {
        const scrips = await fetchAndCacheScripMaster();
        const lotSizes = extractLotSizes(scrips, ['BANKNIFTY']);
        const derivedLot = lotSizes['BANKNIFTY'] || 30;
        verifyLotSizeOrBlock('BANKNIFTY', derivedLot, env.LOT_SIZE);
      } catch (err: any) {
        logger.error(`Morning scrip refresh failed: ${err.message}`);
      }
    },
    {
      timezone: 'Asia/Kolkata',
    }
  );

  // Daily Entry & 15-DTE Check Job at 15:00 IST (§1.3.2)
  cron.schedule(
    `${env.ENTRY_WINDOW_START_MINUTE} ${env.ENTRY_WINDOW_START_HOUR} * * 1-5`,
    async () => {
      logger.info(
        `Running scheduled BANKNIFTY entry/15-DTE job at ${env.ENTRY_WINDOW_START_HOUR}:${env.ENTRY_WINDOW_START_MINUTE} IST...`
      );
      await runDailyJob();
    },
    {
      timezone: 'Asia/Kolkata',
    }
  );

  // Daily Report Generation at 15:40 IST (§1.8)
  cron.schedule(
    `${env.REPORT_MINUTE} ${env.REPORT_HOUR} * * 1-5`,
    async () => {
      logger.info('Running 15:40 IST daily trade report generator...');
      generateDailyReport(new Date());
    },
    {
      timezone: 'Asia/Kolkata',
    }
  );

  logger.info('BANKNIFTY Strategy Engine initialized and cron schedules registered.');
}

bootstrap().catch((err) => {
  logger.error(`Fatal bootstrap error: ${err.message}`);
  process.exit(1);
});
