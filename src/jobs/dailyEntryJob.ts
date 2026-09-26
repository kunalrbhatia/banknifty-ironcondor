import { bankNiftyPositionStore, BankNiftyPositionState } from '../store/positionStore.js';
import {
  fetchAndCacheScripMaster,
  loadCachedScrips,
  extractLotSizes,
  verifyLotSizeOrBlock,
  resolveMonthlyExpiries,
  ScripItem,
} from '../helpers/scripMaster.js';
import {
  isTradingDay,
  calculateDTE,
  getAdjusted15DteDate,
  getAdjustedTargetDteDate,
} from '../helpers/holidayCheck.js';
import { fetchLTP, fetchMultipleLTPs } from '../helpers/marketData.js';
import { placeOrder } from '../helpers/orders.js';
import { modeManager } from '../helpers/modeManager.js';
import { INDEX_CONFIGS } from '../helpers/constants.js';
import { env } from '../config/env.js';
import { logger, getISTTimestamp, getISTDateString } from '../helpers/logger.js';
import { sendAlert } from '../notifier.js';
import { exitIronCondorPosition } from './exitMonitor.js';
import { webSocketManager } from '../helpers/websocket.js';
import {
  bsPrice,
  bsDelta,
  impliedVol,
  pickNearestDeltaStrike,
  DeltaStrikeOption,
} from '../helpers/blackScholes.js';

