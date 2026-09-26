import fs from 'fs';
import path from 'path';
import { executeRequest } from './api.js';
import { ANGEL_API_ENDPOINTS } from './constants.js';
import { logger } from './logger.js';
import { sendAlert } from '../notifier.js';

export interface ScripItem {
  token: string;
  symbol: string;
  name: string;
  expiry: string;
  strike: string;
  lotsize: string;
  instrumenttype: string;
  exch_seg: string;
  tick_size: string;
}

const SCRIP_FILE_PATH = path.resolve(process.cwd(), 'data', 'scrip_master.json');

export async function fetchAndCacheScripMaster(): Promise<ScripItem[]> {
  const dir = path.dirname(SCRIP_FILE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  logger.info('Fetching scrip master from Angel One...');
  try {
    const res = await executeRequest<ScripItem[]>(ANGEL_API_ENDPOINTS.SCRIP_MASTER, {
      method: 'GET',
      isIdempotent: true,
      maxRetries: 3,
    });
    if (Array.isArray(res.data)) {
      fs.writeFileSync(SCRIP_FILE_PATH, JSON.stringify(res.data));
      logger.info(`Scrip master cached successfully with ${res.data.length} records.`);
      return res.data;
    }
  } catch (error: any) {
    logger.error(`Failed to fetch scrip master online: ${error.message}`);
    if (fs.existsSync(SCRIP_FILE_PATH)) {
      logger.warn('Falling back to local cached scrip_master.json');
      const data = JSON.parse(fs.readFileSync(SCRIP_FILE_PATH, 'utf-8'));
      return data;
    }
    throw error;
  }
  return [];
}

export function loadCachedScrips(): ScripItem[] {
  if (fs.existsSync(SCRIP_FILE_PATH)) {
    return JSON.parse(fs.readFileSync(SCRIP_FILE_PATH, 'utf-8'));
  }
  return [];
}

/**
 * §2.10: Aggregate lot sizes across ALL matching contract rows — never overwrite with the last one seen.
 */
export function extractLotSizes(
  instruments: ScripItem[],
  targetIndices: string[]
): Record<string, number> {
  const freq: Record<string, Record<number, number>> = {};

  for (const item of instruments) {
    if (
      item.exch_seg === 'NFO' &&
      (item.instrumenttype === 'FUTIDX' || item.instrumenttype === 'OPTIDX') &&
      targetIndices.includes(item.name)
    ) {
      const lot = parseInt(item.lotsize, 10);
      if (!Number.isFinite(lot) || lot <= 0) continue; // discard malformed rows per §2.10

      freq[item.name] = freq[item.name] || {};
      freq[item.name][lot] = (freq[item.name][lot] || 0) + 1;
    }
  }

  const resolved: Record<string, number> = {};
  for (const [name, counts] of Object.entries(freq)) {
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (ranked.length === 0) continue;

    const [majorityLot, majorityCount] = ranked[0];
    const total = ranked.reduce((sum, [, c]) => sum + c, 0);

    resolved[name] = parseInt(majorityLot, 10);

    if (ranked.length > 1) {
      // Disagreement across contracts for the same index — alert per §2.10
      const warnMsg = `Lot size disagreement for ${name}: ${JSON.stringify(counts)} — using majority ${majorityLot} (${majorityCount}/${total} contracts). Verify before trading.`;
      logger.warn(warnMsg);
      sendAlert(`⚠️ ${warnMsg}`);
    }
  }
  return resolved;
}

/**
 * §2.10: Reconcile derived lot size against config before entry or startup.
 */
export function verifyLotSizeOrBlock(
  symbol: string,
  derivedLotSize: number,
  configuredLotSize: number
): boolean {
  if (derivedLotSize !== configuredLotSize) {
    sendAlert(
      `🚨 Lot size mismatch for ${symbol}: scrip master says ${derivedLotSize}, config says ${configuredLotSize}. Entry blocked until resolved.`,
      true
    );
    return false;
  }
  return true;
}

/**
 * Resolves monthly expirations dynamically for BANKNIFTY from scrip master (§1, §1.4).
 * Monthly expiry is the last expiry date of that calendar month.
 */
export function resolveMonthlyExpiries(
  instruments: ScripItem[],
  symbol: string = 'BANKNIFTY'
): string[] {
  const expirySet = new Set<string>();

  instruments.forEach((item) => {
    if (item.exch_seg === 'NFO' && item.name === symbol && item.expiry) {
      expirySet.add(item.expiry);
    }
  });

  // Expiry strings in Angel scrip master are usually "DDMMMYYYY" like "29OCT2026"
  const expiries = Array.from(expirySet).sort((a, b) => {
    return new Date(a).getTime() - new Date(b).getTime();
  });

  const monthMap = new Map<string, string>(); // 'YYYY-MM' -> latest expiry in that month
  for (const exp of expiries) {
    const d = new Date(exp);
    if (isNaN(d.getTime())) continue;
    const yearMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    // Since expiries are sorted ascending, the last one seen for a month is the monthly expiry
    monthMap.set(yearMonth, exp);
  }

  return Array.from(monthMap.values());
}
