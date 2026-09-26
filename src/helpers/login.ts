import { authenticator } from 'otplib';
import { executeRequest } from './api.js';
import { ANGEL_API_ENDPOINTS } from './constants.js';
import { env } from '../config/env.js';
import { logger } from './logger.js';
import { modeManager } from './modeManager.js';

export interface UserSession {
  jwtToken: string;
  refreshToken: string;
  feedToken: string;
  userId: string;
}

let activeSession: UserSession | null = null;

export async function loginAngelOne(): Promise<UserSession> {
  if (modeManager.isPaper()) {
    logger.info('Running in PAPER MODE. Generating mock session.');
    activeSession = {
      jwtToken: 'mock_jwt_token',
      refreshToken: 'mock_refresh_token',
      feedToken: 'mock_feed_token',
      userId: env.CLIENT_CODE || 'PAPER_USER',
    };
    return activeSession;
  }

  if (!env.CLIENT_CODE || !env.CLIENT_PIN || !env.CLIENT_TOTP_PIN || !env.API_KEY) {
    throw new Error('Angel One credentials missing in environment!');
  }

  logger.info(`Generating TOTP and logging in client ${env.CLIENT_CODE}...`);
  const totp = authenticator.generate(env.CLIENT_TOTP_PIN);

  const response = await executeRequest(ANGEL_API_ENDPOINTS.LOGIN, {
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
    },
    data: {
      clientcode: env.CLIENT_CODE,
      password: env.CLIENT_PIN,
      totp: totp,
    },
    isIdempotent: true,
  });

  if (response.data && response.data.status && response.data.data) {
    activeSession = {
      jwtToken: response.data.data.jwtToken,
      refreshToken: response.data.data.refreshToken,
      feedToken: response.data.data.feedToken,
      userId: env.CLIENT_CODE,
    };
    logger.info('Angel One authentication successful.');
    return activeSession;
  } else {
    throw new Error(`Login failed: ${response.data?.message || JSON.stringify(response.data)}`);
  }
}

export function getActiveSession(): UserSession | null {
  return activeSession;
}
