import { executeRequest } from './api.js';
import { ANGEL_API_ENDPOINTS } from './constants.js';
import { getActiveSession } from './login.js';
import { modeManager } from './modeManager.js';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export function roundToNearestStrikeInterval(price: number, interval: number = 100): number {
  return Math.round(price / interval) * interval;
}

export async function fetchLTP(exchange: string, symbol: string, token: string): Promise<number> {
  if (modeManager.isPaper()) {
    // Return simulated reasonable LTP if in paper mode
    if (token === '99926009') return 52000; // Mock Bank Nifty spot
    if (exchange === 'NFO' && symbol.includes('FUT')) return 52150; // Mock Bank Nifty Future
    return 150; // Mock default option premium
  }

  const session = getActiveSession();
  if (!session) throw new Error('Cannot fetch LTP without active session.');

  try {
    const response = await executeRequest(ANGEL_API_ENDPOINTS.LTP, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MACAddress': 'fe80::1',
        'X-PrivateKey': env.API_KEY,
        Authorization: `Bearer ${session.jwtToken}`,
      },
      data: {
        mode: 'LTP',
        exchangeTokens: {
          [exchange]: [token],
        },
      },
      isIdempotent: true,
    });

    if (response.data && response.data.data && response.data.data.fetched) {
      const item = response.data.data.fetched[0];
      return parseFloat(item.ltp);
    }
    throw new Error(`Quote empty: ${JSON.stringify(response.data)}`);
  } catch (err: any) {
    logger.error(`Error fetching LTP for ${symbol} (${token}): ${err.message}`);
    throw err;
  }
}

/**
 * Fetch LTPs for multiple tokens in batches (up to 50 tokens per request to comply with SmartAPI)
 */
export async function fetchMultipleLTPs(
  items: Array<{ exchange: string; token: string }>
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (items.length === 0) return result;

  if (modeManager.isPaper()) {
    for (const item of items) {
      result.set(item.token, 150);
    }
    return result;
  }

  const session = getActiveSession();
  if (!session) throw new Error('Cannot fetch LTP without active session.');

  const batchSize = 40;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const exchangeTokens: Record<string, string[]> = {};
    for (const item of batch) {
      if (!exchangeTokens[item.exchange]) exchangeTokens[item.exchange] = [];
      exchangeTokens[item.exchange].push(item.token);
    }

    try {
      const response = await executeRequest(ANGEL_API_ENDPOINTS.LTP, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': 'fe80::1',
          'X-PrivateKey': env.API_KEY,
          Authorization: `Bearer ${session.jwtToken}`,
        },
        data: {
          mode: 'LTP',
          exchangeTokens,
        },
        isIdempotent: true,
      });

      if (response.data?.data?.fetched) {
        for (const fetched of response.data.data.fetched) {
          result.set(fetched.symbolToken, parseFloat(fetched.ltp));
        }
      }
    } catch (err: any) {
      logger.error(`Error fetching batch LTP: ${err.message}`);
      throw err;
    }
  }

  return result;
}
