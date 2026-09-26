import { getISTDateString } from './logger.js';

// Common NSE trading holidays for 2026
export const NSE_HOLIDAYS_2026 = new Set<string>([
  '2026-01-26', // Republic Day
  '2026-03-03', // Holi
  '2026-03-20', // Id-ul-Fitr
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-05-27', // Bakri Id
  '2026-08-15', // Independence Day
  '2026-10-02', // Mahatma Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-10', // Diwali Laxmi Pujan
  '2026-11-25', // Gurunanak Jayanti
  '2026-12-25', // Christmas
]);

/**
 * Timezone-safe trading day check per §2.5.
 * Uses Intl.DateTimeFormat with Asia/Kolkata explicitly.
 */
export function isTradingDay(date: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
  }).format(date);

  if (parts === 'Sat' || parts === 'Sun') {
    return false;
  }

  const dateStr = getISTDateString(date);
  if (NSE_HOLIDAYS_2026.has(dateStr)) {
    return false;
  }

  return true;
}

/**
 * Calculates calendar days between two dates in IST timezone.
 */
export function calculateDTE(today: Date, expiryDate: Date): number {
  const todayISTStr = getISTDateString(today);
  const expiryISTStr = getISTDateString(expiryDate);

  const [y1, m1, d1] = todayISTStr.split('-').map(Number);
  const [y2, m2, d2] = expiryISTStr.split('-').map(Number);

  const utc1 = Date.UTC(y1, m1 - 1, d1);
  const utc2 = Date.UTC(y2, m2 - 1, d2);

  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((utc2 - utc1) / msPerDay);
}

/**
 * Generic DTE anchor: expiry - `targetDte` calendar days, rolled BACKWARDS to the nearest
 * previous trading day when it lands on a weekend/holiday (§1.3.1).
 * Never rolls forward to the next trading day.
 */
export function getAdjustedTargetDteDate(expiryDate: Date, targetDte: number): Date {
  const expiryISTStr = getISTDateString(expiryDate);
  const [y, m, d] = expiryISTStr.split('-').map(Number);
  const targetUtc = Date.UTC(y, m - 1, d - targetDte);

  let current = new Date(targetUtc);
  while (!isTradingDay(current)) {
    // Step backwards 1 day
    current = new Date(current.getTime() - 24 * 60 * 60 * 1000);
  }
  return current;
}

/**
 * For 15-DTE hard exit (§1.3.1):
 * If expiry - 15 calendar days is a holiday/weekend, roll backwards to nearest PREVIOUS trading day.
 */
export function getAdjusted15DteDate(expiryDate: Date): Date {
  return getAdjustedTargetDteDate(expiryDate, 15);
}
