import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  billingCurrencyConfigured,
  billingPlan,
  billingPlanEnvKey,
  BILLING_CURRENCY_PLANS,
  BILLING_PLANS,
  billingCheckoutConfigured,
  billingConfigured,
  configuredVouchers,
  entitlementFromSubscription,
  firebaseAdminConfigured,
  planKeyForRazorpayPlanId,
  planMatchesRazorpay,
  currencyForRazorpayPlanId,
  validRazorpaySignature,
  validWebhookSignature,
  voucherDocumentId
} from '../backend/billing.js';

test('server billing plans use the requested monthly and yearly INR amounts', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(BILLING_PLANS).map(([key, plan]) => [key, [plan.amount, plan.currency, plan.period, plan.interval]])),
    {
      monthly: [9900, 'INR', 'monthly', 1],
      yearly: [39900, 'INR', 'yearly', 1]
    }
  );
});

test('international billing plans use the requested fixed USD prices', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(BILLING_CURRENCY_PLANS.USD).map(([key, plan]) => [key, [plan.amount, plan.currency, plan.period, plan.interval]])),
    {
      monthly: [367, 'USD', 'monthly', 1],
      yearly: [4937, 'USD', 'yearly', 1]
    }
  );
  assert.equal(billingPlan('monthly', 'USD'), BILLING_CURRENCY_PLANS.USD.monthly);
  assert.equal(billingPlan('monthly', 'EUR'), null);
});

test('Razorpay checkout signature accepts only the expected subscription and payment pair', () => {
  const secret = 'test-secret';
  const message = 'sub_123|pay_456';
  const signature = createHmac('sha256', secret).update(message).digest('hex');
  assert.equal(validRazorpaySignature(message, signature, secret), true);
  assert.equal(validRazorpaySignature('sub_other|pay_456', signature, secret), false);
  assert.equal(validRazorpaySignature(message, 'not-a-signature', secret), false);
  assert.equal(validRazorpaySignature(message, signature, ''), false);
});

test('webhook signature validates the exact raw request body', () => {
  const secret = 'webhook-secret';
  const rawBody = Buffer.from('{"event":"subscription.charged"}');
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  assert.equal(validWebhookSignature(rawBody, signature, secret), true);
  assert.equal(validWebhookSignature(Buffer.from('{"event":"subscription.cancelled"}'), signature, secret), false);
  assert.equal(validWebhookSignature('{"event":"subscription.charged"}', signature, secret), false);
});

test('Razorpay plan metadata must exactly match server-set price and billing interval', () => {
  const plan = {
    id: 'plan_monthly',
    item: { amount: 9900, currency: 'INR' },
    period: 'monthly',
    interval: 1
  };
  assert.equal(planMatchesRazorpay(plan, BILLING_PLANS.monthly), true);
  assert.equal(planMatchesRazorpay({ ...plan, item: { ...plan.item, amount: 1 } }, BILLING_PLANS.monthly), false);
  assert.equal(planMatchesRazorpay({ ...plan, period: 'yearly' }, BILLING_PLANS.monthly), false);
});

test('Razorpay plan IDs resolve only to configured billing plans', () => {
  const env = {
    RAZORPAY_PLAN_MONTHLY_ID: 'plan_monthly',
    RAZORPAY_PLAN_YEARLY_ID: 'plan_yearly',
    RAZORPAY_PLAN_MONTHLY_USD_ID: 'plan_monthly_usd',
    RAZORPAY_PLAN_YEARLY_USD_ID: 'plan_yearly_usd'
  };
  assert.equal(planKeyForRazorpayPlanId('plan_monthly', env), 'monthly');
  assert.equal(planKeyForRazorpayPlanId('plan_yearly', env), 'yearly');
  assert.equal(planKeyForRazorpayPlanId('plan_monthly_usd', env), 'monthly');
  assert.equal(currencyForRazorpayPlanId('plan_monthly_usd', env), 'USD');
  assert.equal(currencyForRazorpayPlanId('plan_yearly', env), 'INR');
  assert.equal(planKeyForRazorpayPlanId('plan_unknown', env), null);
  assert.equal(billingPlanEnvKey('monthly', 'USD'), 'RAZORPAY_PLAN_MONTHLY_USD_ID');
  assert.equal(billingCurrencyConfigured('USD', env), true);
  assert.equal(billingCurrencyConfigured('EUR', env), false);
});

test('entitlements are server verified and expire at Razorpay current_end', () => {
  const subscription = {
    current_end: 2_000,
    notes: { plan_key: 'yearly' }
  };
  const active = entitlementFromSubscription(subscription, 'monthly', 1_000_000);
  assert.equal(active.planId, 'pro');
  assert.equal(active.billingPlan, 'yearly');
  assert.equal(active.source, 'server-verified');
  assert.equal(active.validUntil, 2_000_000);
  assert.equal(active.status, 'active');
  assert.equal(entitlementFromSubscription(subscription, 'monthly', 2_000_000).status, 'expired');
  assert.equal(entitlementFromSubscription({ current_end: 0 }, 'monthly'), null);
});

