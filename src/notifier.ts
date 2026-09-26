import { env } from './config/env.js';
import { logger } from './helpers/logger.js';
import axios from 'axios';

export async function sendAlert(message: string, isHighSeverity = false): Promise<void> {
  const prefix = isHighSeverity ? '🚨 [HIGH RISK] ' : 'ℹ️ ';
  const fullMsg = `${prefix}${message}`;
  logger.info(`NOTIFIER: ${fullMsg}`);

  let telegramSent = false;
  if (env.USE_TELEGRAM && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
      await axios.post(url, {
        chat_id: env.TELEGRAM_CHAT_ID,
        text: fullMsg,
        parse_mode: 'HTML',
      });
      telegramSent = true;
    } catch (err: any) {
      logger.error(`Telegram alert failed: ${err.message}`);
    }
  }

  // Fallback to Slack if Telegram failed or if explicitly configured (§2.7)
  if ((!telegramSent || env.USE_SLACK) && env.SLACK_WEBHOOK_URL) {
    try {
      await axios.post(env.SLACK_WEBHOOK_URL, {
        text: fullMsg,
      });
    } catch (err: any) {
      logger.error(`Slack alert failed: ${err.message}`);
    }
  }
}
