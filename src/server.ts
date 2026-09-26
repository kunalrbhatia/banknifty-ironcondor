import express from 'express';
import { bankNiftyPositionStore } from './store/positionStore.js';
import { modeManager } from './helpers/modeManager.js';
import { getISTTimestamp } from './helpers/logger.js';

export function createServer() {
  const app = express();

  app.get('/health', (_req, res) => {
    const pos = bankNiftyPositionStore.getPosition();
    res.json({
      status: 'UP',
      strategy: 'BANKNIFTY 45-DTE Delta-Hedged Short Strangle',
      timeIST: getISTTimestamp(),
      modes: {
        paper: modeManager.isPaper(),
        kill: modeManager.isKill(),
        panic: modeManager.isPanic(),
      },
      position: pos
        ? {
            status: pos.status,
            expiry: pos.expiryDate,
            shortCE: { strike: pos.shortCE.strike, entryLTP: pos.shortCE.entryLTP },
            shortPE: { strike: pos.shortPE.strike, entryLTP: pos.shortPE.entryLTP },
            longCE: { strike: pos.longCE.strike, entryLTP: pos.longCE.entryLTP },
            longPE: { strike: pos.longPE.strike, entryLTP: pos.longPE.entryLTP },
            entryCreditRupees: pos.entryCreditRupees,
            slAmount: pos.slAmount,
            ptAmount: pos.ptAmount,
            dte15Date: pos.dte15Date,
          }
        : null,
    });
  });

  return app;
}
