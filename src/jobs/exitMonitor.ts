import { bankNiftyPositionStore } from '../store/positionStore.js';
import { placeOrder } from '../helpers/orders.js';
import { modeManager } from '../helpers/modeManager.js';
import { logger, getISTTimestamp } from '../helpers/logger.js';
import { sendAlert } from '../notifier.js';
import { webSocketManager } from '../helpers/websocket.js';

export interface ExitLTPs {
  shortCE: number;
  shortPE: number;
  longCE: number;
  longPE: number;
}

/**
 * §1.3: Exit all 4 legs together — buy-to-cover both shorts, sell-to-close both hedges.
 */
export async function exitIronCondorPosition(
  reason: 'SL' | 'PT' | '15DTE' | 'PANIC',
  currentLTPs: ExitLTPs
): Promise<void> {
  const pos = bankNiftyPositionStore.getPosition();
  if (!pos || pos.status !== 'OPEN') {
    logger.warn('No open BANKNIFTY position found to exit.');
    return;
  }

  logger.info(`🚨 Initiating exit for BANKNIFTY 4-leg position. Reason: ${reason}`);

  // Exit all 4 legs: BUY to close short CE & PE, SELL to close long CE & PE hedges
  const buyShortCePromise = placeOrder({
    variety: 'NORMAL',
    tradingsymbol: pos.shortCE.symbol,
    symboltoken: pos.shortCE.token,
    transactiontype: 'BUY',
    exchange: 'NFO',
    ordertype: 'MARKET',
    producttype: 'CARRYFORWARD',
    duration: 'DAY',
    price: '0',
    quantity: pos.shortCE.qty.toString(),
  });

  const buyShortPePromise = placeOrder({
    variety: 'NORMAL',
    tradingsymbol: pos.shortPE.symbol,
    symboltoken: pos.shortPE.token,
    transactiontype: 'BUY',
    exchange: 'NFO',
    ordertype: 'MARKET',
    producttype: 'CARRYFORWARD',
    duration: 'DAY',
    price: '0',
    quantity: pos.shortPE.qty.toString(),
  });

  const sellLongCePromise = placeOrder({
    variety: 'NORMAL',
    tradingsymbol: pos.longCE.symbol,
    symboltoken: pos.longCE.token,
    transactiontype: 'SELL',
    exchange: 'NFO',
    ordertype: 'MARKET',
    producttype: 'CARRYFORWARD',
    duration: 'DAY',
    price: '0',
    quantity: pos.longCE.qty.toString(),
  });

  const sellLongPePromise = placeOrder({
    variety: 'NORMAL',
    tradingsymbol: pos.longPE.symbol,
    symboltoken: pos.longPE.token,
    transactiontype: 'SELL',
    exchange: 'NFO',
    ordertype: 'MARKET',
    producttype: 'CARRYFORWARD',
    duration: 'DAY',
    price: '0',
    quantity: pos.longPE.qty.toString(),
  });

  const [resShortCE, resShortPE, resLongCE, resLongPE] = await Promise.all([
    buyShortCePromise,
    buyShortPePromise,
    sellLongCePromise,
    sellLongPePromise,
  ]);

  const allSuccess =
    resShortCE.success && resShortPE.success && resLongCE.success && resLongPE.success;

  if (!allSuccess) {
    const errorMsg = `Partial failure while unwinding 4-leg position! shortCE: ${resShortCE.success}, shortPE: ${resShortPE.success}, longCE: ${resLongCE.success}, longPE: ${resLongPE.success}`;
    logger.error(errorMsg);
    await sendAlert(`🚨🚨 EMERGENCY: ${errorMsg}. Immediate manual intervention needed!`, true);
  }

  // Calculate realized P&L based on exit LTPs
  // Exit net debit = ((shortCE + shortPE) - (longCE + longPE)) * lotSize
  const exitNetCostRupees =
    (currentLTPs.shortCE + currentLTPs.shortPE - (currentLTPs.longCE + currentLTPs.longPE)) *
    pos.lotSize;
  const realizedPnL = pos.entryCreditRupees - exitNetCostRupees;

  bankNiftyPositionStore.closePosition(reason, currentLTPs, realizedPnL, getISTTimestamp());

  const emoji = realizedPnL >= 0 ? '🎉' : '⚠️';
  const alertMsg = `${emoji} BANKNIFTY 4-leg position exited (${reason})!\nRealized P&L: ₹${realizedPnL.toFixed(2)}\nShort CE Exit: ${currentLTPs.shortCE} | Short PE Exit: ${currentLTPs.shortPE}\nLong CE Exit: ${currentLTPs.longCE} | Long PE Exit: ${currentLTPs.longPE}`;
  logger.info(alertMsg);
  await sendAlert(alertMsg, reason === 'SL' || reason === 'PANIC');

  webSocketManager.stop();
}

/**
 * Continuous SL/PT condition check across all 4 legs (§1.3, §1.7)
 */
export async function evaluateExitConditions(currentLTPs: ExitLTPs): Promise<void> {
  // Hard stop check (§1.6, §2.3)
  if (modeManager.isPanic()) {
    logger.warn('Panic mode triggered (.panic-banknifty) -> exiting 4-leg position immediately.');
    await exitIronCondorPosition('PANIC', currentLTPs);
    return;
  }

  const pos = bankNiftyPositionStore.getPosition();
  if (!pos || pos.status !== 'OPEN') return;

  const currentNetCredit =
    (currentLTPs.shortCE + currentLTPs.shortPE - (currentLTPs.longCE + currentLTPs.longPE)) *
    pos.lotSize;
  const unrealizedPnL = pos.entryCreditRupees - currentNetCredit;

  // Stop-loss check: unrealizedLossRupees >= slAmount (100% of credit)
  if (-unrealizedPnL >= pos.slAmount) {
    logger.warn(
      `Stop Loss breached! Unrealized Loss: ₹${(-unrealizedPnL).toFixed(2)} >= SL: ₹${pos.slAmount.toFixed(2)}`
    );
    await exitIronCondorPosition('SL', currentLTPs);
    return;
  }

  // Profit target check: unrealizedProfitRupees >= ptAmount (50% of credit)
  if (unrealizedPnL >= pos.ptAmount) {
    logger.info(
      `Profit Target hit! Unrealized Profit: ₹${unrealizedPnL.toFixed(2)} >= PT: ₹${pos.ptAmount.toFixed(2)}`
    );
    await exitIronCondorPosition('PT', currentLTPs);
    return;
  }
}
