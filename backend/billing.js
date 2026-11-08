import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const BILLING_PLANS = Object.freeze({
  monthly: Object.freeze({
    id: 'monthly',
    label: 'Pro Monthly',
    amount: 9900,
    currency: 'INR',
    period: 'monthly',
    interval: 1,
    totalCount: 1200
  }),
  yearly: Object.freeze({
    id: 'yearly',
    label: 'Pro Yearly',
    amount: 39900,
    currency: 'INR',
    period: 'yearly',
    interval: 1,
    totalCount: 100
  })
});

export const BILLING_CURRENCY_PLANS = Object.freeze({
  INR: BILLING_PLANS,
  USD: Object.freeze({
    monthly: Object.freeze({
      ...BILLING_PLANS.monthly,
      id: 'monthly-usd',
      amount: 367,
      currency: 'USD'
    }),
    yearly: Object.freeze({
      ...BILLING_PLANS.yearly,
      id: 'yearly-usd',
      amount: 4937,
      currency: 'USD'
    })
  })
});

export function billingPlan(planKey, currency = 'INR') {
  if (!Object.hasOwn(BILLING_CURRENCY_PLANS, currency) || !Object.hasOwn(BILLING_PLANS, planKey)) return null;
  return BILLING_CURRENCY_PLANS[currency][planKey];
}

export function billingPlanEnvKey(planKey, currency = 'INR') {
  if (!Object.hasOwn(BILLING_PLANS, planKey) || !Object.hasOwn(BILLING_CURRENCY_PLANS, currency)) return null;
  return `RAZORPAY_PLAN_${planKey.toUpperCase()}${currency === 'INR' ? '' : `_${currency}`}_ID`;
}

function normalizeEnvString(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function isRazorpayPlanId(value) {
  return typeof value === 'string' && value.trim().startsWith('plan_') && value.trim().length > 'plan_'.length;
}

export function billingCurrencyConfigured(currency, env = process.env) {
  return Object.hasOwn(BILLING_CURRENCY_PLANS, currency)
    && Object.keys(BILLING_PLANS).every(planKey => {
      const envKey = billingPlanEnvKey(planKey, currency);
      return isRazorpayPlanId(normalizeEnvString(env[envKey]));
    });
}

export function validRazorpaySignature(message, signature, secret) {
  if (typeof message !== 'string' || typeof signature !== 'string' || !secret) return false;
  const expected = createHmac('sha256', secret).update(message).digest();
  let provided;
  try {
    provided = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function validWebhookSignature(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let provided;
  try {
    provided = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function planMatchesRazorpay(plan, expected) {
  return plan?.id
    && plan.item?.amount === expected.amount
    && plan.item?.currency === expected.currency
    && plan.period === expected.period
    && plan.interval === expected.interval;
}

export function firebaseAdminConfigured(env = process.env) {
  const serviceAccountJson = normalizeEnvString(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (typeof serviceAccountJson !== 'string') return false;
  try {
    const serviceAccount = JSON.parse(serviceAccountJson);
    return serviceAccount.type === 'service_account'
      && typeof serviceAccount.project_id === 'string'
      && typeof serviceAccount.client_email === 'string'
      && typeof serviceAccount.private_key === 'string';
  } catch {
    return false;
  }
}

export function configuredVouchers(env = process.env) {
  const vouchersJson = normalizeEnvString(env.PRO_VOUCHERS_JSON);
  if (typeof vouchersJson !== 'string') return null;
  try {
    const vouchers = JSON.parse(vouchersJson);
    if (!Array.isArray(vouchers) || vouchers.length === 0) return null;
    const codes = new Set();
    for (const voucher of vouchers) {
      if (!voucher || typeof voucher.code !== 'string'
        || !/^[A-Z0-9][A-Z0-9-]{5,39}$/.test(voucher.code)
        || codes.has(voucher.code)
        || !Number.isInteger(voucher.durationDays) || voucher.durationDays < 1 || voucher.durationDays > 3650
        || !Number.isInteger(voucher.maxRedemptions) || voucher.maxRedemptions < 1 || voucher.maxRedemptions > 1_000_000) {
        return null;
      }
      codes.add(voucher.code);
    }
    return vouchers;
  } catch {
    return null;
  }
}

export function voucherDocumentId(code) {
  return createHash('sha256').update(code).digest('hex');
}

export function planKeyForRazorpayPlanId(planId, env = process.env) {
  for (const currency of Object.keys(BILLING_CURRENCY_PLANS)) {
    const planKey = Object.keys(BILLING_PLANS).find(key => normalizeEnvString(env[billingPlanEnvKey(key, currency)]) === planId);
    if (planKey) return planKey;
  }
  return null;
}

export function currencyForRazorpayPlanId(planId, env = process.env) {
  return Object.keys(BILLING_CURRENCY_PLANS).find(currency => (
    Object.keys(BILLING_PLANS).some(key => normalizeEnvString(env[billingPlanEnvKey(key, currency)]) === planId)
  )) || null;
}

export function entitlementFromSubscription(subscription, fallbackPlan = 'monthly', now = Date.now()) {
  const validUntil = Number(subscription?.current_end) * 1000;
  const planId = subscription?.notes?.plan_key || fallbackPlan;
  if (!Number.isFinite(validUntil) || validUntil <= 0
    || !Object.hasOwn(BILLING_PLANS, planId)) {
    return null;
  }

  return {
    planId: 'pro',
    billingPlan: planId,
    status: validUntil > now ? 'active' : 'expired',
    source: 'server-verified',
    validUntil
  };
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

export function billingConfigured(env = process.env) {
  const billingEnabled = parseBoolean(normalizeEnvString(env.BILLING_ENABLED));
  const keyId = normalizeEnvString(env.RAZORPAY_KEY_ID);
  const keySecret = normalizeEnvString(env.RAZORPAY_KEY_SECRET);
  const webhookSecret = normalizeEnvString(env.RAZORPAY_WEBHOOK_SECRET);
  const monthlyPlanId = normalizeEnvString(env.RAZORPAY_PLAN_MONTHLY_ID);
  const yearlyPlanId = normalizeEnvString(env.RAZORPAY_PLAN_YEARLY_ID);

  if (!billingEnabled
    || ![keyId, keySecret, webhookSecret, monthlyPlanId, yearlyPlanId]
      .every(value => typeof value === 'string' && value.length > 0)
    || ![monthlyPlanId, yearlyPlanId].every(isRazorpayPlanId)
    || !firebaseAdminConfigured(env)) {
    return false;
  }

  const isTestKey = keyId.startsWith('rzp_test_');
  if (isTestKey) {
    if (env.VERCEL_ENV === 'preview') {
      return parseBoolean(normalizeEnvString(env.BILLING_TEST_MODE_ENABLED));
    }

    const isLocalDevelopment = (env.VERCEL !== '1' && !env.VERCEL_ENV)
      || (env.VERCEL === '1' && env.VERCEL_ENV === 'development');
    return isLocalDevelopment && parseBoolean(normalizeEnvString(env.BILLING_LOCAL_TEST_MODE_ENABLED));
  }
  if (env.VERCEL_ENV === 'preview') return false;

  return parseBoolean(normalizeEnvString(env.BILLING_TERMS_PUBLISHED))
    && parseBoolean(normalizeEnvString(env.BILLING_REFUNDS_PUBLISHED))
    && parseBoolean(normalizeEnvString(env.BILLING_TEST_MODE_VERIFIED))
    && parseBoolean(normalizeEnvString(env.BILLING_LIVE_LAUNCH_APPROVED));
}
