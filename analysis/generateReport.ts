import fs from 'fs';
import path from 'path';
import { getISTDateString } from '../src/helpers/logger.js';
import { bankNiftyPositionStore } from '../src/store/positionStore.js';
import { logger } from '../src/helpers/logger.js';

export interface ParsedMtmLine {
  timestamp: string;
  shortCEStrike: string;
  shortCELTP: number;
  shortPEStrike: string;
  shortPELTP: number;
  longCEStrike: string;
  longCELTP: number;
  longPEStrike: string;
  longPELTP: number;
  netCredit: number;
  unrealizedPnL: number;
  pctOfSL: number;
  pctOfPT: number;
}

/**
 * §1.7 Line parser:
 * {ISO8601 IST timestamp} | BANKNIFTY | shortCE={strike}@{ltp} | shortPE={strike}@{ltp} | longCE={strike}@{ltp} | longPE={strike}@{ltp} | netCredit={netCredit} | unrealizedPnL={unrealizedPnL} | pctOfSL={pctOfSL} | pctOfPT={pctOfPT}
 */
export function parseMtmLine(line: string): ParsedMtmLine | null {
  const parts = line.split('|').map((s) => s.trim());
  if (parts.length < 10) return null;

  const timestamp = parts[0];
  const shortCeMatch = line.match(/shortCE=([0-9.]+)@([0-9.]+)/);
  const shortPeMatch = line.match(/shortPE=([0-9.]+)@([0-9.]+)/);
  const longCeMatch = line.match(/longCE=([0-9.]+)@([0-9.]+)/);
  const longPeMatch = line.match(/longPE=([0-9.]+)@([0-9.]+)/);

  const netCreditMatch = line.match(/netCredit=([0-9.-]+)/);
  const pnlMatch = line.match(/unrealizedPnL=([0-9.-]+)/);
  const slMatch = line.match(/pctOfSL=([0-9.]+)/);
  const ptMatch = line.match(/pctOfPT=([0-9.]+)/);

  if (!netCreditMatch || !pnlMatch) return null;

  return {
    timestamp,
    shortCEStrike: shortCeMatch ? shortCeMatch[1] : 'N/A',
    shortCELTP: shortCeMatch ? parseFloat(shortCeMatch[2]) : 0,
    shortPEStrike: shortPeMatch ? shortPeMatch[1] : 'N/A',
    shortPELTP: shortPeMatch ? parseFloat(shortPeMatch[2]) : 0,
    longCEStrike: longCeMatch ? longCeMatch[1] : 'N/A',
    longCELTP: longCeMatch ? parseFloat(longCeMatch[2]) : 0,
    longPEStrike: longPeMatch ? longPeMatch[1] : 'N/A',
    longPELTP: longPeMatch ? parseFloat(longPeMatch[2]) : 0,
    netCredit: parseFloat(netCreditMatch[1]),
    unrealizedPnL: parseFloat(pnlMatch[1]),
    pctOfSL: slMatch ? parseFloat(slMatch[1]) : 0,
    pctOfPT: ptMatch ? parseFloat(ptMatch[1]) : 0,
  };
}

/**
 * §1.8: Daily trade report generated from the append-only MTM log file.
 */
