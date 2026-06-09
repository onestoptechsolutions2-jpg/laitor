'use strict';

/**
 * @module marketplace/payment
 * @description M-Pesa Daraja API integration for WhatsApp marketplace payments.
 *
 * Required env vars:
 *   MPESA_CONSUMER_KEY        - Safaricom Daraja app consumer key
 *   MPESA_CONSUMER_SECRET     - Daraja app consumer secret
 *   MPESA_SHORTCODE           - Paybill or Till number
 *   MPESA_PASSKEY             - LipaNaMpesa online passkey
 *   MPESA_CALLBACK_URL        - Public URL for Daraja callback (your VPS URL)
 *   MPESA_ENV                 - 'sandbox' | 'production' (default: sandbox)
 *
 * Flow:
 *   1. initiateStkPush()  → Daraja sends payment prompt to customer's phone
 *   2. Customer enters PIN
 *   3. Daraja POSTs to MPESA_CALLBACK_URL/api/v1/mpesa/callback
 *   4. handleCallback() processes result → updates order payment_status
 */

const axios  = require('axios');
const { query } = require('../../models/db');
const logger = require('../../utils/logger');

const ENV       = process.env.MPESA_ENV || 'sandbox';
const BASE_URL  = ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

const isConfigured = () =>
  !!(process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_SECRET &&
     process.env.MPESA_SHORTCODE     && process.env.MPESA_PASSKEY);

// ── Auth ──────────────────────────────────────────────────────────────────────

let _tokenCache     = null;
let _tokenExpiresAt = 0;

const getAccessToken = async () => {
  if (_tokenCache && Date.now() < _tokenExpiresAt) return _tokenCache;

  const creds = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');

  const res = await axios.get(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${creds}` },
    timeout: 10000,
  });

  _tokenCache     = res.data.access_token;
  _tokenExpiresAt = Date.now() + (parseInt(res.data.expires_in) - 60) * 1000;
  return _tokenCache;
};

// ── STK Push ──────────────────────────────────────────────────────────────────

/**
 * Initiate M-Pesa STK push (Lipa Na M-Pesa Online).
 * @param {object} params
 * @param {string} params.phone       - Customer phone in 254XXXXXXXXX format
 * @param {number} params.amount      - Amount in KES (integers only for M-Pesa)
 * @param {number} params.orderId     - Local order ID (for reference)
 * @param {string} [params.accountRef] - Account reference shown on customer's phone
 * @param {string} [params.description] - Transaction description
 * @returns {Promise<{success: boolean, checkoutRequestId?: string, message: string}>}
 */
const initiateStkPush = async ({ phone, amount, orderId, accountRef, description }) => {
  if (!isConfigured()) {
    logger.warn('M-Pesa: not configured — returning mock response');
    return { success: false, message: 'M-Pesa not configured. Use manual payment.' };
  }

  try {
    const token     = await getAccessToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password  = Buffer.from(
      `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
    ).toString('base64');

    const callbackUrl = process.env.MPESA_CALLBACK_URL ||
      `https://your-domain.com/api/v1/mpesa/callback`;

    const body = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password:          password,
      Timestamp:         timestamp,
      TransactionType:   'CustomerPayBillOnline',
      Amount:            Math.ceil(parseFloat(amount)),
      PartyA:            phone,
      PartyB:            process.env.MPESA_SHORTCODE,
      PhoneNumber:       phone,
      CallBackURL:       callbackUrl,
      AccountReference:  accountRef || `LAI-ORD-${orderId}`,
      TransactionDesc:   description || `Laitor Order #${orderId}`,
    };

    const res = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      body,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );

    const data = res.data;
    if (data.ResponseCode === '0') {
      logger.info('M-Pesa: STK push sent', {
        orderId, phone,
        checkoutRequestId: data.CheckoutRequestID,
      });
      return {
        success:           true,
        checkoutRequestId: data.CheckoutRequestID,
        merchantRequestId: data.MerchantRequestID,
        message:           data.CustomerMessage || 'Payment prompt sent to your phone.',
      };
    }
    logger.warn('M-Pesa: STK push failed', { orderId, data });
    return { success: false, message: data.errorMessage || 'STK push failed' };
  } catch (err) {
    logger.error('M-Pesa: initiateStkPush error', { orderId, error: err.message });
    return { success: false, message: 'Payment service error. Try again.' };
  }
};

/**
 * Query STK push transaction status.
 * @param {string} checkoutRequestId
 * @returns {Promise<object>}
 */
const queryStkStatus = async (checkoutRequestId) => {
  if (!isConfigured()) return { ResultCode: -1, ResultDesc: 'Not configured' };
  try {
    const token     = await getAccessToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password  = Buffer.from(
      `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
    ).toString('base64');

    const res = await axios.post(
      `${BASE_URL}/mpesa/stkpushquery/v1/query`,
      {
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password:          password,
        Timestamp:         timestamp,
        CheckoutRequestID: checkoutRequestId,
      },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
    );
    return res.data;
  } catch (err) {
    logger.warn('M-Pesa: queryStkStatus failed', { error: err.message });
    return { ResultCode: -1, ResultDesc: err.message };
  }
};

/**
 * Process Daraja STK callback (POST from Safaricom).
 * Updates order payment_status + logs mpesa_transaction.
 * @param {object} body - raw callback body from Safaricom
 * @returns {Promise<{orderId: number|null, success: boolean}>}
 */
const handleCallback = async (body) => {
  try {
    const stk = body?.Body?.stkCallback;
    if (!stk) return { orderId: null, success: false };

    const checkoutRequestId = stk.CheckoutRequestID;
    const resultCode        = stk.ResultCode;
    const resultDesc        = stk.ResultDesc;

    // Find order by checkoutRequestId
    const orderRes = await query(
      `SELECT id, total FROM marketplace_orders WHERE mpesa_checkout_id = $1`,
      [checkoutRequestId]
    );
    const order = orderRes.rows[0];

    let amount = null, receipt = null, phone = null, txDate = null;
    if (resultCode === 0) {
      const items = stk.CallbackMetadata?.Item || [];
      const find  = (name) => items.find(i => i.Name === name)?.Value;
      amount  = find('Amount');
      receipt = find('MpesaReceiptNumber');
      phone   = String(find('PhoneNumber') || '');
      txDate  = String(find('TransactionDate') || '');
    }

    // Log transaction
    await query(
      `INSERT INTO mpesa_transactions
         (order_id, checkout_request_id, merchant_request_id,
          result_code, result_desc, amount, receipt_number, transaction_date, phone, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        order?.id || null,
        checkoutRequestId,
        stk.MerchantRequestID,
        resultCode,
        resultDesc,
        amount,
        receipt,
        txDate,
        phone,
        JSON.stringify(body),
      ]
    );

    if (order && resultCode === 0) {
      await query(
        `UPDATE marketplace_orders
         SET payment_status = 'paid', mpesa_receipt = $1, amount_paid = $2,
             status = 'confirmed', updated_at = NOW()
         WHERE id = $3`,
        [receipt, amount, order.id]
      );
      logger.info('M-Pesa: payment confirmed', { orderId: order.id, receipt, amount });
      return { orderId: order.id, success: true, receipt, amount };
    }

    if (order) {
      logger.warn('M-Pesa: payment failed/cancelled', { orderId: order.id, resultCode, resultDesc });
    }
    return { orderId: order?.id || null, success: false, resultCode, resultDesc };
  } catch (err) {
    logger.error('M-Pesa: handleCallback error', { error: err.message });
    return { orderId: null, success: false };
  }
};

module.exports = { isConfigured, initiateStkPush, queryStkStatus, handleCallback };
