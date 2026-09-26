import path from 'path';
import fs from 'fs';
import { roundToNearestStrikeInterval } from '../src/helpers/marketData.js';
import { extractLotSizes } from '../src/helpers/scripMaster.js';
import {
  calculateDTE,
  getAdjusted15DteDate,
  getAdjustedTargetDteDate,
  isTradingDay,
} from '../src/helpers/holidayCheck.js';
import {
  bsPrice,
  bsDelta,
  impliedVol,
  pickNearestDeltaStrike,
  DeltaStrikeOption,
} from '../src/helpers/blackScholes.js';
import { parseMtmLine, generateDailyReport } from '../analysis/generateReport.js';

describe('BANKNIFTY 45-DTE Delta-Hedged Short Strangle Math & Engineering Rules', () => {
  test('Strike rounding matches Bank Nifty 100 interval', () => {
    expect(roundToNearestStrikeInterval(52140, 100)).toBe(52100);
    expect(roundToNearestStrikeInterval(52160, 100)).toBe(52200);
    expect(roundToNearestStrikeInterval(52000, 100)).toBe(52000);
  });

  test('§2.10 Lot size aggregation uses majority vote across contracts for BANKNIFTY', () => {
    const mockInstruments: any[] = [
      { exch_seg: 'NFO', instrumenttype: 'OPTIDX', name: 'BANKNIFTY', lotsize: '30' },
      { exch_seg: 'NFO', instrumenttype: 'OPTIDX', name: 'BANKNIFTY', lotsize: '30' },
      { exch_seg: 'NFO', instrumenttype: 'OPTIDX', name: 'BANKNIFTY', lotsize: '35' }, // stray row
      { exch_seg: 'NFO', instrumenttype: 'OPTIDX', name: 'BANKNIFTY', lotsize: '0' }, // invalid row
      { exch_seg: 'NSE', instrumenttype: 'EQ', name: 'HDFCBANK', lotsize: '1' },
    ];

    const lotSizes = extractLotSizes(mockInstruments, ['BANKNIFTY']);
    expect(lotSizes['BANKNIFTY']).toBe(30);
  });

  test('§2.5 DTE calculation in calendar days', () => {
    const today = new Date('2026-09-14T09:30:00.000Z');
    const expiry = new Date('2026-10-29T10:00:00.000Z');
    const dte = calculateDTE(today, expiry);
    expect(dte).toBe(45);
  });

  test('§1.3.1 15-DTE hard-exit holiday rollback', () => {
    const expiry = new Date('2026-10-29T10:00:00.000Z'); // Thursday
    const adjusted15 = getAdjusted15DteDate(expiry);
    expect(isTradingDay(adjusted15)).toBe(true);
    expect(calculateDTE(adjusted15, expiry)).toBeGreaterThanOrEqual(15);
  });

  test('45-DTE entry anchor rolls back off weekend/holiday', () => {
    const expiry = new Date('2026-10-29T10:00:00.000Z');
    const adjusted = getAdjustedTargetDteDate(expiry, 45);
    expect(isTradingDay(adjusted)).toBe(true);
    expect(calculateDTE(adjusted, expiry)).toBeGreaterThanOrEqual(45);
  });

  test('Black-Scholes price and delta math consistency', () => {
    // Known BS test case: spot=100, strike=100, T=1, r=0.05, sigma=0.20
    const spot = 100;
    const strike = 100;
    const T = 1;
    const r = 0.05;
    const sigma = 0.2;

    const callPrice = bsPrice(spot, strike, T, r, sigma, true);
    const putPrice = bsPrice(spot, strike, T, r, sigma, false);

    // Call ~ 10.45, Put ~ 5.57
    expect(callPrice).toBeCloseTo(10.45, 1);
    expect(putPrice).toBeCloseTo(5.57, 1);

    const callDelta = bsDelta(spot, strike, T, r, sigma, true);
    const putDelta = bsDelta(spot, strike, T, r, sigma, false);

    // Call delta ~ 0.637, Put delta = Call delta - 1 ~ -0.363
    expect(callDelta).toBeCloseTo(0.637, 2);
    expect(putDelta).toBeCloseTo(-0.363, 2);
    expect(callDelta - putDelta).toBeCloseTo(1, 4);

    // Implied vol inversion
    const invertedCallIV = impliedVol(callPrice, spot, strike, T, r, true);
    expect(invertedCallIV).toBeCloseTo(sigma, 2);

    const invertedPutIV = impliedVol(putPrice, spot, strike, T, r, false);
    expect(invertedPutIV).toBeCloseTo(sigma, 2);
  });

  test('Delta strike selection picks nearest delta and breaks ties further OTM', () => {
    const chainSide: DeltaStrikeOption[] = [
      { strike: 52000, delta: 0.45, ltp: 400, iv: 0.16, token: '1', symbol: 'CE1' },
      { strike: 52500, delta: 0.32, ltp: 240, iv: 0.16, token: '2', symbol: 'CE2' },
      { strike: 52600, delta: 0.28, ltp: 210, iv: 0.16, token: '3', symbol: 'CE3' },
      { strike: 53500, delta: 0.16, ltp: 80, iv: 0.16, token: '4', symbol: 'CE4' },
    ];

    // Target ~0.30 -> diff for 52500 is 0.02, diff for 52600 is 0.02.
    // Tie breaker for calls should pick higher strike (52600) as further OTM.
    const selected = pickNearestDeltaStrike(chainSide, 0.3, true);
    expect(selected.strike).toBe(52600);

    // Target ~0.16 -> 53500 exactly matches
    const selectedHedge = pickNearestDeltaStrike(chainSide, 0.16, true);
    expect(selectedHedge.strike).toBe(53500);
  });

  test('§1.7 MTM format line parsing for all 4 legs', () => {
    const line =
      '01/10/2026, 15:30:00 | BANKNIFTY | shortCE=53000@160.00 | shortPE=51000@170.00 | longCE=53800@55.00 | longPE=50200@65.00 | netCredit=6300.00 | unrealizedPnL=2700.00 | pctOfSL=0.0 | pctOfPT=60.0';
    const parsed = parseMtmLine(line);
    expect(parsed).not.toBeNull();
    expect(parsed?.shortCEStrike).toBe('53000');
    expect(parsed?.shortCELTP).toBe(160);
    expect(parsed?.shortPEStrike).toBe('51000');
    expect(parsed?.shortPELTP).toBe(170);
    expect(parsed?.longCEStrike).toBe('53800');
    expect(parsed?.longCELTP).toBe(55);
    expect(parsed?.longPEStrike).toBe('50200');
    expect(parsed?.longPELTP).toBe(65);
    expect(parsed?.netCredit).toBe(6300);
    expect(parsed?.unrealizedPnL).toBe(2700);
    expect(parsed?.pctOfPT).toBe(60.0);
  });

  test('§2.9 CI smoke test for 4-leg daily report generation with fixture', () => {
    const fixturePath = path.resolve(
      process.cwd(),
      'tests',
      'fixtures',
      'fixture-mtm-banknifty.log'
    );
    const reportPath = generateDailyReport(new Date('2026-10-01'), fixturePath);
    expect(reportPath).not.toBeNull();
    if (reportPath) {
      expect(fs.existsSync(reportPath)).toBe(true);
      const content = fs.readFileSync(reportPath, 'utf-8');
      expect(content).toContain('BANKNIFTY 45-DTE Short Strangle (Hedged) Daily Trade Report');
      expect(content).toContain('Intraday MTM Statistics (from Append-Only Log)');
      expect(content).toContain('**Short CE:** Strike 53000');
      expect(content).toContain('**Long CE Hedge:** Strike 53800');
    }
  });
});
