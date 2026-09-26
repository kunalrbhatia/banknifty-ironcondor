import fs from 'fs';
import path from 'path';
import { getISTDateString, getISTTimestamp } from '../helpers/logger.js';

export interface LegMtmData {
  strike: number;
  ltp: number;
}

export interface StrangleHedgeLegs {
  shortCE: LegMtmData;
  shortPE: LegMtmData;
  longCE: LegMtmData;
  longPE: LegMtmData;
}

/**
 * §1.7 Line format (exact):
 * {ISO8601 IST timestamp} | BANKNIFTY | shortCE={strike}@{ltp} | shortPE={strike}@{ltp} | longCE={strike}@{ltp} | longPE={strike}@{ltp} | netCredit={netCredit} | unrealizedPnL={unrealizedPnL} | pctOfSL={pctOfSL} | pctOfPT={pctOfPT}
 */
export function formatMtmLogLine(
  date: Date,
  legs: StrangleHedgeLegs,
  entryCreditRupees: number,
  lotSize: number,
  slAmount: number,
  ptAmount: number
): string {
  const currentNetCredit =
    (legs.shortCE.ltp + legs.shortPE.ltp - (legs.longCE.ltp + legs.longPE.ltp)) * lotSize;
  const unrealizedPnL = entryCreditRupees - currentNetCredit;
  const pctOfSL = (Math.max(0, -unrealizedPnL) / slAmount) * 100;
  const pctOfPT = (Math.max(0, unrealizedPnL) / ptAmount) * 100;

  const ts = getISTTimestamp(date);
  return `${ts} | BANKNIFTY | shortCE=${legs.shortCE.strike}@${legs.shortCE.ltp.toFixed(2)} | shortPE=${legs.shortPE.strike}@${legs.shortPE.ltp.toFixed(2)} | longCE=${legs.longCE.strike}@${legs.longCE.ltp.toFixed(2)} | longPE=${legs.longPE.strike}@${legs.longPE.ltp.toFixed(2)} | netCredit=${currentNetCredit.toFixed(2)} | unrealizedPnL=${unrealizedPnL.toFixed(2)} | pctOfSL=${pctOfSL.toFixed(1)} | pctOfPT=${pctOfPT.toFixed(1)}`;
}

export function appendMtmLog(
  date: Date,
  legs: StrangleHedgeLegs,
  entryCreditRupees: number,
  lotSize: number,
  slAmount: number,
  ptAmount: number
): void {
  const mtmDir = path.resolve(process.cwd(), 'logs', 'mtm');
  if (!fs.existsSync(mtmDir)) {
    fs.mkdirSync(mtmDir, { recursive: true });
  }

  const dateStr = getISTDateString(date);
  const logFilePath = path.resolve(mtmDir, `mtm-BANKNIFTY-${dateStr}.log`);

  const line = formatMtmLogLine(date, legs, entryCreditRupees, lotSize, slAmount, ptAmount);
  fs.appendFileSync(logFilePath, line + '\n', 'utf-8');
}
