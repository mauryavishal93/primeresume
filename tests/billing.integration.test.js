import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { voucherDocumentId } from '../backend/billing.js';
import { adminEmails, app, normalizeAdminEmail } from '../backend/server.js';

const environment = {
  BILLING_ENABLED: 'true',
  BILLING_TERMS_PUBLISHED: 'true',
  BILLING_REFUNDS_PUBLISHED: 'true',
  BILLING_TEST_MODE_VERIFIED: 'true',
  BILLING_LIVE_LAUNCH_APPROVED: 'true',
  ADMIN_EMAILS: 'mauryavishal93@gmail.com',
  FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: 'service_account',
    project_id: 'test-project',
    client_email: 'billing@test-project.iam.gserviceaccount.com',
    private_key: 'test-private-key'
  }),
  RAZORPAY_KEY_ID: 'test_key_id',
  RAZORPAY_KEY_SECRET: 'test_key_secret',
  RAZORPAY_WEBHOOK_SECRET: 'test_webhook_secret',
  RAZORPAY_PLAN_MONTHLY_ID: 'plan_monthly_test',
  RAZORPAY_PLAN_YEARLY_ID: 'plan_yearly_test',
  RAZORPAY_PLAN_MONTHLY_USD_ID: 'plan_monthly_usd_test',
  RAZORPAY_PLAN_YEARLY_USD_ID: 'plan_yearly_usd_test',
  PRO_VOUCHERS_JSON: JSON.stringify([
    { code: 'WELCOME30', durationDays: 30, maxRedemptions: 20 },
    { code: 'LIMITED7', durationDays: 7, maxRedemptions: 2 }
  ])
};
const previousEnvironment = Object.fromEntries(
  Object.keys(environment).map(key => [key, process.env[key]])
);

test('admin email allow list normalizes accidental duplicate @ characters and whitespace', () => {
  process.env.ADMIN_EMAILS = ' mauryavishal93@@gmail.com , admin@example.com  ';
  assert.equal(normalizeAdminEmail('mauryavishal93@@gmail.com'), 'mauryavishal93@gmail.com');
  assert.deepEqual(adminEmails(), ['mauryavishal93@gmail.com', 'admin@example.com']);
});

function createFakeDatabase() {
  const records = new Map();
  const reference = key => ({
    key,
    id: key.split('/').at(-1),
    get: async () => snapshot(key),
    set: async (data, options = {}) => {
      records.set(key, options.merge ? { ...records.get(key), ...data } : data);
    }
  });
  const snapshot = key => ({
    exists: records.has(key),
    data: () => records.get(key)
  });
  const db = {
    collection: name => ({
      doc: id => reference(`${name}/${id || `generated-${records.size + 1}`}`),
      where: (field, operator, value) => ({
        get: async () => ({
          docs: [...records.entries()]
            .filter(([key, data]) => key.startsWith(`${name}/`)
              && key.split('/').length === 2
              && operator === '=='
              && data[field] === value)
            .map(([key, data]) => ({ id: key.split('/').at(-1), data: () => data }))
        })
      }),
      get: async () => ({
        docs: [...records.entries()]
          .filter(([key]) => key.startsWith(`${name}/`) && key.split('/').length === 2)
          .map(([key, data]) => ({ id: key.split('/').at(-1), data: () => data }))
      })
    }),
    doc: key => reference(key),
    runTransaction: callback => callback({
      get: async ref => snapshot(ref.key),
      set: (ref, data, options = {}) => {
        records.set(ref.key, options.merge ? { ...records.get(ref.key), ...data } : data);
      },
      create: (ref, data) => {
        if (records.has(ref.key)) throw new Error(`Document already exists: ${ref.key}`);
        records.set(ref.key, data);
      },
      delete: ref => records.delete(ref.key)
    })
  };
  db.records = records;
  return { db, records };
}

let server;
let origin;
let fakeDatabase;
let providerSubscription;
const providerSubscriptions = new Map();
let nextSubscriptionId = 0;
let nextDynamicPlanId = 0;
const dynamicProviderPlans = new Map();

