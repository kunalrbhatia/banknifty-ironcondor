import { executeRequest } from './api.js';
import { ANGEL_API_ENDPOINTS } from './constants.js';
import { getActiveSession } from './login.js';
import { modeManager } from './modeManager.js';
import { env } from '../config/env.js';
import { logger } from './logger.js';
import { sendAlert } from '../notifier.js';

export interface OrderRequest {
  variety: string;
  tradingsymbol: string;
  symboltoken: string;
  transactiontype: 'BUY' | 'SELL';
  exchange: 'NFO';
  ordertype: 'MARKET' | 'LIMIT';
  producttype: 'CARRYFORWARD';
  duration: 'DAY';
  price: string;
  quantity: string;
}

export interface OrderResult {
  success: boolean;
  orderId: string;
  ltp: number;
}

/**
 * §2.4: Non-idempotent order placement.
 * Order placement is EXCLUDED from generic auto-retry to prevent duplicate orders.
 */
export async function placeOrder(order: OrderRequest): Promise<OrderResult> {
  if (modeManager.isPaper()) {
    const mockId = `PAPER_BN_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    logger.info(
      `[PAPER ORDER] ${order.transactiontype} ${order.quantity} x ${order.tradingsymbol} -> ID: ${mockId}`
    );
    return {
      success: true,
      orderId: mockId,
      ltp: parseFloat(order.price) || 120.0,
    };
  }

  const session = getActiveSession();
  if (!session) {
    throw new Error('Active session required to place orders.');
  }

  logger.info(
    `Placing real order: ${order.transactiontype} ${order.quantity} of ${order.tradingsymbol}`
  );

  try {
    const res = await executeRequest(ANGEL_API_ENDPOINTS.ORDER_PLACE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MACAddress': 'fe80::1',
        'X-PrivateKey': env.API_KEY,
        Authorization: `Bearer ${session.jwtToken}`,
      },
      data: order,
      isIdempotent: false, // Critical §2.4: prevents blind auto-retries on mutations
    });

    if (res.data && res.data.status && res.data.data) {
      return {
        success: true,
        orderId: res.data.data.orderid,
        ltp: parseFloat(order.price) || 0,
      };
    } else {
      const errMsg = `Order rejected: ${res.data?.message || JSON.stringify(res.data)}`;
      logger.error(errMsg);
      sendAlert(`🚨 ${errMsg}`, true);
      return { success: false, orderId: '', ltp: 0 };
    }
  } catch (err: any) {
    logger.error(`Exception during order placement: ${err.message}`);
    sendAlert(`🚨 Order exception for ${order.tradingsymbol}: ${err.message}`, true);
    return { success: false, orderId: '', ltp: 0 };
  }
}
