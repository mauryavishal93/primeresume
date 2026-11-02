import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { voucherDocumentId } from '../backend/billing.js';
import { app } from '../backend/server.js';

const environment = {
  BILLING_ENABLED: 'true',
  BILLING_TERMS_PUBLISHED: 'true',
  BILLING_REFUNDS_PUBLISHED: 'true',
  BILLING_TEST_MODE_VERIFIED: 'true',
  BILLING_LIVE_LAUNCH_APPROVED: 'true',
  ADMIN_EMAILS: 'admin@example.com',
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
      return {
        id: `sub_test${nextSubscriptionId}`,
        plan_id: body.plan_id,
        status: 'created'
      };
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
    { status: 'ok', service: 'PersonaCraftPro API' }
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

test('admin pricing stores distinct actual and current values', async () => {
  const save = await request('/api/admin/pricing', {
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
  assert.equal(save.status, 200);
  const saved = await save.json();
  assert.equal(saved.pricing.monthly.actualPrice, 199);
  assert.equal(saved.pricing.monthly.currentPrice, 99);
  assert.equal(saved.pricing.yearly.actualPrice, 499);
  assert.equal(saved.pricing.yearly.currentPrice, 399);
  assert.equal(saved.pricing.USD.monthly.currentPrice, 3.67);
  assert.equal(saved.pricing.USD.yearly.currentPrice, 49.37);

  const load = await request('/api/admin/pricing', { token: 'admin-test-token' });
  const loaded = await load.json();
  assert.equal(loaded.pricing.monthly.actualPrice, 199);
  assert.equal(loaded.pricing.monthly.currentPrice, 99);
  assert.equal(loaded.pricing.yearly.actualPrice, 499);
  assert.equal(loaded.pricing.yearly.currentPrice, 399);
  assert.equal(loaded.pricing.USD.monthly.currentPrice, 3.67);
  assert.equal(loaded.pricing.USD.yearly.currentPrice, 49.37);

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
    status: 'active',
    current_end: endOfPeriod,
    notes: { plan_key: 'monthly' }
  };
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
  assert.equal((await verified.json()).entitlement.planId, 'pro');
  assert.equal(fakeDatabase.records.get('users/user-1/billing/entitlement').status, 'active');
  fakeDatabase.records.set('users/user-1/billing/entitlement', {
    ...fakeDatabase.records.get('users/user-1/billing/entitlement'),
    pendingVouchers: [{ voucherId: 'queued-webhook-test', durationDays: 7, startsAt: Date.now() + 3_600_000 }]
  });

  const activatedEvent = {
    id: 'evt_activation_1',
    event: 'subscription.activated',
    payload: { subscription: { entity: providerSubscription } }
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
  assert.equal((await signedWebhook(expiredEvent)).status, 200);
  assert.equal(fakeDatabase.records.get('users/user-1/billing/entitlement').planId, 'free');

  const invalidSignature = await fetch(`${origin}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'invalid' },
    body: JSON.stringify(activatedEvent)
  });
  assert.equal(invalidSignature.status, 400);
});