before(async () => {
  Object.assign(process.env, environment);
  fakeDatabase = createFakeDatabase();
  app.locals.firebaseAdmin = {
    auth: {
      listUsers: async () => {
        const now = Date.now();
        return {
          users: [
            { uid: 'user-1', email: 'paid@example.com', displayName: 'Paid User', metadata: { creationTime: new Date(now - 5 * 86400000).toISOString() } },
            { uid: 'user-2', email: 'expired@example.com', displayName: 'Expired User', metadata: { creationTime: new Date(now - 45 * 86400000).toISOString() } },
            { uid: 'user-3', email: 'free@example.com', displayName: 'Free User', metadata: { creationTime: new Date(now - 10 * 86400000).toISOString() } }
          ]
        };
      },
      verifyIdToken: async token => {
        if (token === 'valid-test-token') return { uid: 'user-1' };
        if (token === 'other-test-token') return { uid: 'user-2' };
        if (token === 'third-test-token') return { uid: 'user-3' };
        if (token === 'fourth-test-token') return { uid: 'user-4' };
        if (token === 'admin-test-token') return { uid: 'admin-1', email: 'admin@example.com' };
        throw new Error('Invalid token');
      }
    },
    db: fakeDatabase.db
  };
  app.locals.razorpayRequest = async (endpoint, { method = 'GET', body } = {}) => {
    if (endpoint === '/plans' && method === 'POST') {
      nextDynamicPlanId += 1;
      const plan = {
        id: `plan_dynamic${nextDynamicPlanId}`,
        period: body.period,
        interval: body.interval,
        item: body.item
      };
      dynamicProviderPlans.set(plan.id, plan);
      return plan;
    }
    if (endpoint.startsWith('/plans/plan_dynamic')) {
      return dynamicProviderPlans.get(endpoint.split('/').at(-1));
    }
    if (endpoint === '/plans/plan_monthly_test') {
      return { id: 'plan_monthly_test', item: { amount: 9900, currency: 'INR' }, period: 'monthly', interval: 1 };
    }
    if (endpoint === '/plans/plan_yearly_test') {
      return { id: 'plan_yearly_test', item: { amount: 39900, currency: 'INR' }, period: 'yearly', interval: 1 };
    }
    if (endpoint === '/plans/plan_monthly_usd_test') {
      return { id: 'plan_monthly_usd_test', item: { amount: 367, currency: 'USD' }, period: 'monthly', interval: 1 };
    }
    if (endpoint === '/plans/plan_yearly_usd_test') {
      return { id: 'plan_yearly_usd_test', item: { amount: 4937, currency: 'USD' }, period: 'yearly', interval: 1 };
    }
    if (endpoint === '/subscriptions' && method === 'POST') {
      nextSubscriptionId += 1;
      const subscription = {
        id: `sub_test${nextSubscriptionId}`,
        plan_id: body.plan_id,
        status: 'created'
      };
      providerSubscriptions.set(subscription.id, subscription);
      return subscription;
    }
    if (endpoint === '/subscriptions/sub_monthlyreference') {
      return { id: 'sub_monthlyreference', plan_id: 'plan_monthly_test', status: 'created' };
    }
    if (endpoint === '/subscriptions/sub_monthlymismatch') {
      return { id: 'sub_monthlymismatch', plan_id: 'plan_yearly_test', status: 'created' };
    }
    const subscriptionMatch = endpoint.match(/^\/subscriptions\/([^/]+)$/);
    if (subscriptionMatch && providerSubscriptions.has(subscriptionMatch[1])) {
      const subscription = providerSubscriptions.get(subscriptionMatch[1]);
      if (method === 'PATCH') {
        const updatedSubscription = { ...subscription, ...body, has_scheduled_changes: true };
        providerSubscriptions.set(subscriptionMatch[1], updatedSubscription);
        return updatedSubscription;
      }
      return subscription;
    }
    if (endpoint === '/subscriptions/sub_test1') return providerSubscription;
    if (endpoint === '/payments/pay_test1') {
      const providerPlan = providerSubscription
        ? dynamicProviderPlans.get(providerSubscription.plan_id)
        : null;
      return {
        id: 'pay_test1',
        subscription_id: 'sub_test1',
        status: 'captured',
        method: 'upi',
        created_at: Math.floor(Date.now() / 1000),
        amount: providerPlan?.item.amount
          ?? (providerSubscription?.plan_id === 'plan_monthly_usd_test' ? 367 : 9900),
        currency: providerPlan?.item.currency
          ?? (providerSubscription?.plan_id === 'plan_monthly_usd_test' ? 'USD' : 'INR')
      };
    }
    if (endpoint === '/subscriptions/sub_test1/cancel') {
      return { id: 'sub_test1', status: 'cancelled' };
    }
    throw new Error(`Unexpected mocked Razorpay request: ${method} ${endpoint}`);
  };
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  delete app.locals.firebaseAdmin;
  delete app.locals.razorpayRequest;
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function request(path, { method = 'GET', token, body, headers = {} } = {}) {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

test('health check returns a fast no-store JSON liveness response', async () => {
  const response = await request('/api/health');

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type'), /application\/json/);
  const body = await response.json();
  assert.deepEqual(
    { status: body.status, service: body.service },
    { status: 'ok', service: 'ResumeOut.com API' }
  );
  assert.ok(Number.isFinite(Date.parse(body.timestamp)));
});

test('API requests on the Render hostname are not redirected to the frontend', async () => {
  const response = await request('/api/health', {
    headers: { host: 'buildmyportfolio.onrender.com' }
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('location'), null);
});

test('admin API explains when local Firebase Admin credentials are missing', async () => {
  const previousAdmin = app.locals.firebaseAdmin;
  const previousCredentials = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  delete app.locals.firebaseAdmin;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  try {
    const response = await request('/api/admin/dashboard', { token: 'admin-test-token' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'Firebase Admin credentials are not configured on this server.');
  } finally {
    app.locals.firebaseAdmin = previousAdmin;
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = previousCredentials;
  }
});

function signedWebhook(event) {
  const rawBody = Buffer.from(JSON.stringify(event));
  const signature = createHmac('sha256', environment.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return fetch(`${origin}/api/billing/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': signature
    },
    body: rawBody
  });
}

test('billing routes reject unauthenticated and unapproved checkout requests', async () => {
  const unauthenticated = await request('/api/billing/subscriptions', {
    method: 'POST',
    body: { planKey: 'monthly' }
  });
  assert.equal(unauthenticated.status, 401);

  process.env.BILLING_TEST_MODE_VERIFIED = 'false';
  const config = await request('/api/billing/config');
  const configBody = await config.json();
  assert.equal(configBody.checkoutEnabled, false);
  assert.equal(configBody.entitlementEnabled, true);
  assert.equal(configBody.voucherEnabled, true);
  assert.doesNotMatch(JSON.stringify(configBody), /WELCOME30|LIMITED7/);
  const configuredVoucherCodes = process.env.PRO_VOUCHERS_JSON;
  process.env.PRO_VOUCHERS_JSON = '[]';
  const adminVoucherConfig = await request('/api/billing/config');
  assert.equal((await adminVoucherConfig.json()).voucherEnabled, true);
  process.env.PRO_VOUCHERS_JSON = configuredVoucherCodes;
  fakeDatabase.records.set('users/user-1/billing/entitlement', {
    planId: 'pro',
    billingPlan: 'yearly',
    validUntil: Date.now() + 60_000,
    subscriptionId: 'sub_existing'
  });
  const entitlement = await request('/api/billing/entitlement', { token: 'valid-test-token' });
  assert.equal(entitlement.status, 200);
  assert.equal((await entitlement.json()).entitlement.planId, 'pro');
  const blocked = await request('/api/billing/subscriptions', {
    method: 'POST',
    token: 'valid-test-token',
    body: { planKey: 'monthly' }
  });
  assert.equal(blocked.status, 503);
  fakeDatabase.records.delete('users/user-1/billing/entitlement');
  process.env.BILLING_TEST_MODE_VERIFIED = environment.BILLING_TEST_MODE_VERIFIED;
});

test('active monthly subscribers can schedule yearly billing at the end of their current period', async () => {
  const subscriptionId = 'sub_switchyearly';
  const validUntil = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const subscription = {
    id: subscriptionId,
    plan_id: 'plan_monthly_test',
    status: 'active',
    current_end: Math.floor(validUntil / 1000),
    payment_method: 'card'
  };
  providerSubscriptions.set(subscriptionId, subscription);
  fakeDatabase.records.set(`billingSubscriptions/${subscriptionId}`, {
    uid: 'user-4',
    planKey: 'monthly',
    planId: 'plan_monthly_test',
    currency: 'INR'
  });
  fakeDatabase.records.set('users/user-4/billing/entitlement', {
    planId: 'pro',
    billingPlan: 'monthly',
    currency: 'INR',
    validUntil,
    subscriptionId
  });

  try {
    const response = await request('/api/billing/change-plan', {
      method: 'POST',
      token: 'fourth-test-token',
      body: { planKey: 'yearly' }
    });

    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.scheduled, true);
    assert.equal(result.scheduledPlan, 'yearly');
    assert.equal(result.scheduledAt, Math.floor(validUntil / 1000) * 1000);
    assert.equal(providerSubscriptions.get(subscriptionId).has_scheduled_changes, true);
    assert.equal(fakeDatabase.records.get(`billingSubscriptions/${subscriptionId}`).pendingPlanKey, 'yearly');
    assert.equal(fakeDatabase.records.get('users/user-4/billing/entitlement').scheduledPlan, 'yearly');
  } finally {
    providerSubscriptions.delete(subscriptionId);
    fakeDatabase.records.delete(`billingSubscriptions/${subscriptionId}`);
    fakeDatabase.records.delete('users/user-4/billing/entitlement');
    fakeDatabase.records.delete('users/user-4/billing/checkout');
  }
});

test('unsupported domestic-card plan changes preserve the current subscription and return a guided fallback', async () => {
  const subscriptionId = 'sub_switchdomestic';
  const validUntil = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const subscription = {
    id: subscriptionId,
    plan_id: 'plan_monthly_test',
    status: 'active',
    current_end: Math.floor(validUntil / 1000),
    payment_method: 'card'
  };
  const originalRazorpayRequest = app.locals.razorpayRequest;
  providerSubscriptions.set(subscriptionId, subscription);
  fakeDatabase.records.set(`billingSubscriptions/${subscriptionId}`, {
    uid: 'user-4',
    planKey: 'monthly',
    planId: 'plan_monthly_test',
    currency: 'INR'
  });
  fakeDatabase.records.set('users/user-4/billing/entitlement', {
    planId: 'pro',
    billingPlan: 'monthly',
    currency: 'INR',
    validUntil,
    subscriptionId
  });
  app.locals.razorpayRequest = async (endpoint, options = {}) => {
    if (endpoint === `/subscriptions/${subscriptionId}` && options.method === 'PATCH') {
      const error = new Error('Razorpay request failed with status 400: Only offers can be updated for subscriptions when payment mode is domestic card.');
      error.status = 400;
      error.providerDetail = 'Only offers can be updated for subscriptions when payment mode is domestic card.';
      throw error;
    }
    return originalRazorpayRequest(endpoint, options);
  };

  try {
    const response = await request('/api/billing/change-plan', {
      method: 'POST',
      token: 'fourth-test-token',
      body: { planKey: 'yearly' }
    });

    assert.equal(response.status, 409);
    const result = await response.json();
    assert.equal(result.code, 'YEARLY_SWITCH_REQUIRES_CANCELLATION');
    assert.match(result.error, /Your current plan is unchanged/);
    assert.equal(providerSubscriptions.get(subscriptionId).has_scheduled_changes, undefined);
    assert.equal(fakeDatabase.records.get(`billingSubscriptions/${subscriptionId}`).pendingPlanKey, null);
    assert.equal(fakeDatabase.records.get('users/user-4/billing/entitlement').scheduledPlan, null);
  } finally {
    app.locals.razorpayRequest = originalRazorpayRequest;
    providerSubscriptions.delete(subscriptionId);
    fakeDatabase.records.delete(`billingSubscriptions/${subscriptionId}`);
    fakeDatabase.records.delete('users/user-4/billing/entitlement');
    fakeDatabase.records.delete('users/user-4/billing/checkout');
  }
});

test('checkout reports a rejected Razorpay Test Mode key pair clearly', async () => {
  const razorpayRequest = app.locals.razorpayRequest;
  app.locals.razorpayRequest = async (endpoint, options) => {
    if (endpoint === '/plans/plan_monthly_test') {
      const error = new Error('Razorpay request failed with status 401.');
      error.status = 401;
      throw error;
    }
    return razorpayRequest(endpoint, options);
  };

  try {
    const response = await request('/api/billing/subscriptions', {
      method: 'POST',
      token: 'fourth-test-token',
      body: { planKey: 'monthly', currency: 'INR', expectedAmount: 9900 }
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.match(body.error, /matching Test Mode pair/);
    assert.match(body.error, /restart the local server/);
  } finally {
    app.locals.razorpayRequest = razorpayRequest;
  }
});

test('admin pricing stores distinct actual and current values', async () => {
  const save = await request('/api/admin/pricing', {
    method: 'PUT',
    token: 'admin-test-token',
    body: {
      pricing: {
        announcement: 'Limited-time price drop: launch pricing is now discounted to make Pro more accessible.',
        monthly: { actualPrice: 199, currentPrice: 99 },
        yearly: { actualPrice: 499, currentPrice: 399 },
        USD: {
          monthly: { actualPrice: 4.5, currentPrice: 3.67 },
          yearly: { actualPrice: 59.99, currentPrice: 49.37 }
        }
      }
    }
  });
  assert.equal(save.status, 200);
  const saved = await save.json();
  assert.equal(saved.pricing.monthly.actualPrice, 199);
  assert.equal(saved.pricing.monthly.currentPrice, 99);
  assert.equal(saved.pricing.yearly.actualPrice, 499);
  assert.equal(saved.pricing.yearly.currentPrice, 399);
  assert.equal(saved.pricing.USD.monthly.currentPrice, 3.67);
  assert.equal(saved.pricing.USD.yearly.currentPrice, 49.37);
  assert.match(saved.pricing.announcement, /price drop/i);

  const load = await request('/api/admin/pricing', { token: 'admin-test-token' });
  const loaded = await load.json();
  assert.equal(loaded.pricing.monthly.actualPrice, 199);
  assert.equal(loaded.pricing.monthly.currentPrice, 99);
  assert.equal(loaded.pricing.yearly.actualPrice, 499);
  assert.equal(loaded.pricing.yearly.currentPrice, 399);
  assert.equal(loaded.pricing.USD.monthly.currentPrice, 3.67);
  assert.equal(loaded.pricing.USD.yearly.currentPrice, 49.37);
  assert.match(loaded.pricing.announcement, /price drop/i);

  const invalidPrice = await request('/api/admin/pricing', {
    method: 'PUT',
    token: 'admin-test-token',
    body: {
      pricing: {
        monthly: { actualPrice: 199, currentPrice: -1 },
        yearly: { actualPrice: 499, currentPrice: 399 },
        USD: {
          monthly: { actualPrice: 4.5, currentPrice: 3.67 },
          yearly: { actualPrice: 59.99, currentPrice: 49.37 }
        }
      }
    }
  });
  assert.equal(invalidPrice.status, 400);
});

test('admin regional prices create verified Razorpay plans and charge the configured amount', async () => {
  const save = await request('/api/admin/pricing', {
    method: 'PUT',
    token: 'admin-test-token',
    body: {
      pricing: {
        monthly: { actualPrice: 149, currentPrice: 109 },
        yearly: { actualPrice: 499, currentPrice: 399 },
        USD: {
          monthly: { actualPrice: 4.5, currentPrice: 4.25 },
          yearly: { actualPrice: 59.99, currentPrice: 49.37 }
        }
      }
    }
  });
  const saved = await save.json();
  assert.equal(save.status, 200, JSON.stringify(saved));
  assert.equal(saved.pricing.monthly.currentPrice, 109);
  assert.equal(saved.pricing.USD.monthly.currentPrice, 4.25);

  const stored = fakeDatabase.records.get('appConfig/pricing');
  const inrPlanId = stored.providerPlanIds.INR.monthly;
  const usdPlanId = stored.providerPlanIds.USD.monthly;
  assert.match(inrPlanId, /^plan_dynamic/);
  assert.match(usdPlanId, /^plan_dynamic/);
  assert.equal(dynamicProviderPlans.get(inrPlanId).item.amount, 10900);
  assert.equal(dynamicProviderPlans.get(inrPlanId).item.currency, 'INR');
  assert.equal(dynamicProviderPlans.get(usdPlanId).item.amount, 425);
  assert.equal(dynamicProviderPlans.get(usdPlanId).item.currency, 'USD');

  const publicPricingResponse = await request('/api/pricing/config');
  const publicPricing = await publicPricingResponse.json();
  assert.equal(publicPricing.pricing.USD.monthly.currentPrice, 4.25);
  assert.equal(Object.hasOwn(publicPricing.pricing, 'providerPlanIds'), false);
  const dynamicBillingConfigResponse = await request('/api/billing/config');
  const dynamicBillingConfig = await dynamicBillingConfigResponse.json();
  assert.equal(dynamicBillingConfig.currencyPlans.INR.monthly.amount, 10900);
  assert.equal(dynamicBillingConfig.currencyPlans.USD.monthly.amount, 425);
  assert.ok(dynamicBillingConfig.supportedCurrencies.includes('USD'));

  const configuredMonthlyPlanId = process.env.RAZORPAY_PLAN_MONTHLY_ID;
  process.env.RAZORPAY_PLAN_MONTHLY_ID = 'sub_not_a_plan_id';
  try {
    const configWithSubscriptionId = await request('/api/billing/config');
    const configWithSubscriptionIdBody = await configWithSubscriptionId.json();
    assert.equal(configWithSubscriptionIdBody.checkoutEnabled, true);
    assert.ok(configWithSubscriptionIdBody.supportedCurrencies.includes('INR'));
    assert.ok(configWithSubscriptionIdBody.supportedCurrencies.includes('USD'));
  } finally {
    process.env.RAZORPAY_PLAN_MONTHLY_ID = configuredMonthlyPlanId;
  }

  const stalePriceCheckout = await request('/api/billing/subscriptions', {
    method: 'POST',
    token: 'third-test-token',
    body: { planKey: 'monthly', currency: 'USD', expectedAmount: 367 }
  });
  assert.equal(stalePriceCheckout.status, 409);
  assert.equal(fakeDatabase.records.has('users/user-3/billing/checkout'), false);

  const checkout = await request('/api/billing/subscriptions', {
    method: 'POST',
    token: 'third-test-token',
    body: { planKey: 'monthly', currency: 'USD', expectedAmount: 425 }
  });
  const checkoutBody = await checkout.json();
  assert.equal(checkout.status, 201, JSON.stringify(checkoutBody));
  assert.equal(checkoutBody.plan.amount, 425);
  assert.equal(fakeDatabase.records.get('billingSubscriptions/sub_test1').planId, usdPlanId);
  assert.equal(fakeDatabase.records.get('billingSubscriptions/sub_test1').amount, 425);

  providerSubscription = {
    id: 'sub_test1',
    plan_id: usdPlanId,
    status: 'active',
    current_end: Math.floor(Date.now() / 1000) + 3600,
    notes: { plan_key: 'monthly', currency: 'USD' }
  };
  providerSubscriptions.set('sub_test1', providerSubscription);
  const signature = createHmac('sha256', environment.RAZORPAY_KEY_SECRET)
    .update('sub_test1|pay_test1')
    .digest('hex');
  const verified = await request('/api/billing/verify', {
    method: 'POST',
    token: 'third-test-token',
    body: {
      razorpaySubscriptionId: 'sub_test1',
      razorpayPaymentId: 'pay_test1',
      razorpaySignature: signature
    }
  });
  const verifiedBody = await verified.json();
  assert.equal(verified.status, 200, JSON.stringify(verifiedBody));
  assert.equal(fakeDatabase.records.get('billingPayments/pay_test1').amount, 425);
  assert.equal(fakeDatabase.records.get('billingPayments/pay_test1').currency, 'USD');

  fakeDatabase.records.delete('billingSubscriptions/sub_test1');
  fakeDatabase.records.delete('users/user-3/billing/checkout');
  fakeDatabase.records.delete('users/user-3/billing/entitlement');
  fakeDatabase.records.delete('billingPayments/pay_test1');
  providerSubscription = null;
  providerSubscriptions.delete('sub_test1');
  nextSubscriptionId = 0;

  const restore = await request('/api/admin/pricing', {
    method: 'PUT',
    token: 'admin-test-token',
    body: {
      pricing: {
        monthly: { actualPrice: 199, currentPrice: 99 },
        yearly: { actualPrice: 499, currentPrice: 399 },
        USD: {
          monthly: { actualPrice: 4.5, currentPrice: 3.67 },
          yearly: { actualPrice: 59.99, currentPrice: 49.37 }
        }
      }
    }
  });
  assert.equal(restore.status, 200);
});

test('admin pricing saves supported currencies when Razorpay rejects USD currency', async () => {
  const razorpayRequest = app.locals.razorpayRequest;
  app.locals.razorpayRequest = async (endpoint, options) => {
    if (endpoint === '/plans' && options?.method === 'POST' && options.body?.item?.currency === 'USD') {
      const error = new Error('Razorpay request failed with status 400: Currency provided is not supported.');
      error.status = 400;
      error.providerDetail = 'Currency provided is not supported';
      throw error;
    }
    return razorpayRequest(endpoint, options);
  };

  try {
    const save = await request('/api/admin/pricing', {
      method: 'PUT',
      token: 'admin-test-token',
      body: {
        pricing: {
          monthly: { actualPrice: 149, currentPrice: 109 },
          yearly: { actualPrice: 499, currentPrice: 399 },
          USD: {
            monthly: { actualPrice: 4.5, currentPrice: 4.25 },
            yearly: { actualPrice: 59.99, currentPrice: 49.37 }
          }
        }
      }
    });
    const saved = await save.json();
    assert.equal(save.status, 200, JSON.stringify(saved));
    assert.equal(saved.pricing.monthly.currentPrice, 109);
    assert.equal(saved.pricing.USD.monthly.currentPrice, 4.25);
    assert.deepEqual(saved.unavailableCurrencies, ['USD']);
    assert.match(saved.warnings[0], /USD checkout is disabled/);

    const stored = fakeDatabase.records.get('appConfig/pricing');
    assert.ok(stored.providerPlanIds.INR.monthly);
    assert.deepEqual(stored.providerPlanIds.USD, {});
    const configResponse = await request('/api/billing/config');
    const config = await configResponse.json();
    assert.ok(config.supportedCurrencies.includes('INR'));
    assert.ok(!config.supportedCurrencies.includes('USD'));
  } finally {
    app.locals.razorpayRequest = razorpayRequest;
    const restore = await request('/api/admin/pricing', {
      method: 'PUT',
      token: 'admin-test-token',
      body: {
        pricing: {
          monthly: { actualPrice: 199, currentPrice: 99 },
          yearly: { actualPrice: 499, currentPrice: 399 },
          USD: {
            monthly: { actualPrice: 4.5, currentPrice: 3.67 },
            yearly: { actualPrice: 59.99, currentPrice: 49.37 }
          }
        }
      }
    });
    assert.equal(restore.status, 200);
  }
});

test('international checkout selects the server-verified USD Razorpay plan', async () => {
  const configResponse = await request('/api/billing/config');
  const config = await configResponse.json();
  assert.deepEqual(config.supportedCurrencies, ['INR', 'USD']);
  assert.equal(config.currencyPlans.USD.monthly.amount, 367);
  assert.equal(config.currencyPlans.USD.yearly.amount, 4937);

  const unsupportedCurrency = await request('/api/billing/subscriptions', {
    method: 'POST',
    token: 'third-test-token',
    body: { planKey: 'monthly', currency: 'EUR' }
  });
  assert.equal(unsupportedCurrency.status, 400);

  const checkout = await request('/api/billing/subscriptions', {
    method: 'POST',
    token: 'third-test-token',
    body: { planKey: 'monthly', currency: 'USD', expectedAmount: 367, amount: 1 }
  });
  assert.equal(checkout.status, 201);
  const result = await checkout.json();
  assert.equal(result.plan.amount, 367);
  assert.equal(result.plan.currency, 'USD');
  assert.equal(fakeDatabase.records.get('billingSubscriptions/sub_test1').currency, 'USD');
  assert.equal(fakeDatabase.records.get('billingSubscriptions/sub_test1').planId, 'plan_monthly_usd_test');
  assert.equal(fakeDatabase.records.get('users/user-3/billing/checkout').currency, 'USD');
  providerSubscription = {
    id: 'sub_test1',
    plan_id: 'plan_monthly_usd_test',
    status: 'active',
    current_end: Math.floor(Date.now() / 1000) + 3600,
    notes: { plan_key: 'monthly', currency: 'USD' }
  };
  providerSubscriptions.set('sub_test1', providerSubscription);
  const signature = createHmac('sha256', environment.RAZORPAY_KEY_SECRET)
    .update('sub_test1|pay_test1')
    .digest('hex');
  const verified = await request('/api/billing/verify', {
    method: 'POST',
    token: 'third-test-token',
    body: {
      razorpaySubscriptionId: 'sub_test1',
      razorpayPaymentId: 'pay_test1',
      razorpaySignature: signature
    }
  });
  const verifiedBody = await verified.json();
  assert.equal(verified.status, 200, JSON.stringify(verifiedBody));
  assert.equal(verifiedBody.entitlement.currency, 'USD');
  assert.equal(fakeDatabase.records.get('billingPayments/pay_test1').currency, 'USD');
  fakeDatabase.records.delete('billingSubscriptions/sub_test1');
  fakeDatabase.records.delete('users/user-3/billing/checkout');
  fakeDatabase.records.delete('users/user-3/billing/entitlement');
  fakeDatabase.records.delete('billingPayments/pay_test1');
  providerSubscription = null;
  providerSubscriptions.delete('sub_test1');
  nextSubscriptionId = 0;
});

test('admin dashboard reports current subscriptions and captured revenue accurately', async () => {
  const now = Date.now();
  const testRecords = [
    ['users/user-1/billing/entitlement', {
      planId: 'pro', billingPlan: 'monthly', status: 'active', source: 'razorpay', validUntil: now + 30 * 86400000
    }],
    ['users/user-2/billing/entitlement', {
      planId: 'pro', billingPlan: 'yearly', status: 'expired', source: 'razorpay', validUntil: now - 86400000
    }],
    ['billingPayments/payment-current', {
      uid: 'user-1', status: 'captured', amount: 9900, currency: 'INR', planKey: 'monthly', createdAt: now
    }],
    ['billingPayments/payment-old', {
      uid: 'user-1', status: 'success', amount: 39900, currency: 'INR', planKey: 'yearly', createdAt: now - 45 * 86400000
    }],
    ['billingPayments/payment-authorized', {
      uid: 'user-2', status: 'authorized', amount: 12000, currency: 'INR', planKey: 'monthly', createdAt: now
    }]
  ];
  for (const [key, value] of testRecords) fakeDatabase.records.set(key, value);

  try {
    const response = await request('/api/admin/dashboard', { token: 'admin-test-token' });
    assert.equal(response.status, 200);
    const dashboard = await response.json();

    assert.equal(dashboard.totals.users, 3);
    assert.equal(dashboard.totals.pro, 1);
    assert.equal(dashboard.totals.regular, 2);
    assert.equal(dashboard.totals.newUsers30Days, 2);
    assert.equal(dashboard.totals.conversionRate, 33.3);
    assert.equal(dashboard.totals.monthlyPro, 1);
    assert.equal(dashboard.totals.yearlyPro, 0);
    assert.equal(dashboard.totals.earnings, 49800);
    assert.equal(dashboard.totals.earningsThisMonth, 9900);
    assert.equal(dashboard.totals.paymentsThisMonth, 1);
    assert.equal(dashboard.totals.paymentCount, 2);
    assert.equal(dashboard.recentPayments.length, 2);
    assert.equal(dashboard.recentPayments[0].id, 'payment-current');
    assert.equal(dashboard.users.find(user => user.uid === 'user-2').isPro, false);
  } finally {
    for (const [key] of testRecords) fakeDatabase.records.delete(key);
  }
});

test('public vouchers are available to every signed-in account and queue during active Pro access', async () => {
  const unauthenticated = await request('/api/billing/vouchers/redeem', {
    method: 'POST',
    body: { code: 'WELCOME30' }
  });
  assert.equal(unauthenticated.status, 401);

  const invalid = await request('/api/billing/vouchers/redeem', {
    method: 'POST',
    token: 'valid-test-token',
    body: { code: 'NOT-A-CODE' }
  });
  assert.equal(invalid.status, 404);

  const redeemed = await request('/api/billing/vouchers/redeem', {
    method: 'POST',
    token: 'valid-test-token',
    body: { code: ' welcome30 ' }
  });
  assert.equal(redeemed.status, 200);
  const entitlement = (await redeemed.json()).entitlement;
  assert.equal(entitlement.planId, 'pro');
  assert.equal(entitlement.billingPlan, 'voucher');
  assert.equal(entitlement.source, 'server-verified');
  assert.ok(entitlement.validUntil > Date.now());
  const voucherHistoryId = `voucher_${voucherDocumentId('WELCOME30')}_${voucherDocumentId('user-1')}`;
  const voucherHistory = fakeDatabase.records.get(`billingAccessHistory/${voucherHistoryId}`);
  assert.equal(voucherHistory.planKey, 'voucher');
  assert.equal(voucherHistory.paymentMode, 'voucher');
  assert.equal(voucherHistory.paymentId, null);
  assert.equal(voucherHistory.validFrom <= Date.now(), true);
  assert.equal(voucherHistory.validUntil, entitlement.validUntil);

  const secondAccount = await request('/api/billing/vouchers/redeem', {
    method: 'POST',
    token: 'other-test-token',
    body: { code: 'WELCOME30' }
  });
  assert.equal(secondAccount.status, 200);
  assert.equal((await secondAccount.json()).entitlement.billingPlan, 'voucher');

  const duplicate = await request('/api/billing/vouchers/redeem', {
    method: 'POST',
    token: 'valid-test-token',
    body: { code: 'WELCOME30' }
  });
  assert.equal(duplicate.status, 409);

  const activeAccount = await request('/api/billing/vouchers/redeem', {
    method: 'POST',
    token: 'valid-test-token',
    body: { code: 'LIMITED7' }
  });
  assert.equal(activeAccount.status, 200);
  const queued = await activeAccount.json();
  assert.equal(queued.queued, true);
  assert.equal(queued.entitlement.pendingVoucherCount, 1);
  assert.equal(queued.entitlement.pendingVoucherStartAt, entitlement.validUntil);
  const queuedVoucherHistoryId = `voucher_${voucherDocumentId('LIMITED7')}_${voucherDocumentId('user-1')}`;
  const queuedVoucherHistory = fakeDatabase.records.get(`billingAccessHistory/${queuedVoucherHistoryId}`);
  assert.equal(queuedVoucherHistory.status, 'scheduled');
  assert.equal(queuedVoucherHistory.validFrom, entitlement.validUntil);
  assert.equal(queuedVoucherHistory.validUntil, entitlement.validUntil + 7 * 86400000);

  const firstLimited = await request('/api/billing/vouchers/redeem', {
    method: 'POST',
    token: 'other-test-token',
    body: { code: 'LIMITED7' }
  });
  assert.equal(firstLimited.status, 200);

  const anotherPublicAccount = await request('/api/billing/vouchers/redeem', {
    method: 'POST',
    token: 'fourth-test-token',
    body: { code: 'WELCOME30' }
  });
  assert.equal(anotherPublicAccount.status, 200);

  const capped = await request('/api/billing/vouchers/redeem', {
    method: 'POST',
    token: 'third-test-token',
    body: { code: 'LIMITED7' }
  });
  assert.equal(capped.status, 409);

  const assignedCode = 'TARGET-USER-4';
  const assignedId = voucherDocumentId(assignedCode);
  fakeDatabase.records.set(`adminVouchers/${assignedId}`, {
    code: assignedCode,
    durationDays: 30,
    maxRedemptions: 1,
    assignedUid: 'user-4',
    redeemedCount: 0,
    createdAt: Date.now()
  });
  const wrongAccount = await request('/api/billing/vouchers/redeem', {
    method: 'POST',
    token: 'other-test-token',
    body: { code: assignedCode }
  });
  assert.equal(wrongAccount.status, 403);
  const assignedAccount = await request('/api/billing/vouchers/redeem', {
    method: 'POST',
    token: 'fourth-test-token',
    body: { code: assignedCode }
  });
  assert.equal(assignedAccount.status, 200);
  assert.equal((await assignedAccount.json()).queued, true);

  const activeEntitlementKey = 'users/user-1/billing/entitlement';
  fakeDatabase.records.set(activeEntitlementKey, {
    ...fakeDatabase.records.get(activeEntitlementKey),
    validUntil: Date.now() - 1
  });
  const activated = await request('/api/billing/entitlement', { token: 'valid-test-token' });
  assert.equal(activated.status, 200);
  const activatedEntitlement = (await activated.json()).entitlement;
  assert.equal(activatedEntitlement.billingPlan, 'voucher');
  assert.equal(activatedEntitlement.pendingVoucherCount, 0);
  assert.ok(activatedEntitlement.validUntil > Date.now());

  for (const uid of ['user-1', 'user-2', 'user-3', 'user-4']) {
    fakeDatabase.records.delete(`users/${uid}/billing/entitlement`);
  }
});

test('subscription checkout, payment verification, and signed webhook lifecycle update server entitlements', async () => {
  const checkoutResponse = await request('/api/billing/subscriptions', {
    method: 'POST',
    token: 'valid-test-token',
    body: { planKey: 'monthly', currency: 'INR', expectedAmount: 9900 }
  });
  assert.equal(checkoutResponse.status, 201);
  assert.equal((await checkoutResponse.json()).subscriptionId, 'sub_test1');
  assert.equal(fakeDatabase.records.get('billingSubscriptions/sub_test1').uid, 'user-1');

  const endOfPeriod = Math.floor(Date.now() / 1000) + 3600;
  providerSubscription = {
    id: 'sub_test1',
    plan_id: 'plan_monthly_test',
    status: 'authenticated',
    current_end: endOfPeriod,
    notes: { plan_key: 'monthly' }
  };
  providerSubscriptions.set('sub_test1', providerSubscription);
  const signature = createHmac('sha256', environment.RAZORPAY_KEY_SECRET)
    .update('sub_test1|pay_test1')
    .digest('hex');
  const verified = await request('/api/billing/verify', {
    method: 'POST',
    token: 'valid-test-token',
    body: {
      razorpaySubscriptionId: 'sub_test1',
      razorpayPaymentId: 'pay_test1',
      razorpaySignature: signature
    }
  });
  assert.equal(verified.status, 200);
  const verifiedBody = await verified.json();
  assert.equal(verifiedBody.entitlement.planId, 'pro');
  assert.equal(verifiedBody.entitlement.status, 'active');
  assert.equal(verifiedBody.entitlement.validUntil, endOfPeriod * 1000);
  assert.equal(fakeDatabase.records.get('users/user-1/billing/entitlement').status, 'active');
  assert.equal(
    fakeDatabase.records.get('users/user-1/billing/entitlement').validUntil,
    endOfPeriod * 1000
  );
  assert.equal(
    fakeDatabase.records.get('users/user-1/billing/entitlement').subscriptionId,
    'sub_test1'
  );
  const verifiedAccessHistory = fakeDatabase.records.get('billingAccessHistory/pay_test1');
  assert.equal(verifiedAccessHistory.subscriptionId, 'sub_test1');
  assert.equal(verifiedAccessHistory.planKey, 'monthly');
  assert.equal(verifiedAccessHistory.paymentId, 'pay_test1');
  assert.equal(verifiedAccessHistory.paymentMode, 'upi');
  assert.equal(verifiedAccessHistory.validUntil, endOfPeriod * 1000);
  const adminUserDetailsResponse = await request('/api/admin/users/user-1', { token: 'admin-test-token' });
  assert.equal(adminUserDetailsResponse.status, 200);
  const adminUserDetails = await adminUserDetailsResponse.json();
  assert.ok(adminUserDetails.accessHistory.some(item => item.paymentId === 'pay_test1'));
  assert.ok(adminUserDetails.accessHistory.some(item => item.source === 'voucher' && item.paymentMode === 'voucher'));
  providerSubscription = { ...providerSubscription, status: 'active' };
  providerSubscriptions.set('sub_test1', providerSubscription);
  fakeDatabase.records.delete('users/user-1/billing/entitlement');
  fakeDatabase.records.delete('users/user-1/billing/checkout');
  const reconciledEntitlementResponse = await request('/api/billing/entitlement', { token: 'valid-test-token' });
  assert.equal(reconciledEntitlementResponse.status, 200);
  const reconciledEntitlement = (await reconciledEntitlementResponse.json()).entitlement;
  assert.equal(reconciledEntitlement.status, 'active');
  assert.equal(reconciledEntitlement.planId, 'pro');
  assert.equal(reconciledEntitlement.billingPlan, 'monthly');
  assert.equal(reconciledEntitlement.validUntil, endOfPeriod * 1000);
  assert.equal(
    fakeDatabase.records.get('users/user-1/billing/entitlement').subscriptionId,
    'sub_test1'
  );
  fakeDatabase.records.set('users/user-1/billing/entitlement', {
    ...fakeDatabase.records.get('users/user-1/billing/entitlement'),
    pendingVouchers: [{ voucherId: 'queued-webhook-test', durationDays: 7, startsAt: Date.now() + 3_600_000 }]
  });

  const activatedEvent = {
    id: 'evt_activation_1',
    event: 'subscription.activated',
    payload: { subscription: { entity: { ...providerSubscription, status: 'active' } } }
  };
  assert.equal((await signedWebhook(activatedEvent)).status, 200);
  assert.equal((await signedWebhook(activatedEvent)).status, 200);
  assert.equal(fakeDatabase.records.get('billingWebhookEvents/evt_activation_1').subscriptionId, 'sub_test1');
  const updatedEntitlement = fakeDatabase.records.get('users/user-1/billing/entitlement');
  assert.equal(updatedEntitlement.pendingVouchers.length, 1);
  assert.equal(updatedEntitlement.pendingVouchers[0].startsAt, endOfPeriod * 1000);

  fakeDatabase.records.set('users/user-1/billing/entitlement', {
    planId: 'pro',
    billingPlan: 'monthly',
    status: 'active',
    validUntil: Date.now() + 60_000,
    subscriptionId: null,
    cancelAtCycleEnd: false
  });
  const entitlementResponse = await request('/api/billing/entitlement', { token: 'valid-test-token' });
  assert.equal((await entitlementResponse.json()).entitlement.subscriptionId, 'sub_test1');

  const checkoutEnabled = process.env.BILLING_ENABLED;
  process.env.BILLING_ENABLED = 'false';
  let cancelled;
  try {
    cancelled = await request('/api/billing/cancel', {
      method: 'POST',
      token: 'valid-test-token',
      body: { reason: 'Changing to a different plan' }
    });
  } finally {
    process.env.BILLING_ENABLED = checkoutEnabled;
  }
  assert.equal(cancelled.status, 200);
  assert.equal(fakeDatabase.records.get('users/user-1/billing/entitlement').cancelAtCycleEnd, true);
  const userActivityResponse = await request('/api/billing/activity', { token: 'valid-test-token' });
  const userActivity = (await userActivityResponse.json()).activity;
  const userCancellation = userActivity.find(item => item.title === 'Subscription cancelled by user');
  assert.equal(userCancellation.actorType, 'user');
  assert.equal(userCancellation.actorUid, 'user-1');
  assert.ok(Number.isFinite(userCancellation.occurredAt));

  fakeDatabase.records.set('users/user-2/billing/entitlement', {
    planId: 'pro', billingPlan: 'monthly', status: 'active', validUntil: Date.now() + 60_000,
    subscriptionId: 'sub_admin_cancel'
  });
  const adminCancelled = await request('/api/admin/users/user-2/cancel-pro', {
    method: 'POST', token: 'admin-test-token', body: { reason: 'User requested cancellation' }
  });
  assert.equal(adminCancelled.status, 200);
  const adminActivityResponse = await request('/api/billing/activity', { token: 'other-test-token' });
  const adminActivity = (await adminActivityResponse.json()).activity;
  const adminCancellation = adminActivity.find(item => item.title === 'Pro access cancelled by admin');
  assert.equal(adminCancellation.actorType, 'admin');
  assert.equal(adminCancellation.actorUid, 'admin-1');
  assert.equal(adminCancellation.detail, 'User requested cancellation');
  assert.ok(Number.isFinite(adminCancellation.occurredAt));

  const expiredEvent = {
    id: 'evt_expired_1',
    event: 'subscription.expired',
    payload: {
      subscription: {
        entity: { ...providerSubscription, current_end: Math.floor(Date.now() / 1000) - 1, status: 'expired' }
      }
    }
  };
  providerSubscription = {
    ...providerSubscription,
    status: 'expired',
    current_end: Math.floor(Date.now() / 1000) - 1
  };
  providerSubscriptions.set('sub_test1', providerSubscription);
  assert.equal((await signedWebhook(expiredEvent)).status, 200);
  assert.equal(fakeDatabase.records.get('users/user-1/billing/entitlement').planId, 'free');
  const expiredEntitlementResponse = await request('/api/billing/entitlement', { token: 'valid-test-token' });
  assert.equal((await expiredEntitlementResponse.json()).entitlement.status, 'inactive');

  const invalidSignature = await fetch(`${origin}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'invalid' },
    body: JSON.stringify(activatedEvent)
  });
  assert.equal(invalidSignature.status, 400);
});

test('checkout resolves a configured subscription ID to its verified recurring plan', async () => {
  const configuredMonthlyPlanId = process.env.RAZORPAY_PLAN_MONTHLY_ID;
  const pricingRecord = 'appConfig/pricing';
  const hadPricingRecord = fakeDatabase.records.has(pricingRecord);
  const previousPricing = fakeDatabase.records.get(pricingRecord);
  process.env.RAZORPAY_PLAN_MONTHLY_ID = 'sub_monthlyreference';
  fakeDatabase.records.set(pricingRecord, {
    monthly: { actualPrice: 99, currentPrice: 99 },
    yearly: { actualPrice: 399, currentPrice: 399 }
  });
  try {
    const configResponse = await request('/api/billing/config');
    const config = await configResponse.json();
    assert.equal(config.checkoutEnabled, true);
    assert.ok(config.supportedCurrencies.includes('INR'), JSON.stringify(config));

    const checkoutResponse = await request('/api/billing/subscriptions', {
      method: 'POST',
      token: 'fourth-test-token',
      body: { planKey: 'monthly', currency: 'INR', expectedAmount: 9900 }
    });
    const checkout = await checkoutResponse.json();
    assert.equal(checkoutResponse.status, 201, JSON.stringify(checkout));
    assert.equal(fakeDatabase.records.get(`billingSubscriptions/${checkout.subscriptionId}`).planId, 'plan_monthly_test');

    process.env.RAZORPAY_PLAN_MONTHLY_ID = 'sub_monthlymismatch';
    const mismatchResponse = await request('/api/billing/subscriptions', {
      method: 'POST',
      token: 'fourth-test-token',
      body: { planKey: 'monthly', currency: 'INR', expectedAmount: 9900 }
    });
    const mismatch = await mismatchResponse.json();
    assert.equal(mismatchResponse.status, 503);
    assert.match(mismatch.error, /does not match the configured price and billing interval/);
  } finally {
    process.env.RAZORPAY_PLAN_MONTHLY_ID = configuredMonthlyPlanId;
    if (hadPricingRecord) fakeDatabase.records.set(pricingRecord, previousPricing);
    else fakeDatabase.records.delete(pricingRecord);
  }
});

test('checkout replaces expired subscriptions and does not reopen authorized subscriptions', async () => {
  const checkoutKey = 'users/user-4/billing/checkout';
  const expiredId = 'sub_expiredcheckout';
  const authorizedId = 'sub_authorizedcheckout';
  const previousCheckout = fakeDatabase.records.get(checkoutKey);
  const previousExpired = fakeDatabase.records.get(`billingSubscriptions/${expiredId}`);
  const previousAuthorized = fakeDatabase.records.get(`billingSubscriptions/${authorizedId}`);
  let replacementId;
  fakeDatabase.records.set(checkoutKey, {
    subscriptionId: expiredId,
    planKey: 'monthly',
    currency: 'INR',
    status: 'created',
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  fakeDatabase.records.set(`billingSubscriptions/${expiredId}`, { amount: 9900 });
  fakeDatabase.records.set(`billingSubscriptions/${authorizedId}`, { amount: 9900 });
  providerSubscriptions.set(expiredId, {
    id: expiredId,
    plan_id: 'plan_monthly_test',
    status: 'expired'
  });
  providerSubscriptions.set(authorizedId, {
    id: authorizedId,
    plan_id: 'plan_monthly_test',
    status: 'authenticated'
  });

  try {
    const expiredCheckout = await request('/api/billing/subscriptions', {
      method: 'POST',
      token: 'fourth-test-token',
      body: { planKey: 'monthly', currency: 'INR', expectedAmount: 9900 }
    });
    const expiredBody = await expiredCheckout.json();
    assert.equal(expiredCheckout.status, 201, JSON.stringify(expiredBody));
    assert.notEqual(expiredBody.subscriptionId, expiredId);
    replacementId = expiredBody.subscriptionId;

    const retriedCheckout = await request('/api/billing/subscriptions', {
      method: 'POST',
      token: 'fourth-test-token',
      body: { planKey: 'monthly', currency: 'INR', expectedAmount: 9900 }
    });
    const retriedBody = await retriedCheckout.json();
    assert.equal(retriedCheckout.status, 200, JSON.stringify(retriedBody));
    assert.equal(retriedBody.subscriptionId, replacementId);

    fakeDatabase.records.set(checkoutKey, {
      subscriptionId: authorizedId,
      planKey: 'monthly',
      currency: 'INR',
      status: 'created',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    const authorizedCheckout = await request('/api/billing/subscriptions', {
      method: 'POST',
      token: 'fourth-test-token',
      body: { planKey: 'monthly', currency: 'INR', expectedAmount: 9900 }
    });
    const authorizedBody = await authorizedCheckout.json();
    assert.equal(authorizedCheckout.status, 409);
    assert.match(authorizedBody.error, /authenticated/);
    assert.equal(
      fakeDatabase.records.get(checkoutKey).subscriptionId,
      authorizedId
    );
  } finally {
    providerSubscriptions.delete(expiredId);
    providerSubscriptions.delete(authorizedId);
    if (replacementId) {
      providerSubscriptions.delete(replacementId);
      fakeDatabase.records.delete(`billingSubscriptions/${replacementId}`);
    }
    if (previousCheckout) fakeDatabase.records.set(checkoutKey, previousCheckout);
    else fakeDatabase.records.delete(checkoutKey);
    if (previousExpired) fakeDatabase.records.set(`billingSubscriptions/${expiredId}`, previousExpired);
    else fakeDatabase.records.delete(`billingSubscriptions/${expiredId}`);
    if (previousAuthorized) fakeDatabase.records.set(`billingSubscriptions/${authorizedId}`, previousAuthorized);
    else fakeDatabase.records.delete(`billingSubscriptions/${authorizedId}`);
  }
});

test('users can request review for their captured Razorpay payments without issuing refunds', async () => {
  const paymentId = 'pay_refundrequesttest';
  const otherPaymentId = 'pay_refundothertest';
  fakeDatabase.records.set(`billingPayments/${paymentId}`, {
    uid: 'user-1',
    providerPaymentId: paymentId,
    subscriptionId: 'sub_refundtest',
    planKey: 'monthly',
    status: 'captured',
    method: 'card',
    amount: 9900,
    currency: 'INR',
    createdAt: Date.now()
  });
  fakeDatabase.records.set(`billingPayments/${otherPaymentId}`, {
    uid: 'user-2',
    providerPaymentId: otherPaymentId,
    subscriptionId: 'sub_otherrefundtest',
    planKey: 'yearly',
    status: 'captured',
    amount: 39900,
    currency: 'INR',
    createdAt: Date.now()
  });
  fakeDatabase.records.set('billingPayments/payment_admin_test', {
    uid: 'user-1',
    providerPaymentId: 'payment_admin_test',
    planKey: 'monthly',
    status: 'success',
    source: 'admin',
    amount: 9900,
    currency: 'INR',
    createdAt: Date.now()
  });

  const unauthenticated = await request('/api/billing/payments');
  assert.equal(unauthenticated.status, 401);

  const paymentsResponse = await request('/api/billing/payments', { token: 'valid-test-token' });
  assert.equal(paymentsResponse.status, 200);
  const payments = (await paymentsResponse.json()).payments;
  assert.ok(payments.some(payment => payment.paymentId === paymentId));
  assert.ok(!payments.some(payment => [otherPaymentId, 'payment_admin_test'].includes(payment.paymentId)));

  const crossAccountRequest = await request('/api/billing/refunds/request', {
    method: 'POST',
    token: 'valid-test-token',
    body: { paymentId: otherPaymentId }
  });
  assert.equal(crossAccountRequest.status, 404);

  const adminPaymentRequest = await request('/api/billing/refunds/request', {
    method: 'POST',
    token: 'valid-test-token',
    body: { paymentId: 'payment_admin_test' }
  });
  assert.equal(adminPaymentRequest.status, 400);

  const invalidPaymentRequest = await request('/api/billing/refunds/request', {
    method: 'POST',
    token: 'valid-test-token',
    body: { paymentId: 'pay_invalid-id' }
  });
  assert.equal(invalidPaymentRequest.status, 400);

  const longReasonRequest = await request('/api/billing/refunds/request', {
    method: 'POST',
    token: 'valid-test-token',
    body: { paymentId, reason: 'x'.repeat(501) }
  });
  assert.equal(longReasonRequest.status, 400);

  const requestResponse = await request('/api/billing/refunds/request', {
    method: 'POST',
    token: 'valid-test-token',
    body: { paymentId, reason: 'Unexpected renewal' }
  });
  assert.equal(requestResponse.status, 201);
  assert.deepEqual(await requestResponse.json(), { requested: true, paymentId });
  const storedRequest = fakeDatabase.records.get(`users/user-1/billingRefundRequests/${paymentId}`);
  assert.equal(storedRequest.status, 'requested');
  assert.equal(storedRequest.reason, 'Unexpected renewal');
  const activityResponse = await request('/api/billing/activity', { token: 'valid-test-token' });
  const refundActivity = (await activityResponse.json()).activity.find(item => item.title === 'Refund review requested');
  assert.match(refundActivity.detail, new RegExp(paymentId));
  assert.match(refundActivity.detail, /Unexpected renewal/);

  const duplicateRequest = await request('/api/billing/refunds/request', {
    method: 'POST',
    token: 'valid-test-token',
    body: { paymentId }
  });
  assert.equal(duplicateRequest.status, 409);

  const refreshedPayments = await request('/api/billing/payments', { token: 'valid-test-token' });
  const refreshedPayment = (await refreshedPayments.json()).payments.find(payment => payment.paymentId === paymentId);
  assert.equal(refreshedPayment.refundRequest.status, 'requested');
  assert.equal(fakeDatabase.records.has(`billingRefunds/${paymentId}`), false);

  fakeDatabase.records.delete(`billingPayments/${paymentId}`);
  fakeDatabase.records.delete(`billingPayments/${otherPaymentId}`);
  fakeDatabase.records.delete('billingPayments/payment_admin_test');
  fakeDatabase.records.delete(`users/user-1/billingRefundRequests/${paymentId}`);
});

test('captured recurring Razorpay webhook payments are recorded for account refund requests', async () => {
  const subscriptionId = 'sub_recurringrefundtest';
  const paymentId = 'pay_recurringrefundtest';
  fakeDatabase.records.set(`billingSubscriptions/${subscriptionId}`, {
    uid: 'user-1',
    planKey: 'monthly',
    planId: 'plan_monthly_test',
    currency: 'INR',
    status: 'active'
  });
  const event = {
    id: 'evt_recurring_refund_test',
    event: 'subscription.charged',
    payload: {
      subscription: {
        entity: {
          id: subscriptionId,
          plan_id: 'plan_monthly_test',
          status: 'active',
          current_end: Math.floor(Date.now() / 1000) + 3600
        }
      },
      payment: {
        entity: {
          id: paymentId,
          subscription_id: subscriptionId,
          status: 'captured',
          method: 'card',
          amount: 9900,
          currency: 'INR',
          created_at: Math.floor(Date.now() / 1000)
        }
      }
    }
  };
  const response = await signedWebhook(event);
  assert.equal(response.status, 200);
  assert.equal(fakeDatabase.records.get(`billingPayments/${paymentId}`).uid, 'user-1');
  assert.equal(fakeDatabase.records.get(`billingPayments/${paymentId}`).status, 'captured');
  assert.equal(fakeDatabase.records.get(`billingPayments/${paymentId}`).amount, 9900);
  assert.equal(fakeDatabase.records.get(`billingPayments/${paymentId}`).paymentMode, 'card');
  const accessRecord = fakeDatabase.records.get(`billingAccessHistory/${paymentId}`);
  assert.equal(accessRecord.subscriptionId, subscriptionId);
  assert.equal(accessRecord.planKey, 'monthly');
  assert.equal(accessRecord.paymentId, paymentId);
  assert.equal(accessRecord.paymentMode, 'card');
  assert.ok(accessRecord.validUntil > accessRecord.validFrom);

  fakeDatabase.records.delete(`billingSubscriptions/${subscriptionId}`);
  fakeDatabase.records.delete(`billingPayments/${paymentId}`);
  fakeDatabase.records.delete(`billingAccessHistory/${paymentId}`);
  fakeDatabase.records.delete('billingWebhookEvents/evt_recurring_refund_test');
});
