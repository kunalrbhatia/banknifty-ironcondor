import fs from 'fs';
import path from 'path';
import { logger } from '../helpers/logger.js';

export interface PositionLeg {
  symbol: string;
  token: string;
  strike: number;
  optionType: 'CE' | 'PE';
  side: 'SELL' | 'BUY';
  qty: number;
  entryLTP: number;
  currentLTP?: number;
  targetDelta?: number;
}

export interface BankNiftyPositionState {
  index: 'BANKNIFTY';
  status: 'OPEN' | 'CLOSED';
  entryTimestamp: string;
  expiryDate: string; // e.g. '29OCT2026'
  dteAtEntry: number;
  lotSize: number;

  // 4 Legs: Short CE/PE (~30 delta), Long CE/PE (~15-17 delta hedge)
  shortCE: PositionLeg;
  shortPE: PositionLeg;
  longCE: PositionLeg;
  longPE: PositionLeg;

  // Immutable entry values (§1.3, §2.1)
  entryCreditRupees: number; // ((shortCE + shortPE) - (longCE + longPE)) * lotSize
  slAmount: number; // 100% of entry credit received
  ptAmount: number; // 50% of entry credit received
  dte15Date: string; // Expiry - 15 calendar days adjusted for holidays

  // Exit snapshot
  exitTimestamp?: string;
  exitReason?: 'SL' | 'PT' | '15DTE' | 'PANIC' | 'PARTIAL_ABORT';
  realizedPnL?: number;
  exitShortCELtp?: number;
  exitShortPELtp?: number;
  exitLongCELtp?: number;
  exitLongPELtp?: number;
}

export class BankNiftyPositionStore {
  private filePath: string;

  constructor() {
    const dataDir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.filePath = path.resolve(dataDir, 'banknifty-position.json');
  }

  public getPosition(): BankNiftyPositionState | null {
    if (!fs.existsSync(this.filePath)) {
      return null;
    }
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      return data as BankNiftyPositionState;
    } catch (e: any) {
      logger.error(`Failed to read banknifty-position.json: ${e.message}`);
      return null;
    }
  }

  public hasOpenPosition(): boolean {
    const pos = this.getPosition();
    return pos !== null && pos.status === 'OPEN';
  }

  public savePosition(position: BankNiftyPositionState): void {
    fs.writeFileSync(this.filePath, JSON.stringify(position, null, 2), 'utf-8');
    logger.info(`BANKNIFTY position saved to ${this.filePath}`);
  }

  /**
   * §2.1: Before closing or clearing, never erase critical historical values.
   * Mark status CLOSED and keep the record for audit / report inspection.
   */
  public closePosition(
    reason: 'SL' | 'PT' | '15DTE' | 'PANIC' | 'PARTIAL_ABORT',
    exitLTPs: { shortCE: number; shortPE: number; longCE: number; longPE: number },
    realizedPnL: number,
    exitTimestamp: string
  ): void {
    const pos = this.getPosition();
    if (!pos) return;

    pos.status = 'CLOSED';
    pos.exitReason = reason;
    pos.exitShortCELtp = exitLTPs.shortCE;
    pos.exitShortPELtp = exitLTPs.shortPE;
    pos.exitLongCELtp = exitLTPs.longCE;
    pos.exitLongPELtp = exitLTPs.longPE;
    pos.realizedPnL = realizedPnL;
    pos.exitTimestamp = exitTimestamp;

    fs.writeFileSync(this.filePath, JSON.stringify(pos, null, 2), 'utf-8');
    logger.info(
      `BANKNIFTY position marked CLOSED with reason: ${reason}, realizedPnL: ₹${realizedPnL.toFixed(2)}`
    );
  }
}

export const bankNiftyPositionStore = new BankNiftyPositionStore();
