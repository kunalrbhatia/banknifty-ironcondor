/**
 * Standard normal cumulative distribution function (CDF)
 * Abramowitz and Stegun approximation (formula 7.1.26), precision ~1.5e-7
 */
export function normCdf(x: number): number {
  if (isNaN(x)) return 0;
  // Symmetry for negative values
  if (x < 0) {
    return 1 - normCdf(-x);
  }

  const p = 0.2316419;
  const b1 = 0.31938153;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;

  const t = 1.0 / (1.0 + p * x);
  const pdf = normPdf(x);
  const cdf = 1.0 - pdf * (b1 * t + b2 * t ** 2 + b3 * t ** 3 + b4 * t ** 4 + b5 * t ** 5);
  return cdf;
}

/**
 * Standard normal probability density function (PDF)
 */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * d1 formula for Black-Scholes
 */
export function d1(spot: number, strike: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0 || spot <= 0 || strike <= 0) return 0;
  return (Math.log(spot / strike) + (r + sigma ** 2 / 2) * T) / (sigma * Math.sqrt(T));
}

/**
 * Black-Scholes option price
 */
export function bsPrice(
  spot: number,
  strike: number,
  T: number,
  r: number,
  sigma: number,
  isCall: boolean
): number {
  if (T <= 0) {
    return isCall ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  }
  const d_1 = d1(spot, strike, T, r, sigma);
  const d_2 = d_1 - sigma * Math.sqrt(T);

  return isCall
    ? spot * normCdf(d_1) - strike * Math.exp(-r * T) * normCdf(d_2)
    : strike * Math.exp(-r * T) * normCdf(-d_2) - spot * normCdf(-d_1);
}

/**
 * Black-Scholes delta
 * Call delta in [0, 1], Put delta in [-1, 0]
 */
export function bsDelta(
  spot: number,
  strike: number,
  T: number,
  r: number,
  sigma: number,
  isCall: boolean
): number {
  if (T <= 0) {
    if (isCall) return spot > strike ? 1 : 0;
    return spot < strike ? -1 : 0;
  }
  const d_1 = d1(spot, strike, T, r, sigma);
  return isCall ? normCdf(d_1) : normCdf(d_1) - 1;
}

/**
 * Newton-Raphson IV inversion from observed market price
 * §1: Inverts live LTP to back out implied volatility with sanity clamping
 */
export function impliedVol(
  marketPrice: number,
  spot: number,
  strike: number,
  T: number,
  r: number,
  isCall: boolean,
  guess = 0.25
): number {
  // Intrinsic value bound check
  const intrinsic = isCall ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  if (marketPrice <= intrinsic) {
    return 0.05; // Return lower bound if deep ITM or under-intrinsic
  }

  let sigma = guess;
  for (let i = 0; i < 50; i++) {
    const price = bsPrice(spot, strike, T, r, sigma, isCall);
    const d_1 = d1(spot, strike, T, r, sigma);
    const vega = spot * normPdf(d_1) * Math.sqrt(T);

    if (Math.abs(vega) < 1e-8) break;
    const diff = price - marketPrice;
    if (Math.abs(diff) < 1e-4) break;

    sigma -= diff / vega;
    sigma = Math.max(0.01, Math.min(sigma, 5.0)); // Clamp between 1% and 500% IV
  }

  return sigma;
}

export interface DeltaStrikeOption {
  strike: number;
  delta: number;
  ltp: number;
  iv: number;
  token: string;
  symbol: string;
}

/**
 * §1 Nearest-strike selection by target delta
 * Ties broken by preferring the further-OTM strike (more conservative).
 * For Call (isCall=true), further OTM means higher strike (strike > best.strike).
 * For Put (isCall=false), further OTM means lower strike (strike < best.strike).
 */
export function pickNearestDeltaStrike(
  chainSide: DeltaStrikeOption[],
  targetDelta: number,
  isCall: boolean
): DeltaStrikeOption {
  if (chainSide.length === 0) {
    throw new Error('Option chain side is empty; cannot select delta strike.');
  }

  return chainSide.reduce((best, row) => {
    const diff = Math.abs(Math.abs(row.delta) - targetDelta);
    const bestDiff = Math.abs(Math.abs(best.delta) - targetDelta);

    if (diff < bestDiff - 1e-6) {
      return row;
    }
    if (Math.abs(diff - bestDiff) <= 1e-6) {
      // Tie breaker: prefer further-OTM
      const isFurtherOTM = isCall ? row.strike > best.strike : row.strike < best.strike;
      return isFurtherOTM ? row : best;
    }
    return best;
  });
}
