import WebSocket from 'ws';
import { getActiveSession } from './login.js';
import { modeManager } from './modeManager.js';
import { bankNiftyPositionStore } from '../store/positionStore.js';
import { logger } from './logger.js';
import { ANGEL_API_ENDPOINTS } from './constants.js';
import { appendMtmLog, StrangleHedgeLegs } from './mtmLogger.js';
import { evaluateExitConditions } from '../jobs/exitMonitor.js';

class WebSocketManager {
  private ws: WebSocket | null = null;
  private isConnecting: boolean = false;
  private timer: NodeJS.Timeout | null = null;

  // Cached LTPs for the 4 legs
  private lastShortCeLtp: number = 0;
  private lastShortPeLtp: number = 0;
  private lastLongCeLtp: number = 0;
  private lastLongPeLtp: number = 0;

  public start(): void {
    if (this.timer) clearInterval(this.timer);

    if (modeManager.isPaper()) {
      logger.info('WebSocket running in MOCK mode for paper trading.');
      this.timer = setInterval(() => this.simulatePaperTick(), 10000); // every 10s
      return;
    }

    this.connect();
  }

  private connect(): void {
    const session = getActiveSession();
    if (!session || !bankNiftyPositionStore.hasOpenPosition()) {
      return;
    }

    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) return;

    this.isConnecting = true;
    const wsUrl = ANGEL_API_ENDPOINTS.WS_STREAM;

    try {
      this.ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${session.jwtToken}`,
          'x-api-key': process.env.API_KEY || '',
          'x-client-code': session.userId,
          'x-feed-token': session.feedToken,
        },
      });

      this.ws.on('open', () => {
        this.isConnecting = false;
        logger.info('Angel One WebSocket connected for BANKNIFTY.');
        this.subscribeOpenPosition();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (err) => {
        logger.error(`WebSocket error: ${err.message}`);
      });

      this.ws.on('close', () => {
        this.isConnecting = false;
        logger.warn('WebSocket closed. Reconnecting in 5 seconds...');
        setTimeout(() => this.connect(), 5000);
      });
    } catch (err: any) {
      this.isConnecting = false;
      logger.error(`WebSocket connection failed: ${err.message}`);
    }
  }

  public subscribeOpenPosition(): void {
    const pos = bankNiftyPositionStore.getPosition();
    if (!pos || pos.status !== 'OPEN' || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const request = {
      action: 1, // Subscribe
      params: {
        mode: 1, // LTP
        tokenList: [
          {
            exchangeType: 2, // NFO
            tokens: [pos.shortCE.token, pos.shortPE.token, pos.longCE.token, pos.longPE.token],
          },
        ],
      },
    };

    this.ws.send(JSON.stringify(request));
    logger.info(
      `Subscribed WebSocket to 4 BANKNIFTY tokens: shortCE=${pos.shortCE.token}, shortPE=${pos.shortPE.token}, longCE=${pos.longCE.token}, longPE=${pos.longPE.token}`
    );
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const str = data.toString();
      if (str.startsWith('{')) {
        const parsed = JSON.parse(str);
        if (parsed.token && parsed.last_traded_price) {
          this.updateTick(parsed.token, parsed.last_traded_price / 100);
        }
      }
    } catch (err: any) {
      logger.debug(`Error parsing WS frame: ${err.message}`);
    }
  }

  public updateTick(token: string, ltp: number): void {
    const pos = bankNiftyPositionStore.getPosition();
    if (!pos || pos.status !== 'OPEN') return;

    if (token === pos.shortCE.token) {
      this.lastShortCeLtp = ltp;
      pos.shortCE.currentLTP = ltp;
    } else if (token === pos.shortPE.token) {
      this.lastShortPeLtp = ltp;
      pos.shortPE.currentLTP = ltp;
    } else if (token === pos.longCE.token) {
      this.lastLongCeLtp = ltp;
      pos.longCE.currentLTP = ltp;
    } else if (token === pos.longPE.token) {
      this.lastLongPeLtp = ltp;
      pos.longPE.currentLTP = ltp;
    }

    if (
      this.lastShortCeLtp > 0 &&
      this.lastShortPeLtp > 0 &&
      this.lastLongCeLtp > 0 &&
      this.lastLongPeLtp > 0
    ) {
      const legs: StrangleHedgeLegs = {
        shortCE: { strike: pos.shortCE.strike, ltp: this.lastShortCeLtp },
        shortPE: { strike: pos.shortPE.strike, ltp: this.lastShortPeLtp },
        longCE: { strike: pos.longCE.strike, ltp: this.lastLongCeLtp },
        longPE: { strike: pos.longPE.strike, ltp: this.lastLongPeLtp },
      };

      appendMtmLog(
        new Date(),
        legs,
        pos.entryCreditRupees,
        pos.lotSize,
        pos.slAmount,
        pos.ptAmount
      );

      evaluateExitConditions({
        shortCE: this.lastShortCeLtp,
        shortPE: this.lastShortPeLtp,
        longCE: this.lastLongCeLtp,
        longPE: this.lastLongPeLtp,
      });
    }
  }

  private simulatePaperTick(): void {
    const pos = bankNiftyPositionStore.getPosition();
    if (!pos || pos.status !== 'OPEN') return;

    // Small random walk for mock testing
    const deltaShortCe = (Math.random() - 0.52) * 4;
    const deltaShortPe = (Math.random() - 0.52) * 4;
    const deltaLongCe = (Math.random() - 0.52) * 2;
    const deltaLongPe = (Math.random() - 0.52) * 2;

    this.lastShortCeLtp = Math.max(
      1,
      (pos.shortCE.currentLTP || pos.shortCE.entryLTP) + deltaShortCe
    );
    this.lastShortPeLtp = Math.max(
      1,
      (pos.shortPE.currentLTP || pos.shortPE.entryLTP) + deltaShortPe
    );
    this.lastLongCeLtp = Math.max(
      0.5,
      (pos.longCE.currentLTP || pos.longCE.entryLTP) + deltaLongCe
    );
    this.lastLongPeLtp = Math.max(
      0.5,
      (pos.longPE.currentLTP || pos.longPE.entryLTP) + deltaLongPe
    );

    pos.shortCE.currentLTP = this.lastShortCeLtp;
    pos.shortPE.currentLTP = this.lastShortPeLtp;
    pos.longCE.currentLTP = this.lastLongCeLtp;
    pos.longPE.currentLTP = this.lastLongPeLtp;

    const legs: StrangleHedgeLegs = {
      shortCE: { strike: pos.shortCE.strike, ltp: this.lastShortCeLtp },
      shortPE: { strike: pos.shortPE.strike, ltp: this.lastShortPeLtp },
      longCE: { strike: pos.longCE.strike, ltp: this.lastLongCeLtp },
      longPE: { strike: pos.longPE.strike, ltp: this.lastLongPeLtp },
    };

    appendMtmLog(new Date(), legs, pos.entryCreditRupees, pos.lotSize, pos.slAmount, pos.ptAmount);

    evaluateExitConditions({
      shortCE: this.lastShortCeLtp,
      shortPE: this.lastShortPeLtp,
      longCE: this.lastLongCeLtp,
      longPE: this.lastLongPeLtp,
    });
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export const webSocketManager = new WebSocketManager();