export function generateDailyReport(
  date: Date = new Date(),
  fixtureFilePath?: string
): string | null {
  const dateStr = getISTDateString(date);
  const mtmFilePath =
    fixtureFilePath || path.resolve(process.cwd(), 'logs', 'mtm', `mtm-BANKNIFTY-${dateStr}.log`);

  if (!fs.existsSync(mtmFilePath)) {
    logger.info(`No MTM log found at ${mtmFilePath}. Skipping daily report generation.`);
    return null;
  }

  const rawLines = fs
    .readFileSync(mtmFilePath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  if (rawLines.length === 0) {
    logger.info('MTM log file is empty. Skipping daily report.');
    return null;
  }

  const parsedLines: ParsedMtmLine[] = [];
  for (const line of rawLines) {
    const parsed = parseMtmLine(line);
    if (parsed) parsedLines.push(parsed);
  }

  if (parsedLines.length === 0) {
    logger.warn('No valid MTM log lines could be parsed.');
    return null;
  }

  const firstEntry = parsedLines[0];
  const lastEntry = parsedLines[parsedLines.length - 1];

  let minPnL = Infinity;
  let maxPnL = -Infinity;
  for (const entry of parsedLines) {
    if (entry.unrealizedPnL < minPnL) minPnL = entry.unrealizedPnL;
    if (entry.unrealizedPnL > maxPnL) maxPnL = entry.unrealizedPnL;
  }

  const positionSnapshot = bankNiftyPositionStore.getPosition();
  const exitStatus = positionSnapshot?.status === 'CLOSED' ? positionSnapshot.exitReason : 'OPEN';

  const reportMarkdown = `# BANKNIFTY 45-DTE Short Strangle (Hedged) Daily Trade Report - ${dateStr}

## Overview & Leg Structure
- **Instrument:** BANKNIFTY (Monthly Options)
- **Status:** ${exitStatus}
- **Expiry:** ${positionSnapshot?.expiryDate || 'N/A'}
- **Lot Size:** ${positionSnapshot?.lotSize || 30}
- **Short CE:** Strike ${firstEntry.shortCEStrike}
- **Short PE:** Strike ${firstEntry.shortPEStrike}
- **Long CE Hedge:** Strike ${firstEntry.longCEStrike}
- **Long PE Hedge:** Strike ${firstEntry.longPEStrike}
- **Entry Net Credit Received:** ₹${positionSnapshot?.entryCreditRupees.toFixed(2) || 'N/A'}
- **SL Threshold (100% of Credit):** ₹${positionSnapshot?.slAmount.toFixed(2) || 'N/A'}
- **PT Threshold (50% of Credit):** ₹${positionSnapshot?.ptAmount.toFixed(2) || 'N/A'}
- **15-DTE Hard Exit Date:** ${positionSnapshot?.dte15Date || 'N/A'}

## Intraday MTM Statistics (from Append-Only Log)
- **Total Ticks Logged:** ${parsedLines.length}
- **Opening LTPs:**
  - Short CE: ₹${firstEntry.shortCELTP} | Short PE: ₹${firstEntry.shortPELTP}
  - Long CE: ₹${firstEntry.longCELTP} | Long PE: ₹${firstEntry.longPELTP}
- **Latest / Closing LTPs:**
  - Short CE: ₹${lastEntry.shortCELTP} | Short PE: ₹${lastEntry.shortPELTP}
  - Long CE: ₹${lastEntry.longCELTP} | Long PE: ₹${lastEntry.longPELTP}
- **Closing Net Credit:** ₹${lastEntry.netCredit.toFixed(2)}
- **Closing Unrealized P&L:** ₹${lastEntry.unrealizedPnL.toFixed(2)}
- **Intraday P&L High:** ₹${maxPnL.toFixed(2)}
- **Intraday P&L Low (Max Drawdown):** ₹${minPnL.toFixed(2)}
- **Current SL Consumed:** ${lastEntry.pctOfSL.toFixed(1)}%
- **Current PT Progress:** ${lastEntry.pctOfPT.toFixed(1)}%
${positionSnapshot?.status === 'CLOSED' ? `- **Exit Details:** Closed via **${positionSnapshot.exitReason}** at ${positionSnapshot.exitTimestamp} with Realized P&L: ₹${positionSnapshot.realizedPnL?.toFixed(2)}` : ''}

---
_Generated automatically at 15:40 IST based on \`${path.basename(mtmFilePath)}\`_
`;

  const reportsDir = path.resolve(process.cwd(), 'analysis', 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const reportPath = path.resolve(reportsDir, `${dateStr}-banknifty-strangle.md`);
  fs.writeFileSync(reportPath, reportMarkdown, 'utf-8');
  logger.info(`Report successfully generated: ${reportPath}`);

  return reportPath;
}

// Allow direct CLI invocation or CI smoke test
if (process.argv.includes('--run') || process.argv.includes('--fixture')) {
  const isFixture = process.argv.includes('--fixture');
  const fixturePath = isFixture
    ? path.resolve(process.cwd(), 'tests', 'fixtures', 'fixture-mtm-banknifty.log')
    : undefined;
  generateDailyReport(new Date(), fixturePath);
}