test('billing stays disabled until provider, Firebase, terms and refund configuration are complete', () => {
  const env = {
    BILLING_ENABLED: 'true',
    BILLING_TERMS_PUBLISHED: 'true',
    BILLING_REFUNDS_PUBLISHED: 'true',
    BILLING_TEST_MODE_VERIFIED: 'true',
    BILLING_LIVE_LAUNCH_APPROVED: 'true',
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      type: 'service_account',
      project_id: 'test-project',
      client_email: 'billing@test-project.iam.gserviceaccount.com',
      private_key: 'test-private-key'
    }),
    RAZORPAY_KEY_ID: 'key_id',
    RAZORPAY_KEY_SECRET: 'secret',
    RAZORPAY_WEBHOOK_SECRET: 'webhook',
    RAZORPAY_PLAN_MONTHLY_ID: 'plan_monthly',
    RAZORPAY_PLAN_YEARLY_ID: 'plan_yearly',
    RAZORPAY_PLAN_MONTHLY_USD_ID: 'plan_monthly_usd',
    RAZORPAY_PLAN_YEARLY_USD_ID: 'plan_yearly_usd'
  };
  assert.equal(billingConfigured(env), true);
  assert.equal(billingConfigured({ ...env, RAZORPAY_PLAN_MONTHLY_ID: 'sub_monthly' }), false);
  assert.equal(billingConfigured({ ...env, RAZORPAY_PLAN_YEARLY_ID: 'sub_yearly' }), false);
  assert.equal(billingCheckoutConfigured({
    ...env,
    RAZORPAY_PLAN_MONTHLY_ID: 'sub_monthly',
    RAZORPAY_PLAN_YEARLY_ID: ''
  }), true);
  assert.equal(billingConfigured({ ...env, BILLING_REFUNDS_PUBLISHED: 'false' }), false);
  assert.equal(billingConfigured({ ...env, BILLING_TEST_MODE_VERIFIED: 'false' }), false);
  assert.equal(billingConfigured({ ...env, BILLING_LIVE_LAUNCH_APPROVED: 'false' }), false);
  assert.equal(billingConfigured({ ...env, RAZORPAY_KEY_SECRET: '' }), false);
});

test('Razorpay test checkout is limited to explicitly enabled Vercel Preview deployments', () => {
  const env = {
    BILLING_ENABLED: 'true',
    BILLING_TEST_MODE_ENABLED: 'true',
    VERCEL_ENV: 'preview',
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      type: 'service_account',
      project_id: 'test-project',
      client_email: 'billing@test-project.iam.gserviceaccount.com',
      private_key: 'test-private-key'
    }),
    RAZORPAY_KEY_ID: 'rzp_test_example',
    RAZORPAY_KEY_SECRET: 'test-secret',
    RAZORPAY_WEBHOOK_SECRET: 'test-webhook',
    RAZORPAY_PLAN_MONTHLY_ID: 'plan_monthly_test',
    RAZORPAY_PLAN_YEARLY_ID: 'plan_yearly_test'
  };
  assert.equal(billingConfigured(env), true);
  assert.equal(billingConfigured({ ...env, VERCEL_ENV: 'production' }), false);
  assert.equal(billingConfigured({ ...env, BILLING_TEST_MODE_ENABLED: 'false' }), false);
  assert.equal(billingConfigured({ ...env, RAZORPAY_KEY_ID: 'rzp_live_example' }), false);
  assert.equal(billingConfigured({ ...env, FIREBASE_SERVICE_ACCOUNT_JSON: '' }), false);
});

test('Razorpay test checkout can be explicitly enabled on localhost only', () => {
  const env = {
    BILLING_ENABLED: 'true',
    BILLING_LOCAL_TEST_MODE_ENABLED: 'true',
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      type: 'service_account',
      project_id: 'test-project',
      client_email: 'billing@test-project.iam.gserviceaccount.com',
      private_key: 'test-private-key'
    }),
    RAZORPAY_KEY_ID: 'rzp_test_example',
    RAZORPAY_KEY_SECRET: 'test-secret',
    RAZORPAY_WEBHOOK_SECRET: 'test-webhook',
    RAZORPAY_PLAN_MONTHLY_ID: 'plan_monthly_test',
    RAZORPAY_PLAN_YEARLY_ID: 'plan_yearly_test'
  };
  assert.equal(billingConfigured(env), true);
  assert.equal(billingConfigured({ ...env, BILLING_LOCAL_TEST_MODE_ENABLED: 'false' }), false);
  assert.equal(billingConfigured({ ...env, NODE_ENV: 'production' }), true);
  assert.equal(billingConfigured({ ...env, RAZORPAY_KEY_ID: 'rzp_live_example' }), false);
  assert.equal(billingConfigured({ ...env, VERCEL: '1', VERCEL_ENV: 'production' }), false);
  assert.equal(billingConfigured({
    ...env,
    VERCEL: '1',
    VERCEL_ENV: 'preview',
    BILLING_TEST_MODE_ENABLED: 'false'
  }), false);
});

