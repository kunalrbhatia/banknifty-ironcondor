import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { sendAlert } from '../notifier.js';

export class ModeManager {
  private static instance: ModeManager;
  private paperPath = path.resolve(process.cwd(), '.paper');
  private killPath = path.resolve(process.cwd(), '.kill-banknifty');
  private panicPath = path.resolve(process.cwd(), '.panic-banknifty');

  private constructor() {}

  public static getInstance(): ModeManager {
    if (!ModeManager.instance) {
      ModeManager.instance = new ModeManager();
    }
    return ModeManager.instance;
  }

  // Soft pause (§1.6, §2.3): blocks new BANKNIFTY entries only. Live SL/PT/15-DTE monitor is NOT touched.
  public isKill(): boolean {
    return fs.existsSync(this.killPath);
  }

  public setKill(enable: boolean): void {
    if (enable) {
      fs.writeFileSync(this.killPath, 'KILL_ACTIVE');
      sendAlert(
        '🛑 Soft pause (.kill-banknifty) ACTIVATED. New entries paused. Active positions remain monitored.'
      );
    } else {
      if (fs.existsSync(this.killPath)) fs.unlinkSync(this.killPath);
      sendAlert('▶️ Soft pause (.kill-banknifty) DEACTIVATED. New entries resumed.');
    }
  }

  // Hard stop (§1.6, §2.3): stops everything, immediately forces panic exit of all 4 legs
  public isPanic(): boolean {
    return fs.existsSync(this.panicPath);
  }

  public setPanic(enable: boolean): void {
    if (enable) {
      fs.writeFileSync(this.panicPath, 'PANIC_ACTIVE');
      sendAlert(
        '🚨🚨 HARD STOP (.panic-banknifty) ACTIVATED! Halting operations, open position will force-close immediately!',
        true
      );
    } else {
      if (fs.existsSync(this.panicPath)) fs.unlinkSync(this.panicPath);
      sendAlert('✅ HARD STOP (.panic-banknifty) CLEARED.');
    }
  }

  // Paper trading switch
  public isPaper(): boolean {
    return fs.existsSync(this.paperPath);
  }

  public setPaper(enable: boolean): void {
    if (enable) {
      fs.writeFileSync(this.paperPath, 'PAPER_MODE');
      logger.info('Paper mode enabled (.paper created)');
    } else {
      if (fs.existsSync(this.paperPath)) fs.unlinkSync(this.paperPath);
      logger.info('Paper mode disabled (.paper deleted) -> LIVE TRADING');
    }
  }
}

export const modeManager = ModeManager.getInstance();
