import { getFirebaseIdToken } from './firebase-cloud.js';

export async function parseBillingResponse(response) {
  const responseText = await response.text();
  let result = {};
  if (responseText) {
    try {
      const parsed = JSON.parse(responseText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) result = parsed;
    } catch {
      if (!response.ok) {
        const detail = response.status === 404
          ? 'The billing API route was not found. Check that /api is routed to the backend.'
          : response.status >= 500
            ? 'The backend returned an unexpected response. Check its deployment and server logs.'
            : 'The backend returned an unexpected response. Please retry.';
        throw new Error(`Billing request failed (HTTP ${response.status}). ${detail}`);
      }
      throw new Error(`The billing service returned an invalid response (HTTP ${response.status}).`);
    }
  }
  if (!response.ok) {
    const error = new Error(typeof result.error === 'string' && result.error
      ? result.error
      : `Billing request failed (HTTP ${response.status}).`);
    if (typeof result.code === 'string') error.code = result.code;
    throw error;
  }
  return result;
}

async function billingRequest(path, user, options = {}) {
  const token = await getFirebaseIdToken(user);
  const response = await fetch(`/api/billing/${path}`, {
    method: options.method || 'GET',
    cache: 'no-store',
    headers: {
      authorization: 'Bearer ' + token,
      ...(options.body ? { 'content-type': 'application/json' } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  return parseBillingResponse(response);
}

export async function loadBillingConfig() {
  const response = await fetch('/api/billing/config', { cache: 'no-store' });
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const availability = response.ok
      ? 'returned an unexpected non-JSON response'
      : `is unavailable (HTTP ${response.status})`;
    throw new Error(`The billing service ${availability}. Check that the backend is running and /api is routed to it.`);
  }

  const config = await response.json();
  if (!response.ok) throw new Error(config.error || 'Could not load paid plan configuration.');
  return config;
}

export async function loadBillingActivity(user) {
  const result = await billingRequest('activity', user);
  return result.activity;
}

export async function loadBillingPayments(user) {
  const result = await billingRequest('payments', user);
  return result.payments;
}

export async function requestBillingRefundReview(user, paymentId, reason = '') {
  return billingRequest('refunds/request', user, {
    method: 'POST',
    body: { paymentId, reason }
  });
}

export async function loadBillingEntitlement(user) {
  const result = await billingRequest('entitlement', user);
  return result.entitlement;
}

export async function redeemBillingVoucher(user, code) {
  return billingRequest('vouchers/redeem', user, {
    method: 'POST',
    body: { code }
  });
}

export async function createBillingSubscription(user, planKey, currency, expectedAmount) {
  return billingRequest('subscriptions', user, {
    method: 'POST',
    body: { planKey, currency, expectedAmount }
  });
}

export async function scheduleBillingPlanChange(user, planKey) {
  return billingRequest('change-plan', user, {
    method: 'POST',
    body: { planKey }
  });
}

export async function verifyBillingCheckout(user, checkoutResponse) {
  return billingRequest('verify', user, {
    method: 'POST',
    body: {
      razorpayPaymentId: checkoutResponse.razorpay_payment_id,
      razorpaySubscriptionId: checkoutResponse.razorpay_subscription_id,
      razorpaySignature: checkoutResponse.razorpay_signature
    }
  });
}

export async function cancelBillingSubscription(user, subscriptionId = '', reason = '') {
  return billingRequest('cancel', user, {
    method: 'POST',
    body: {
      ...(subscriptionId ? { subscriptionId } : {}),
      ...(reason ? { reason } : {})
    }
  });
}
