import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Robust env boolean parser.
 * Explicitly parses strings so "false" / "0" / "no" / "off" are falsy.
 */
const envBool = (defaultValue: boolean) =>
  z.preprocess((v) => {
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (['false', '0', 'no', 'off', ''].includes(s)) return false;
      if (['true', '1', 'yes', 'on'].includes(s)) return true;
      return undefined;
    }
    return v;
  }, z.boolean().default(defaultValue));

const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Broker Credentials (Angel One SmartAPI)
  API_KEY: z.string().default(''),
  CLIENT_CODE: z.string().default(''),
  CLIENT_PIN: z.string().default(''),
  CLIENT_TOTP_PIN: z.string().default(''),

  // Telegram
  USE_TELEGRAM: envBool(false),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_CHAT_ID: z.string().optional().default(''),

  // Slack
  USE_SLACK: envBool(false),
  SLACK_WEBHOOK_URL: z.string().optional().default(''),

  // Strategy Config (BANKNIFTY 45-DTE Delta-Hedged Short Strangle — §3)
  LOT_SIZE: z.coerce.number().default(30),
  TARGET_DTE: z.coerce.number().default(45),
  ENTRY_DTE_WINDOW: z.coerce.number().default(3),
  HARD_EXIT_DTE: z.coerce.number().default(15),
  SHORT_TARGET_DELTA: z.coerce.number().default(0.3),
  HEDGE_TARGET_DELTA_MIN: z.coerce.number().default(0.15),
  HEDGE_TARGET_DELTA_MAX: z.coerce.number().default(0.17),
  PT_PCT_OF_CREDIT: z.coerce.number().default(50),
  SL_PCT_OF_CREDIT: z.coerce.number().default(100),
  RISK_FREE_RATE: z.coerce.number().default(0.065),

  ENTRY_WINDOW_START_HOUR: z.coerce.number().default(15),
  ENTRY_WINDOW_START_MINUTE: z.coerce.number().default(0),
  ENTRY_WINDOW_END_HOUR: z.coerce.number().default(15),
  ENTRY_WINDOW_END_MINUTE: z.coerce.number().default(15),

  REPORT_HOUR: z.coerce.number().default(15),
  REPORT_MINUTE: z.coerce.number().default(40),

  PAPER_MODE: envBool(true),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
