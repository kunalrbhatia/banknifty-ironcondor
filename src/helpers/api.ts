import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { logger } from './logger.js';
import { sendAlert } from '../notifier.js';

interface RequestOptions extends AxiosRequestConfig {
  isIdempotent?: boolean; // §2.4: order placement and mutations must NOT be marked idempotent
  maxRetries?: number;
  retryDelayMs?: number;
}

export async function executeRequest<T = any>(
  url: string,
  options: RequestOptions = {}
): Promise<AxiosResponse<T>> {
  const {
    isIdempotent = true,
    maxRetries = isIdempotent ? 3 : 0, // §2.4: never auto-retry non-idempotent calls blindly
    retryDelayMs = 1000,
    ...axiosConfig
  } = options;

  let attempt = 0;
  while (true) {
    try {
      attempt++;
      const response = await axios({
        url,
        timeout: 10000,
        ...axiosConfig,
      });
      return response;
    } catch (error: any) {
      const isLastAttempt = attempt > maxRetries;
      logger.warn(
        `API call to ${url} failed (Attempt ${attempt}/${maxRetries + 1}): ${error.message}`
      );

      if (!isIdempotent) {
        logger.error(
          `Non-idempotent call failed on ${url}. Skipping blind retry per §2.4 to prevent duplicate fills.`
        );
        throw error;
      }

      if (isLastAttempt) {
        sendAlert(
          `🚨 API request failed after ${maxRetries} retries: ${url} (${error.message})`,
          true
        );
        throw error;
      }

      await new Promise((res) => setTimeout(res, retryDelayMs * attempt));
    }
  }
}
