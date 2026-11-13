import { getFirebaseIdToken } from './firebase-cloud.js';
import { clearSessionCache, readSessionCache, writeSessionCache } from './session-cache.js';

const BILLING_ENTITLEMENT_CACHE_TTL_MS = 5 * 60 * 1000;
const BILLING_CONFIG_CACHE_TTL_MS = 10 * 60 * 1000;
const entitlementRequests = new Map();
const entitlementCacheGenerations = new Map();
let billingConfigRequest = null;

function validServerEntitlement(entitlement) {
  return Boolean(
    entitlement
    && entitlement.source === 'server-verified'
    && ['active', 'inactive'].includes(entitlement.status)
    && typeof entitlement.planId === 'string'
    && Number.isFinite(entitlement.validUntil)
  );
}

export function getCachedBillingEntitlement(user) {
  if (!user?.uid) return null;
  const cached = readSessionCache('billing-entitlement', user.uid, BILLING_ENTITLEMENT_CACHE_TTL_MS);
  if (cached?.status === 'active' && cached.validUntil <= Date.now()) {
    clearBillingEntitlementCache(user);
    return null;
  }
  return validServerEntitlement(cached) ? cached : null;
}

export function clearBillingEntitlementCache(user) {
  if (user?.uid) {
    entitlementCacheGenerations.set(user.uid, (entitlementCacheGenerations.get(user.uid) || 0) + 1);
    clearSessionCache('billing-entitlement', user.uid);
  }
}

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
  const mutating = (options.method || 'GET') !== 'GET';
  if (mutating) clearBillingEntitlementCache(user);
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
  const result = await parseBillingResponse(response);
  if (mutating) clearBillingEntitlementCache(user);
  return result;
}

export async function loadBillingConfig({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = readSessionCache('billing-config', '', BILLING_CONFIG_CACHE_TTL_MS);
    if (cached) return cached;
    if (billingConfigRequest) return billingConfigRequest;
  }
  const request = (async () => {
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
    writeSessionCache('billing-config', '', config);
    return config;
  })();
  billingConfigRequest = request;
  try {
    return await request;
  } finally {
    if (billingConfigRequest === request) billingConfigRequest = null;
  }
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

export async function loadBillingEntitlement(user, { forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = getCachedBillingEntitlement(user);
    if (cached) return cached;
  }
  if (!user?.uid) throw new Error('Sign in before checking plan access.');
  if (entitlementRequests.has(user.uid)) return entitlementRequests.get(user.uid);
  const generation = entitlementCacheGenerations.get(user.uid) || 0;
  const request = (async () => {
    const result = await billingRequest('entitlement', user);
    if (validServerEntitlement(result.entitlement)
      && (entitlementCacheGenerations.get(user.uid) || 0) === generation) {
      writeSessionCache('billing-entitlement', user.uid, result.entitlement);
    }
    return result.entitlement;
  })();
  entitlementRequests.set(user.uid, request);
  try {
    return await request;
  } finally {
    if (entitlementRequests.get(user.uid) === request) entitlementRequests.delete(user.uid);
  }
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