test('Firebase Admin entitlement reads can be enabled while checkout remains disabled', () => {
  const env = {
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      type: 'service_account',
      project_id: 'test-project',
      client_email: 'billing@test-project.iam.gserviceaccount.com',
      private_key: 'test-private-key'
    })
  };
  assert.equal(firebaseAdminConfigured(env), true);
  assert.equal(billingConfigured(env), false);
  assert.equal(firebaseAdminConfigured({ FIREBASE_SERVICE_ACCOUNT_JSON: '{invalid' }), false);
});

test('billing configuration accepts common truthy environment values for checkout flags', () => {
  const env = {
    BILLING_ENABLED: 'TRUE',
    BILLING_TERMS_PUBLISHED: '1',
    BILLING_REFUNDS_PUBLISHED: 'YES',
    BILLING_TEST_MODE_VERIFIED: 'on',
    BILLING_LIVE_LAUNCH_APPROVED: 'true',
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      type: 'service_account',
      project_id: 'test-project',
      client_email: 'billing@test-project.iam.gserviceaccount.com',
      private_key: 'test-private-key'
    }),
    RAZORPAY_KEY_ID: 'rzp_live_example',
    RAZORPAY_KEY_SECRET: 'secret',
    RAZORPAY_WEBHOOK_SECRET: 'webhook',
    RAZORPAY_PLAN_MONTHLY_ID: 'plan_monthly',
    RAZORPAY_PLAN_YEARLY_ID: 'plan_yearly'
  };
  assert.equal(billingConfigured(env), true);
  assert.equal(billingConfigured({ ...env, BILLING_ENABLED: 'FALSE' }), false);
});

test('billing configuration trims hidden whitespace from Razorpay and Firebase env values', () => {
  const env = {
    BILLING_ENABLED: ' true ',
    BILLING_TERMS_PUBLISHED: ' true ',
    BILLING_REFUNDS_PUBLISHED: ' true ',
    BILLING_TEST_MODE_VERIFIED: ' true ',
    BILLING_LIVE_LAUNCH_APPROVED: ' true ',
    FIREBASE_SERVICE_ACCOUNT_JSON: ` ${JSON.stringify({
      type: 'service_account',
      project_id: 'test-project',
      client_email: 'billing@test-project.iam.gserviceaccount.com',
      private_key: 'test-private-key'
    })} `,
    RAZORPAY_KEY_ID: ' rzp_live_example ',
    RAZORPAY_KEY_SECRET: ' secret ',
    RAZORPAY_WEBHOOK_SECRET: ' webhook ',
    RAZORPAY_PLAN_MONTHLY_ID: ' plan_monthly ',
    RAZORPAY_PLAN_YEARLY_ID: ' plan_yearly '
  };
  assert.equal(billingConfigured(env), true);
  assert.equal(planKeyForRazorpayPlanId('plan_monthly', env), 'monthly');
});

test('voucher configuration validates durations and redemption settings without exposing codes in IDs', () => {
  const env = {
    PRO_VOUCHERS_JSON: JSON.stringify([
      { code: 'WELCOME30', durationDays: 30, maxRedemptions: 1 }
    ])
  };
  assert.deepEqual(configuredVouchers(env), [{ code: 'WELCOME30', durationDays: 30, maxRedemptions: 1 }]);
  assert.equal(configuredVouchers({ PRO_VOUCHERS_JSON: JSON.stringify([{ code: 'WELCOME30', durationDays: 0, maxRedemptions: 1 }]) }), null);
  assert.equal(configuredVouchers({ PRO_VOUCHERS_JSON: JSON.stringify([{ code: 'WELCOME30', durationDays: 30, maxRedemptions: 2 }]) })?.[0].maxRedemptions, 2);
  assert.equal(configuredVouchers({ PRO_VOUCHERS_JSON: JSON.stringify([{ code: 'welcome30', durationDays: 30, maxRedemptions: 1 }]) }), null);
  assert.equal(voucherDocumentId('WELCOME30'), voucherDocumentId('WELCOME30'));
  assert.notEqual(voucherDocumentId('WELCOME30'), 'WELCOME30');
});