export async function runDailyJob(): Promise<void> {
  logger.info('--- Running BANKNIFTY 15:00 IST Entry / DTE Check Job ---');

  const today = new Date();
  if (!isTradingDay(today)) {
    logger.info('Today is not an NSE trading day. Skipping job.');
    return;
  }

  // Hard stop active? (§1.6, §2.3)
  if (modeManager.isPanic()) {
    logger.warn(
      'Panic mode active (.panic-banknifty)! Checking if open position requires squareoff.'
    );
    if (bankNiftyPositionStore.hasOpenPosition()) {
      const pos = bankNiftyPositionStore.getPosition()!;
      await exitIronCondorPosition('PANIC', {
        shortCE: pos.shortCE.currentLTP || pos.shortCE.entryLTP,
        shortPE: pos.shortPE.currentLTP || pos.shortPE.entryLTP,
        longCE: pos.longCE.currentLTP || pos.longCE.entryLTP,
        longPE: pos.longPE.currentLTP || pos.longPE.entryLTP,
      });
    }
    return;
  }

  // Step 1: Check existing position
  const openPosition = bankNiftyPositionStore.getPosition();
  if (openPosition && openPosition.status === 'OPEN') {
    logger.info(
      'Open BANKNIFTY position detected. Skipping entry evaluation, proceeding to 15-DTE hard-exit check.'
    );

    const todayStr = getISTDateString(today);
    if (todayStr === openPosition.dte15Date) {
      logger.warn(`Today (${todayStr}) is the 15-DTE hard-exit date! Triggering exit per §1.3.1.`);
      const [shortCeLtp, shortPeLtp, longCeLtp, longPeLtp] = await Promise.all([
        fetchLTP('NFO', openPosition.shortCE.symbol, openPosition.shortCE.token),
        fetchLTP('NFO', openPosition.shortPE.symbol, openPosition.shortPE.token),
        fetchLTP('NFO', openPosition.longCE.symbol, openPosition.longCE.token),
        fetchLTP('NFO', openPosition.longPE.symbol, openPosition.longPE.token),
      ]);
      await exitIronCondorPosition('15DTE', {
        shortCE: shortCeLtp,
        shortPE: shortPeLtp,
        longCE: longCeLtp,
        longPE: longPeLtp,
      });
    } else {
      logger.info(
        `Open position 15-DTE exit date is ${openPosition.dte15Date}. Position continues monitoring.`
      );
    }
    return;
  }

  // Soft pause check (§1.6, §2.3)
  if (modeManager.isKill()) {
    logger.info('Soft pause (.kill-banknifty) is ACTIVE. Skipping new entry evaluation.');
    return;
  }

  // Step 2: Resolve scrip master & verify lot size (§2.10)
  let scrips: ScripItem[] = loadCachedScrips();
  if (scrips.length === 0) {
    scrips = await fetchAndCacheScripMaster();
  }

  const lotSizes = extractLotSizes(scrips, ['BANKNIFTY']);
  const derivedLotSize = lotSizes['BANKNIFTY'] || INDEX_CONFIGS.BANKNIFTY.defaultLotSize;
  const configuredLotSize = env.LOT_SIZE;

  const lotValid = verifyLotSizeOrBlock('BANKNIFTY', derivedLotSize, configuredLotSize);
  if (!lotValid) {
    logger.error(
      `Entry blocked due to lot size discrepancy (scrip: ${derivedLotSize}, config: ${configuredLotSize}).`
    );
    return;
  }

  // Step 3: Expiry resolution & DTE Check (§1, Step 1)
  const monthlyExpiries = resolveMonthlyExpiries(scrips, 'BANKNIFTY');
  if (monthlyExpiries.length === 0) {
    logger.error('Could not resolve monthly expiries for BANKNIFTY from scrip master.');
    return;
  }

  // Find candidate monthly expiry around 45 DTE
  let candidateExpiryStr: string | null = null;
  let candidateDTE: number = -1;

  for (const expStr of monthlyExpiries) {
    const expDate = new Date(expStr);
    const dte = calculateDTE(today, expDate);
    if (
      dte >= env.TARGET_DTE - env.ENTRY_DTE_WINDOW &&
      dte <= env.TARGET_DTE + env.ENTRY_DTE_WINDOW
    ) {
      candidateExpiryStr = expStr;
      candidateDTE = dte;
      break;
    }
  }

  logger.info(`Candidate BANKNIFTY monthly expiry: ${candidateExpiryStr}, DTE: ${candidateDTE}`);

  if (!candidateExpiryStr) {
    logger.info(
      `No monthly expiry within ${env.TARGET_DTE}±${env.ENTRY_DTE_WINDOW} DTE. No entry action required today.`
    );
    return;
  }

  // Anchor entry date rolled back to nearest previous trading day (§1.3.1)
  const targetEntryDate = getAdjustedTargetDteDate(new Date(candidateExpiryStr), env.TARGET_DTE);
  const targetEntryStr = getISTDateString(targetEntryDate);
  if (getISTDateString(today) < targetEntryStr) {
    logger.info(
      `Target entry date for ${candidateExpiryStr} is ${targetEntryStr} (target ${env.TARGET_DTE} DTE). No entry action required today.`
    );
    return;
  }

  // Confirmed entry day!
  logger.info(
    `🎯 Confirmed entry day for BANKNIFTY ${candidateExpiryStr} (current DTE: ${candidateDTE}). Scanning options chain & Black-Scholes deltas.`
  );

  // Step 4: Fetch Spot LTP
  const spotLTP = await fetchLTP(
    'NSE',
    INDEX_CONFIGS.BANKNIFTY.spotSymbol,
    INDEX_CONFIGS.BANKNIFTY.spotToken
  );
  logger.info(`BANKNIFTY Spot LTP: ${spotLTP}`);

  // Filter option chain contracts for this candidate expiry
  const expiryContracts = scrips.filter(
    (s) =>
      s.exch_seg === 'NFO' &&
      s.name === 'BANKNIFTY' &&
      s.instrumenttype === 'OPTIDX' &&
      s.expiry === candidateExpiryStr
  );

  if (expiryContracts.length === 0) {
    logger.error(`No option contracts found for BANKNIFTY expiry ${candidateExpiryStr}`);
    return;
  }

  // Pull live LTP for all CE/PE strikes
  const tokensToFetch = expiryContracts.map((c) => ({
    exchange: 'NFO',
    token: c.token,
  }));
  const ltpMap = await fetchMultipleLTPs(tokensToFetch);

  // Calculate Black-Scholes IV and Delta per strike/side
  const T = Math.max(0.001, candidateDTE / 365);
  const r = env.RISK_FREE_RATE;

  const ceOptions: DeltaStrikeOption[] = [];
  const peOptions: DeltaStrikeOption[] = [];

  for (const c of expiryContracts) {
    const rawStrike = parseFloat(c.strike) / 100;
    const isCall = c.symbol.endsWith('CE');
    let ltp = ltpMap.get(c.token);

    if (ltp === undefined || isNaN(ltp) || ltp <= 0) {
      if (modeManager.isPaper()) {
        // Fallback synthetic model for paper mode simulation
        const syntheticIV = 0.16;
        ltp = bsPrice(spotLTP, rawStrike, T, r, syntheticIV, isCall);
      } else {
        continue;
      }
    }

    const finalLtp: number = ltp;
    const iv = impliedVol(finalLtp, spotLTP, rawStrike, T, r, isCall);
    const delta = bsDelta(spotLTP, rawStrike, T, r, iv, isCall);

    const opt: DeltaStrikeOption = {
      strike: rawStrike,
      delta,
      ltp: finalLtp,
      iv,
      token: c.token,
      symbol: c.symbol,
    };

    if (isCall) {
      ceOptions.push(opt);
    } else {
      peOptions.push(opt);
    }
  }

  if (ceOptions.length === 0 || peOptions.length === 0) {
    logger.error('Failed to compute option chain deltas. Entry aborted.');
    return;
  }

  // Step 5: Strike selection
  // Short strikes: closest to ~30 delta (0.30)
  const shortCE = pickNearestDeltaStrike(ceOptions, env.SHORT_TARGET_DELTA, true);
  const shortPE = pickNearestDeltaStrike(peOptions, env.SHORT_TARGET_DELTA, false);

  // Hedge target delta: midpoint of [HEDGE_TARGET_DELTA_MIN, HEDGE_TARGET_DELTA_MAX] -> 0.16
  const hedgeTarget = (env.HEDGE_TARGET_DELTA_MIN + env.HEDGE_TARGET_DELTA_MAX) / 2;
  const longCE = pickNearestDeltaStrike(ceOptions, hedgeTarget, true);
  const longPE = pickNearestDeltaStrike(peOptions, hedgeTarget, false);

  logger.info(
    `Selected Strikes:\n  Short CE: ${shortCE.strike} (Δ: ${shortCE.delta.toFixed(3)}, LTP: ${shortCE.ltp.toFixed(2)})\n  Short PE: ${shortPE.strike} (Δ: ${shortPE.delta.toFixed(3)}, LTP: ${shortPE.ltp.toFixed(2)})\n  Long CE Hedge: ${longCE.strike} (Δ: ${longCE.delta.toFixed(3)}, LTP: ${longCE.ltp.toFixed(2)})\n  Long PE Hedge: ${longPE.strike} (Δ: ${longPE.delta.toFixed(3)}, LTP: ${longPE.ltp.toFixed(2)})`
  );

  // Sanity check: Hedge strikes must be further OTM than shorts (§1)
  if (longCE.strike <= shortCE.strike) {
    const msg = `🚨 Delta hedge sanity check failed: Long CE (${longCE.strike}) <= Short CE (${shortCE.strike}). Inverted call spread! Entry blocked.`;
    logger.error(msg);
    await sendAlert(msg, true);
    return;
  }

  if (longPE.strike >= shortPE.strike) {
    const msg = `🚨 Delta hedge sanity check failed: Long PE (${longPE.strike}) >= Short PE (${shortPE.strike}). Inverted put spread! Entry blocked.`;
    logger.error(msg);
    await sendAlert(msg, true);
    return;
  }

  // Risk:Reward check: max loss vs net credit (§1 Step 2)
  const netCreditPerUnit = shortCE.ltp + shortPE.ltp - (longCE.ltp + longPE.ltp);
  const totalNetCredit = netCreditPerUnit * configuredLotSize;
  const callWingWidth = longCE.strike - shortCE.strike;
  const putWingWidth = shortPE.strike - longPE.strike;
  const maxLossPerUnit = Math.max(callWingWidth, putWingWidth) - netCreditPerUnit;
  const rrRatio = maxLossPerUnit / (netCreditPerUnit > 0 ? netCreditPerUnit : 1);

  logger.info(
    `Risk:Reward check -> Net Credit: ₹${totalNetCredit.toFixed(2)}, Wing Widths (CE: ${callWingWidth}, PE: ${putWingWidth}), Max Loss: ₹${(maxLossPerUnit * configuredLotSize).toFixed(2)}, R:R Ratio: 1:${rrRatio.toFixed(2)}`
  );

  // Step 6: Phased Order placement (§1 Step 3, §1.2)
  // Phase 1: Buy long CE + long PE hedge legs FIRST
  logger.info('Phase 1: Placing BUY orders for hedge legs (longCE, longPE)...');
  const buyLongCeOrder = placeOrder({
    variety: 'NORMAL',
    tradingsymbol: longCE.symbol,
    symboltoken: longCE.token,
    transactiontype: 'BUY',
    exchange: 'NFO',
    ordertype: 'MARKET',
    producttype: 'CARRYFORWARD',
    duration: 'DAY',
    price: '0',
    quantity: configuredLotSize.toString(),
  });

  const buyLongPeOrder = placeOrder({
    variety: 'NORMAL',
    tradingsymbol: longPE.symbol,
    symboltoken: longPE.token,
    transactiontype: 'BUY',
    exchange: 'NFO',
    ordertype: 'MARKET',
    producttype: 'CARRYFORWARD',
    duration: 'DAY',
    price: '0',
    quantity: configuredLotSize.toString(),
  });

  const [resLongCE, resLongPE] = await Promise.all([buyLongCeOrder, buyLongPeOrder]);

  // Partial fill handling on hedge legs (§1.2):
  // If either hedge fails, unwind the filled hedge leg and abort entry completely.
  if (!resLongCE.success && !resLongPE.success) {
    logger.error('Both hedge leg orders failed. Entry aborted.');
    await sendAlert('🚨 Both hedge orders failed to fill. Entry aborted.', true);
    return;
  }

  if (resLongCE.success && !resLongPE.success) {
    logger.error('Partial fill: Long CE hedge filled but Long PE failed! Unwinding Long CE...');
    await sendAlert(
      '🚨 Partial fill on hedges: Long CE filled, Long PE failed. Unwinding Long CE.',
      true
    );
    await placeOrder({
      variety: 'NORMAL',
      tradingsymbol: longCE.symbol,
      symboltoken: longCE.token,
      transactiontype: 'SELL',
      exchange: 'NFO',
      ordertype: 'MARKET',
      producttype: 'CARRYFORWARD',
      duration: 'DAY',
      price: '0',
      quantity: configuredLotSize.toString(),
    });
    return;
  }

  if (!resLongCE.success && resLongPE.success) {
    logger.error('Partial fill: Long PE hedge filled but Long CE failed! Unwinding Long PE...');
    await sendAlert(
      '🚨 Partial fill on hedges: Long PE filled, Long CE failed. Unwinding Long PE.',
      true
    );
    await placeOrder({
      variety: 'NORMAL',
      tradingsymbol: longPE.symbol,
      symboltoken: longPE.token,
      transactiontype: 'SELL',
      exchange: 'NFO',
      ordertype: 'MARKET',
      producttype: 'CARRYFORWARD',
      duration: 'DAY',
      price: '0',
      quantity: configuredLotSize.toString(),
    });
    return;
  }

  logger.info('Hedges confirmed filled! Proceeding to Phase 2: Selling short CE and short PE...');

  // Phase 2: Sell short CE + short PE together
  const sellShortCeOrder = placeOrder({
    variety: 'NORMAL',
    tradingsymbol: shortCE.symbol,
    symboltoken: shortCE.token,
    transactiontype: 'SELL',
    exchange: 'NFO',
    ordertype: 'MARKET',
    producttype: 'CARRYFORWARD',
    duration: 'DAY',
    price: '0',
    quantity: configuredLotSize.toString(),
  });

  const sellShortPeOrder = placeOrder({
    variety: 'NORMAL',
    tradingsymbol: shortPE.symbol,
    symboltoken: shortPE.token,
    transactiontype: 'SELL',
    exchange: 'NFO',
    ordertype: 'MARKET',
    producttype: 'CARRYFORWARD',
    duration: 'DAY',
    price: '0',
    quantity: configuredLotSize.toString(),
  });

  const [resShortCE, resShortPE] = await Promise.all([sellShortCeOrder, sellShortPeOrder]);

  // Partial fill handling on short legs (§1.2):
  // If one or both shorts fail, unwind filled short leg AND both hedge legs to avoid carrying an unintended 3-leg position.
  if (!resShortCE.success || !resShortPE.success) {
    logger.error(
      'Short legs placement failed or partially filled! Unwinding entire attempted structure per §1.2...'
    );
    await sendAlert(
      `🚨 Short legs failed! shortCE: ${resShortCE.success}, shortPE: ${resShortPE.success}. Unwinding all filled legs...`,
      true
    );

    const unwindPromises = [];
    if (resShortCE.success) {
      unwindPromises.push(
        placeOrder({
          variety: 'NORMAL',
          tradingsymbol: shortCE.symbol,
          symboltoken: shortCE.token,
          transactiontype: 'BUY',
          exchange: 'NFO',
          ordertype: 'MARKET',
          producttype: 'CARRYFORWARD',
          duration: 'DAY',
          price: '0',
          quantity: configuredLotSize.toString(),
        })
      );
    }
    if (resShortPE.success) {
      unwindPromises.push(
        placeOrder({
          variety: 'NORMAL',
          tradingsymbol: shortPE.symbol,
          symboltoken: shortPE.token,
          transactiontype: 'BUY',
          exchange: 'NFO',
          ordertype: 'MARKET',
          producttype: 'CARRYFORWARD',
          duration: 'DAY',
          price: '0',
          quantity: configuredLotSize.toString(),
        })
      );
    }
    // Unwind both hedge legs
    unwindPromises.push(
      placeOrder({
        variety: 'NORMAL',
        tradingsymbol: longCE.symbol,
        symboltoken: longCE.token,
        transactiontype: 'SELL',
        exchange: 'NFO',
        ordertype: 'MARKET',
        producttype: 'CARRYFORWARD',
        duration: 'DAY',
        price: '0',
        quantity: configuredLotSize.toString(),
      })
    );
    unwindPromises.push(
      placeOrder({
        variety: 'NORMAL',
        tradingsymbol: longPE.symbol,
        symboltoken: longPE.token,
        transactiontype: 'SELL',
        exchange: 'NFO',
        ordertype: 'MARKET',
        producttype: 'CARRYFORWARD',
        duration: 'DAY',
        price: '0',
        quantity: configuredLotSize.toString(),
      })
    );

    await Promise.all(unwindPromises);
    return;
  }

  // Step 7: Post-entry snapshot (§1 Step 4, §1.3)
  const finalShortCeLtp = resShortCE.ltp || shortCE.ltp;
  const finalShortPeLtp = resShortPE.ltp || shortPE.ltp;
  const finalLongCeLtp = resLongCE.ltp || longCE.ltp;
  const finalLongPeLtp = resLongPE.ltp || longPE.ltp;

  const entryCreditRupees =
    (finalShortCeLtp + finalShortPeLtp - (finalLongCeLtp + finalLongPeLtp)) * configuredLotSize;
  const slAmount = entryCreditRupees; // 100% of credit received
  const ptAmount = entryCreditRupees * (env.PT_PCT_OF_CREDIT / 100); // 50% of credit received

  const expiryDateObj = new Date(candidateExpiryStr!);
  const dte15DateObj = getAdjusted15DteDate(expiryDateObj);
  const dte15DateStr = getISTDateString(dte15DateObj);

  const positionState: BankNiftyPositionState = {
    index: 'BANKNIFTY',
    status: 'OPEN',
    entryTimestamp: getISTTimestamp(),
    expiryDate: candidateExpiryStr!,
    dteAtEntry: candidateDTE,
    lotSize: configuredLotSize,
    shortCE: {
      symbol: shortCE.symbol,
      token: shortCE.token,
      strike: shortCE.strike,
      optionType: 'CE',
      side: 'SELL',
      qty: configuredLotSize,
      entryLTP: finalShortCeLtp,
      currentLTP: finalShortCeLtp,
      targetDelta: shortCE.delta,
    },
    shortPE: {
      symbol: shortPE.symbol,
      token: shortPE.token,
      strike: shortPE.strike,
      optionType: 'PE',
      side: 'SELL',
      qty: configuredLotSize,
      entryLTP: finalShortPeLtp,
      currentLTP: finalShortPeLtp,
      targetDelta: shortPE.delta,
    },
    longCE: {
      symbol: longCE.symbol,
      token: longCE.token,
      strike: longCE.strike,
      optionType: 'CE',
      side: 'BUY',
      qty: configuredLotSize,
      entryLTP: finalLongCeLtp,
      currentLTP: finalLongCeLtp,
      targetDelta: longCE.delta,
    },
    longPE: {
      symbol: longPE.symbol,
      token: longPE.token,
      strike: longPE.strike,
      optionType: 'PE',
      side: 'BUY',
      qty: configuredLotSize,
      entryLTP: finalLongPeLtp,
      currentLTP: finalLongPeLtp,
      targetDelta: longPE.delta,
    },
    entryCreditRupees,
    slAmount,
    ptAmount,
    dte15Date: dte15DateStr,
  };

  bankNiftyPositionStore.savePosition(positionState);

  const successMsg = `🎉 BANKNIFTY 45-DTE Delta-Hedged Short Strangle Entered!\nExpiry: ${candidateExpiryStr}\nShort CE: ${shortCE.strike} @ ${finalShortCeLtp.toFixed(2)} | Short PE: ${shortPE.strike} @ ${finalShortPeLtp.toFixed(2)}\nLong CE: ${longCE.strike} @ ${finalLongCeLtp.toFixed(2)} | Long PE: ${longPE.strike} @ ${finalLongPeLtp.toFixed(2)}\nNet Credit Received: ₹${entryCreditRupees.toFixed(2)}\nSL (100%): ₹${slAmount.toFixed(2)}\nPT (50%): ₹${ptAmount.toFixed(2)}\n15-DTE Hard Exit Date: ${dte15DateStr}`;
  logger.info(successMsg);
  await sendAlert(successMsg);

  // Start continuous WebSocket monitoring
  webSocketManager.start();
}
