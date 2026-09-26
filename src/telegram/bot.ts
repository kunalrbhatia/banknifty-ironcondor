import { Telegraf } from 'telegraf';
import { env } from '../config/env.js';
import { modeManager } from '../helpers/modeManager.js';
import { bankNiftyPositionStore } from '../store/positionStore.js';
import { logger } from '../helpers/logger.js';
import { exitIronCondorPosition } from '../jobs/exitMonitor.js';

let bot: Telegraf | null = null;

export function initTelegramBot(): void {
  if (!env.USE_TELEGRAM || !env.TELEGRAM_BOT_TOKEN) {
    logger.info('Telegram bot is disabled in config.');
    return;
  }

  bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);

  // Owner-only auth middleware (§2.3)
  bot.use(async (ctx, next) => {
    const senderId = ctx.from?.id.toString();
    if (env.TELEGRAM_CHAT_ID && senderId !== env.TELEGRAM_CHAT_ID) {
      logger.warn(`Unauthorized Telegram access attempt by ID: ${senderId}`);
      await ctx.reply('⛔ Unauthorized.');
      return;
    }
    return next();
  });

  bot.command('status', async (ctx) => {
    const pos = bankNiftyPositionStore.getPosition();
    const isKill = modeManager.isKill();
    const isPanic = modeManager.isPanic();
    const isPaper = modeManager.isPaper();

    let msg = `📊 <b>BANKNIFTY Strategy Status</b>\n`;
    msg += `• Mode: <b>${isPaper ? 'PAPER' : 'LIVE'}</b>\n`;
    msg += `• Soft Pause (.kill-banknifty): <b>${isKill ? 'ACTIVE (Entries paused)' : 'INACTIVE'}</b>\n`;
    msg += `• Hard Stop (.panic-banknifty): <b>${isPanic ? 'ACTIVE' : 'INACTIVE'}</b>\n\n`;

    if (pos && pos.status === 'OPEN') {
      msg += `📈 <b>Active Position: BANKNIFTY 4-Leg Strangle+Hedge</b>\n`;
      msg += `• Expiry: ${pos.expiryDate}\n`;
      msg += `• Short CE: ${pos.shortCE.strike} | Short PE: ${pos.shortPE.strike}\n`;
      msg += `• Long CE Hedge: ${pos.longCE.strike} | Long PE Hedge: ${pos.longPE.strike}\n`;
      msg += `• Entry Net Credit: ₹${pos.entryCreditRupees.toFixed(2)}\n`;
      msg += `• SL: ₹${pos.slAmount.toFixed(2)} | PT: ₹${pos.ptAmount.toFixed(2)}\n`;
      msg += `• 15-DTE Hard Exit: ${pos.dte15Date}\n`;
      if (
        pos.shortCE.currentLTP &&
        pos.shortPE.currentLTP &&
        pos.longCE.currentLTP &&
        pos.longPE.currentLTP
      ) {
        const currentNetCredit =
          (pos.shortCE.currentLTP +
            pos.shortPE.currentLTP -
            (pos.longCE.currentLTP + pos.longPE.currentLTP)) *
          pos.lotSize;
        const pnl = pos.entryCreditRupees - currentNetCredit;
        msg += `• Current P&L: <b>₹${pnl.toFixed(2)}</b>\n`;
      }
    } else {
      msg += `ℹ️ No open position.`;
    }

    await ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // Soft pause (§1.6, §2.3)
  bot.command('kill', async (ctx) => {
    modeManager.setKill(true);
    await ctx.reply(
      '🛑 Soft pause (.kill-banknifty) enabled. New entries are blocked. Live positions remain protected.'
    );
  });

  bot.command('unkill', async (ctx) => {
    modeManager.setKill(false);
    await ctx.reply('▶️ Soft pause (.kill-banknifty) removed. Normal entry checks resumed.');
  });

  // Hard stop (§1.6, §2.3)
  bot.command('panic', async (ctx) => {
    modeManager.setPanic(true);
    await ctx.reply(
      '🚨🚨 PANIC triggered! Halting operations and unwinding all 4 legs immediately...'
    );
    const pos = bankNiftyPositionStore.getPosition();
    if (pos && pos.status === 'OPEN') {
      await exitIronCondorPosition('PANIC', {
        shortCE: pos.shortCE.currentLTP || pos.shortCE.entryLTP,
        shortPE: pos.shortPE.currentLTP || pos.shortPE.entryLTP,
        longCE: pos.longCE.currentLTP || pos.longCE.entryLTP,
        longPE: pos.longPE.currentLTP || pos.longPE.entryLTP,
      });
    }
  });

  bot.command('unpanic', async (ctx) => {
    modeManager.setPanic(false);
    await ctx.reply('✅ PANIC mode cleared.');
  });

  bot
    .launch()
    .then(() => {
      logger.info('Telegram bot polling started successfully.');
    })
    .catch((err) => {
      logger.error(`Telegram bot launch error: ${err.message}`);
    });
}
