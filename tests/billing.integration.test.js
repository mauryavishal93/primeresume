import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { billingPeriodEnd, voucherDocumentId } from '../backend/billing.js';
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
    delete: async () => records.delete(key),
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
            .map(([key, data]) => ({ id: key.split('/').at(-1), ref: reference(key), data: () => data }))
        })
      }),
      get: async () => ({
        docs: [...records.entries()]
          .filter(([key]) => key.startsWith(`${name}/`) && key.split('/').length === 2)
          .map(([key, data]) => ({ id: key.split('/').at(-1), ref: reference(key), data: () => data }))
      })
    }),
    collectionGroup: name => ({
      where: (field, operator, value) => ({
        get: async () => ({
          docs: [...records.entries()]
            .filter(([key, data]) => key.split('/').at(-2) === name
              && operator === '=='
              && data[field] === value)
            .map(([key, data]) => ({ id: key.split('/').at(-1), ref: reference(key), data: () => data }))
        })
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
    }),
    recursiveDelete: async ref => {
      for (const key of records.keys()) {
        if (key === ref.key || key.startsWith(`${ref.key}/`)) records.delete(key);
      }
    }
  };
  db.records = records;
  return { db, records };
}

let server;
let origin;
let fakeDatabase;
let providerSubscription;
const providerSubscriptions = new Map();
const providerInvoices = new Map();
let nextSubscriptionId = 0;
const authUsers = new Map([
  ['user-1', { uid: 'user-1', email: 'paid@example.com', disabled: false }],
  ['user-2', { uid: 'user-2', email: 'expired@example.com', disabled: false }],
  ['user-3', { uid: 'user-3', email: 'free@example.com', disabled: false }],
  ['user-4', { uid: 'user-4', email: 'ban@example.com', disabled: false }],
  ['user-5', { uid: 'user-5', email: 'delete@example.com', disabled: false }],
  ['user-6', { uid: 'user-6', email: 'ban-provider-failure@example.com', disabled: false }],
  ['user-7', { uid: 'user-7', email: 'delete-provider-failure@example.com', disabled: false }],
  ['admin-1', { uid: 'admin-1', email: 'admin@example.com', disabled: false }]
]);
const providerCancellations = [];
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
            { uid: 'user-3', email: 'free@example.com', displayName: 'Free User', metadata: { creationTime: new Date(now - 10 * 86400000).toISOString() } },
          ]
        };
      },
      getUser: async uid => {
        if (!authUsers.has(uid)) {
          const error = new Error('User not found');
          error.code = 'auth/user-not-found';
          throw error;
        }
        return authUsers.get(uid);
      },
      getUserByEmail: async email => {
        const user = [...authUsers.values()].find(item => item.email?.toLowerCase() === email.toLowerCase());
        if (!user) {
          const error = new Error('User not found');
          error.code = 'auth/user-not-found';
          throw error;
        }
        return user;
      },
      updateUser: async (uid, changes) => {
        const user = authUsers.get(uid);
        if (!user) throw new Error('User not found');
        Object.assign(user, changes);
        return user;
      },
      revokeRefreshTokens: async () => {},
      deleteUser: async uid => {
        if (!authUsers.delete(uid)) throw new Error('User not found');
      },
      verifyIdToken: async token => {
        if (token === 'valid-test-token') return { uid: 'user-1' };
        if (token === 'other-test-token') return { uid: 'user-2' };
        if (token === 'third-test-token') return { uid: 'user-3' };
        if (token === 'fourth-test-token') return { uid: 'user-4' };
        if (token === 'fifth-test-token') return { uid: 'user-5' };
        if (token === 'admin-test-token') return { uid: 'admin-1', email: 'admin@example.com' };
        throw new Error('Invalid token');
      }
    },
    db: fakeDatabase.db
  };
  app.locals.razorpayRequest = async (endpoint, { method = 'GET', body } = {}) => {
    const invoiceList = endpoint.match(/^\/invoices\?subscription_id=([^&]+)&count=(\d+)&skip=(\d+)$/);
    if (invoiceList) {
      const [, subscriptionId, count, skip] = invoiceList;
      const items = (providerInvoices.get(decodeURIComponent(subscriptionId)) || [])
        .slice(Number(skip), Number(skip) + Number(count));
      return { count: items.length, items };
    }
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
    const cancelMatch = endpoint.match(/^\/subscriptions\/([^/]+)\/cancel$/);
    if (cancelMatch && method === 'POST') {
      providerCancellations.push({ subscriptionId: cancelMatch[1], body });
      return { id: cancelMatch[1], status: body.cancel_at_cycle_end ? 'active' : 'cancelled' };
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

test('earned scheduled referral days extend active Pro expiry without extending paid billing records', async () => {
  const uid = 'user-1';
  const entitlementKey = `users/${uid}/billing/entitlement`;
  const originalEntitlement = fakeDatabase.records.get(entitlementKey);
  const freeEntitlementKey = 'users/user-3/billing/entitlement';
  const originalFreeEntitlement = fakeDatabase.records.get(freeEntitlementKey);
  const originalReferralFlag = process.env.REFERRALS_ENABLED;
  const rewardKey = 'referralRewards/test-scheduled-registration-reward';
  const originalReward = fakeDatabase.records.get(rewardKey);
  const freeRewardKey = 'referralRewards/test-future-registration-reward';
  const originalFreeReward = fakeDatabase.records.get(freeRewardKey);
  const now = Date.now();
  const paidUntil = now + 5 * 86_400_000;
  const rewardUntil = paidUntil + 7 * 86_400_000;
  process.env.REFERRALS_ENABLED = 'true';
  fakeDatabase.records.set(entitlementKey, {
    planId: 'pro',
    billingPlan: 'voucher',
    status: 'active',
    source: 'server-verified',
    lifetime: false,
    validUntil: paidUntil
  });
  fakeDatabase.records.set(rewardKey, {
    beneficiaryUid: uid,
    rewardType: 'registration',
    status: 'scheduled',
    startsAt: paidUntil,
    expiresAt: rewardUntil
  });

  try {
    const response = await request('/api/billing/entitlement', { token: 'valid-test-token' });
    assert.equal(response.status, 200);
    const { entitlement } = await response.json();
    assert.equal(entitlement.status, 'active');
    assert.equal(entitlement.validUntil, rewardUntil);
    assert.equal(entitlement.promotionalValidUntil, rewardUntil);
    assert.equal(fakeDatabase.records.get(entitlementKey).validUntil, paidUntil);

    fakeDatabase.records.set(freeEntitlementKey, {
      planId: 'free',
      billingPlan: 'voucher',
      status: 'inactive',
      source: 'server-verified',
      lifetime: false,
      validUntil: 0
    });
    fakeDatabase.records.set(freeRewardKey, {
      beneficiaryUid: 'user-3',
      rewardType: 'registration',
      status: 'scheduled',
      startsAt: now + 86_400_000,
      expiresAt: now + 8 * 86_400_000
    });
    const futureOnlyResponse = await request('/api/billing/entitlement', { token: 'third-test-token' });
    assert.equal(futureOnlyResponse.status, 200);
    const futureOnly = (await futureOnlyResponse.json()).entitlement;
    assert.equal(futureOnly.status, 'inactive');
    assert.equal(futureOnly.planId, 'free');
    assert.equal(futureOnly.validUntil, 0);
    assert.equal(futureOnly.promotionalValidUntil, now + 8 * 86_400_000);
  } finally {
    if (originalEntitlement === undefined) fakeDatabase.records.delete(entitlementKey);
    else fakeDatabase.records.set(entitlementKey, originalEntitlement);
    if (originalFreeEntitlement === undefined) fakeDatabase.records.delete(freeEntitlementKey);
    else fakeDatabase.records.set(freeEntitlementKey, originalFreeEntitlement);
    if (originalReward === undefined) fakeDatabase.records.delete(rewardKey);
    else fakeDatabase.records.set(rewardKey, originalReward);
    if (originalFreeReward === undefined) fakeDatabase.records.delete(freeRewardKey);
    else fakeDatabase.records.set(freeRewardKey, originalFreeReward);
    if (originalReferralFlag === undefined) delete process.env.REFERRALS_ENABLED;
    else process.env.REFERRALS_ENABLED = originalReferralFlag;
  }
});

test('active voucher and referral Pro can prepay a plan period before recurring billing begins', async () => {
  const originalReferralFlag = process.env.REFERRALS_ENABLED;
  const originalRazorpayRequest = app.locals.razorpayRequest;
  const uidKeys = [
    'users/user-3/billing/entitlement',
    'users/user-3/billing/checkout',
    'users/user-4/billing/entitlement',
    'users/user-4/billing/checkout',
    'users/user-2/billing/entitlement',
    'users/user-2/billing/checkout',
    'users/user-1/billing/entitlement',
    'users/user-1/billing/checkout'
  ];
  const rewardKey = 'referralRewards/test-deferred-subscription-reward';
  const legacySubscriptionId = 'sub_legacyvoucher';
  const deferredPaymentKeys = ['billingPayments/pay_deferredverify', 'billingAccessHistory/pay_deferredverify'];
  const previousDeferredPaymentRecords = deferredPaymentKeys
    .map(key => [key, fakeDatabase.records.get(key)]);
  const previousActivityKeys = new Set([...fakeDatabase.records.keys()]
    .filter(key => key.startsWith('users/user-3/billingActivity/')));
  const keys = [...uidKeys, rewardKey];
  const previousRecords = keys.map(key => [key, fakeDatabase.records.get(key)]);
  const createdSubscriptionIds = [];
  const subscriptionRequests = [];
  const previousNextSubscriptionId = nextSubscriptionId;
  const now = Date.now();
  const voucherValidUntil = now + 5 * 86_400_000;
  const referralValidUntil = now + 8 * 86_400_000;
  process.env.REFERRALS_ENABLED = 'true';
  fakeDatabase.records.set(uidKeys[0], {
    planId: 'pro',
    billingPlan: 'voucher',
    status: 'active',
    source: 'server-verified',
    lifetime: false,
    validUntil: voucherValidUntil
  });
  fakeDatabase.records.set(`billingSubscriptions/${legacySubscriptionId}`, {
    uid: 'user-3',
    planKey: 'monthly',
    currency: 'INR',
    planId: 'plan_monthly_test',
    amount: 9900,
    status: 'created'
  });
  providerSubscriptions.set(legacySubscriptionId, {
    id: legacySubscriptionId,
    plan_id: 'plan_monthly_test',
    status: 'created',
    paid_count: 0
  });
  fakeDatabase.records.set(uidKeys[2], {
    planId: 'free',
    billingPlan: 'free',
    status: 'inactive',
    source: 'server-verified',
    lifetime: false,
    validUntil: 0
  });
  fakeDatabase.records.set(rewardKey, {
    beneficiaryUid: 'user-4',
    rewardType: 'registration',
    status: 'active',
    startsAt: now - 1000,
    expiresAt: referralValidUntil
  });
  for (const checkoutIndex of [1, 3, 5, 7]) {
    fakeDatabase.records.delete(uidKeys[checkoutIndex]);
  }
  fakeDatabase.records.set(uidKeys[1], {
    requestId: 'legacy_voucher_checkout',
    planKey: 'monthly',
    currency: 'INR',
    scheduledStartAt: voucherValidUntil,
    status: 'created',
    subscriptionId: legacySubscriptionId
  });
  app.locals.razorpayRequest = async (endpoint, options = {}) => {
    if (endpoint === '/subscriptions' && options.method === 'POST') {
      subscriptionRequests.push(options.body);
    }
    const result = await originalRazorpayRequest(endpoint, options);
    if (endpoint === '/subscriptions' && options.method === 'POST') createdSubscriptionIds.push(result.id);
    return result;
  };
  const trackingRazorpayRequest = app.locals.razorpayRequest;
  app.locals.razorpayRequest = async (endpoint, options = {}) => {
    const result = await trackingRazorpayRequest(endpoint, options);
    const cancellation = endpoint.match(/^\/subscriptions\/([^/]+)\/cancel$/);
    if (cancellation && options.method === 'POST') {
      const current = providerSubscriptions.get(cancellation[1]);
      if (current) providerSubscriptions.set(cancellation[1], { ...current, status: 'cancelled' });
    }
    return result;
  };

  try {
    const voucherCheckout = await request('/api/billing/subscriptions', {
      method: 'POST',
      token: 'third-test-token',
      body: { planKey: 'monthly', currency: 'INR', expectedAmount: 9900 }
    });
    const voucherBody = await voucherCheckout.json();
    assert.equal(voucherCheckout.status, 201, JSON.stringify(voucherBody));
    assert.equal(voucherBody.scheduledAt, voucherValidUntil);
    const voucherMonthlyEnd = billingPeriodEnd(voucherValidUntil, 'monthly');
    assert.equal(subscriptionRequests[0].start_at, Math.ceil(voucherMonthlyEnd / 1000));
    assert.equal(subscriptionRequests[0].addons[0].item.amount, 9900);
    assert.equal(providerCancellations.some(item => item.subscriptionId === legacySubscriptionId), true);
    assert.equal(voucherBody.scheduledAt, voucherValidUntil);
    assert.equal(voucherBody.recurringAt, voucherMonthlyEnd);
    assert.equal(
      fakeDatabase.records.get(`billingSubscriptions/${voucherBody.subscriptionId}`).scheduledStartAt,
      voucherMonthlyEnd
    );
    const earlyActivation = {
      id: voucherBody.subscriptionId,
      plan_id: 'plan_monthly_test',
      status: 'active',
      current_end: Math.floor((voucherValidUntil + 30 * 86_400_000) / 1000)
    };
    providerSubscriptions.set(voucherBody.subscriptionId, earlyActivation);
    const earlyActivationResponse = await signedWebhook({
      id: 'evt_deferred_subscription_early_activation',
      event: 'subscription.activated',
      payload: { subscription: { entity: earlyActivation } }
    });
    assert.equal(earlyActivationResponse.status, 200);
    const voucherAfterWebhook = fakeDatabase.records.get(uidKeys[0]);
    assert.equal(voucherAfterWebhook.billingPlan, 'voucher');
    assert.equal(voucherAfterWebhook.validUntil, voucherValidUntil);

    const referralCheckout = await request('/api/billing/subscriptions', {
      method: 'POST',
      token: 'fourth-test-token',
      body: { planKey: 'monthly', currency: 'INR', expectedAmount: 9900 }
    });
    const referralBody = await referralCheckout.json();
    assert.equal(referralCheckout.status, 201, JSON.stringify(referralBody));
    assert.equal(referralBody.scheduledAt, referralValidUntil);
    assert.equal(subscriptionRequests[1].start_at, Math.ceil(billingPeriodEnd(referralValidUntil, 'monthly') / 1000));
    assert.equal(subscriptionRequests[1].addons[0].item.amount, 9900);

    const replacedCheckout = await request('/api/billing/subscriptions', {
      method: 'POST',
      token: 'fourth-test-token',
      body: { planKey: 'yearly', currency: 'INR', expectedAmount: 39900 }
    });
    const replacedBody = await replacedCheckout.json();
    assert.equal(replacedCheckout.status, 201, JSON.stringify(replacedBody));
    assert.equal(replacedBody.scheduledAt, referralValidUntil);
    const referralYearlyEnd = billingPeriodEnd(referralValidUntil, 'yearly');
    assert.equal(subscriptionRequests[2].start_at, Math.ceil(referralYearlyEnd / 1000));
    assert.equal(subscriptionRequests[2].addons[0].item.amount, 39900);
    assert.equal(
      fakeDatabase.records.get(`billingSubscriptions/${referralBody.subscriptionId}`).status,
      'cancelled'
    );
    assert.equal(
      providerCancellations.some(item => item.subscriptionId === referralBody.subscriptionId
        && item.body.cancel_at_cycle_end === false),
      true
    );

    const deferredPaymentId = 'pay_deferredverify';
    const deferredPaymentSignature = createHmac('sha256', environment.RAZORPAY_KEY_SECRET)
      .update(`${deferredPaymentId}|${voucherBody.subscriptionId}`)
      .digest('hex');
    app.locals.razorpayRequest = async (endpoint, options = {}) => {
      if (endpoint === `/payments/${deferredPaymentId}`) {
        return {
          id: deferredPaymentId,
          subscription_id: voucherBody.subscriptionId,
          status: 'captured',
          amount: 9900,
          currency: 'INR',
          created_at: Math.floor(Date.now() / 1000)
        };
      }
      return originalRazorpayRequest(endpoint, options);
    };
    const verification = await request('/api/billing/verify', {
      method: 'POST',
      token: 'third-test-token',
      body: {
        razorpayPaymentId: deferredPaymentId,
        razorpaySubscriptionId: voucherBody.subscriptionId,
        razorpaySignature: deferredPaymentSignature
      }
    });
    const verificationBody = await verification.json();
    assert.equal(verification.status, 200, JSON.stringify(verificationBody));
    assert.equal(verificationBody.pending, undefined);
    assert.equal(verificationBody.entitlement.status, 'active');
    assert.equal(fakeDatabase.records.get(uidKeys[0]).billingPlan, 'monthly');
    assert.equal(fakeDatabase.records.get(uidKeys[0]).validUntil, voucherMonthlyEnd);
    app.locals.razorpayRequest = trackingRazorpayRequest;

    fakeDatabase.records.set(uidKeys[4], {
      planId: 'pro',
      billingPlan: 'voucher',
      status: 'active',
      source: 'server-verified',
      lifetime: false,
      validUntil: voucherValidUntil
    });
    const voucherYearly = await request('/api/billing/subscriptions', {
      method: 'POST',
      token: 'other-test-token',
      body: { planKey: 'yearly', currency: 'INR', expectedAmount: 39900 }
    });
    const voucherYearlyBody = await voucherYearly.json();
    assert.equal(voucherYearly.status, 201, JSON.stringify(voucherYearlyBody));
    assert.equal(voucherYearlyBody.scheduledAt, voucherValidUntil);
    assert.equal(subscriptionRequests[3].start_at, Math.ceil(billingPeriodEnd(voucherValidUntil, 'yearly') / 1000));
    assert.equal(subscriptionRequests[3].addons[0].item.amount, 39900);

    fakeDatabase.records.set(uidKeys[6], {
      planId: 'pro',
      billingPlan: 'monthly',
      status: 'active',
      source: 'server-verified',
      validUntil: now + 30 * 86_400_000,
      subscriptionId: 'sub_activepaidcheckout'
    });
    const activePaidCheckout = await request('/api/billing/subscriptions', {
      method: 'POST',
      token: 'valid-test-token',
      body: { planKey: 'monthly', currency: 'INR', expectedAmount: 9900 }
    });
    assert.equal(activePaidCheckout.status, 409);
    assert.match((await activePaidCheckout.json()).error, /already has active Pro access/i);
    assert.equal(subscriptionRequests.length, 4);

    const voucherEntitlementResponse = await request('/api/billing/entitlement', {
      token: 'third-test-token'
    });
    const voucherEntitlement = (await voucherEntitlementResponse.json()).entitlement;
    assert.equal(voucherEntitlement.canScheduleSubscriptionAfterPromotional, false);
    assert.equal(voucherEntitlement.pendingSubscriptionStartAt, voucherMonthlyEnd);
    assert.equal(voucherEntitlement.pendingSubscriptionPrepaidStartsAt, voucherValidUntil);
    assert.equal(voucherEntitlement.pendingSubscriptionPlan, 'monthly');
  } finally {
    app.locals.razorpayRequest = originalRazorpayRequest;
    providerSubscriptions.delete(legacySubscriptionId);
    fakeDatabase.records.delete(`billingSubscriptions/${legacySubscriptionId}`);
    for (const key of deferredPaymentKeys) fakeDatabase.records.delete(key);
    for (const key of [...fakeDatabase.records.keys()]) {
      if (key.startsWith('users/user-3/billingActivity/') && !previousActivityKeys.has(key)) {
        fakeDatabase.records.delete(key);
      }
    }
    for (const [key, value] of previousDeferredPaymentRecords) {
      if (value === undefined) fakeDatabase.records.delete(key);
      else fakeDatabase.records.set(key, value);
    }
    for (const subscriptionId of createdSubscriptionIds) {
      fakeDatabase.records.delete(`billingSubscriptions/${subscriptionId}`);
      providerSubscriptions.delete(subscriptionId);
    }
    for (const [key, value] of previousRecords) {
      if (value === undefined) fakeDatabase.records.delete(key);
      else fakeDatabase.records.set(key, value);
    }
    nextSubscriptionId = previousNextSubscriptionId;
    if (originalReferralFlag === undefined) delete process.env.REFERRALS_ENABLED;
    else process.env.REFERRALS_ENABLED = originalReferralFlag;
  }
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

test('non-INR subscriptions cannot schedule new yearly billing', async () => {
  const subscriptionId = 'sub_switchusd';
  const validUntil = Date.now() + 30 * 24 * 60 * 60 * 1000;
  fakeDatabase.records.set(`billingSubscriptions/${subscriptionId}`, {
    uid: 'user-4',
    planKey: 'monthly',
    planId: 'plan_monthly_usd_test',
    currency: 'USD'
  });
  fakeDatabase.records.set('users/user-4/billing/entitlement', {
    planId: 'pro',
    billingPlan: 'monthly',
    currency: 'USD',
    validUntil,
    subscriptionId
  });

  try {
    const response = await request('/api/billing/change-plan', {
      method: 'POST',
      token: 'fourth-test-token',
      body: { planKey: 'yearly' }
    });

    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /Plan changes are available only for INR subscriptions/);
    assert.equal(fakeDatabase.records.get('users/user-4/billing/entitlement').scheduledPlan, undefined);
  } finally {
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
  assert.equal(dynamicBillingConfig.currencyPlans.USD, undefined);
  assert.deepEqual(dynamicBillingConfig.supportedCurrencies, ['INR']);

  const configuredMonthlyPlanId = process.env.RAZORPAY_PLAN_MONTHLY_ID;
  process.env.RAZORPAY_PLAN_MONTHLY_ID = 'sub_not_a_plan_id';
  try {
    const configWithSubscriptionId = await request('/api/billing/config');
    const configWithSubscriptionIdBody = await configWithSubscriptionId.json();
    assert.equal(configWithSubscriptionIdBody.checkoutEnabled, true);
    assert.ok(configWithSubscriptionIdBody.supportedCurrencies.includes('INR'));
    assert.deepEqual(configWithSubscriptionIdBody.supportedCurrencies, ['INR']);
  } finally {
    process.env.RAZORPAY_PLAN_MONTHLY_ID = configuredMonthlyPlanId;
  }

  const stalePriceCheckout = await request('/api/billing/subscriptions', {
    method: 'POST',
    token: 'third-test-token',
    body: { planKey: 'monthly', currency: 'INR', expectedAmount: 9900 }
  });
  assert.equal(stalePriceCheckout.status, 409);
  assert.equal(fakeDatabase.records.has('users/user-3/billing/checkout'), false);

  const checkout = await request('/api/billing/subscriptions', {
    method: 'POST',
    token: 'third-test-token',
    body: { planKey: 'monthly', currency: 'INR', expectedAmount: 10900 }
  });
  const checkoutBody = await checkout.json();
  assert.equal(checkout.status, 201, JSON.stringify(checkoutBody));
  assert.equal(checkoutBody.plan.amount, 10900);
  assert.equal(fakeDatabase.records.get('billingSubscriptions/sub_test1').planId, inrPlanId);
  assert.equal(fakeDatabase.records.get('billingSubscriptions/sub_test1').amount, 10900);

  providerSubscription = {
    id: 'sub_test1',
    plan_id: inrPlanId,
    status: 'active',
    current_end: Math.floor(Date.now() / 1000) + 3600,
    notes: { plan_key: 'monthly', currency: 'INR' }
  };
  providerSubscriptions.set('sub_test1', providerSubscription);
  const signature = createHmac('sha256', environment.RAZORPAY_KEY_SECRET)
    .update('pay_test1|sub_test1')
    .digest('hex');
  const reversedSignature = createHmac('sha256', environment.RAZORPAY_KEY_SECRET)
    .update('sub_test1|pay_test1')
    .digest('hex');
  const reversedVerification = await request('/api/billing/verify', {
    method: 'POST',
    token: 'third-test-token',
    body: {
      razorpaySubscriptionId: 'sub_test1',
      razorpayPaymentId: 'pay_test1',
      razorpaySignature: reversedSignature
    }
  });
  assert.equal(reversedVerification.status, 400);
  assert.equal((await reversedVerification.json()).error, 'Payment signature verification failed.');
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
  assert.equal(fakeDatabase.records.get('billingPayments/pay_test1').amount, 10900);
  assert.equal(fakeDatabase.records.get('billingPayments/pay_test1').currency, 'INR');

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

test('checkout accepts INR only and rejects requests for other currencies', async () => {
  const configResponse = await request('/api/billing/config');
  const config = await configResponse.json();
  assert.deepEqual(config.supportedCurrencies, ['INR']);
  assert.equal(config.currencyPlans.USD, undefined);

  const unsupportedCurrency = await request('/api/billing/subscriptions', {
    method: 'POST',
    token: 'third-test-token',
    body: { planKey: 'monthly', currency: 'EUR' }
  });
  assert.equal(unsupportedCurrency.status, 400);
  assert.match((await unsupportedCurrency.json()).error, /Only INR subscriptions are supported/);

  const usdCheckout = await request('/api/billing/subscriptions', {
    method: 'POST',
    token: 'third-test-token',
    body: { planKey: 'monthly', currency: 'USD', expectedAmount: 367, amount: 1 }
  });
  assert.equal(usdCheckout.status, 400);
  assert.match((await usdCheckout.json()).error, /Only INR subscriptions are supported/);
});

test('admin dashboard reports current subscriptions and captured revenue accurately', async () => {
  const originalAdminEmails = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'admin@example.com';
  const now = Date.now();
  const testRecords = [
    ['users/user-1/billing/entitlement', {
      planId: 'pro', billingPlan: 'monthly', status: 'active', source: 'server-verified', validUntil: now + 30 * 86400000
    }],
    ['users/user-1/billing/checkout', { subscriptionId: 'sub_dashboardfallback' }],
    ['users/user-2/billing/entitlement', {
      planId: 'pro', billingPlan: 'yearly', status: 'expired', source: 'razorpay', validUntil: now - 86400000
    }],
    ['users/user-3/billing/entitlement', {
      planId: 'pro', billingPlan: 'voucher', status: 'inactive', source: 'server-verified', validUntil: now + 30 * 86400000
    }],
    ['billingPayments/pay_dashboardcurrent', {
      uid: 'user-1', providerPaymentId: 'pay_dashboardcurrent', subscriptionId: 'sub_dashboardfallback',
      status: 'captured', amount: 9900, currency: 'INR', planKey: 'monthly', createdAt: now
    }],
    ['billingPayments/pay_dashboardold', {
      uid: 'user-1', providerPaymentId: 'pay_dashboardold', subscriptionId: 'sub_dashboardold',
      status: 'captured', amount: 39900, currency: 'INR', planKey: 'yearly', createdAt: now - 45 * 86400000
    }],
    ['billingPayments/pay_dashboardauthorized', {
      uid: 'user-2', status: 'authorized', amount: 12000, currency: 'INR', planKey: 'monthly', createdAt: now
    }],
    ['billingPayments/manual_payment', {
      uid: 'user-1', providerPaymentId: 'manual_payment', status: 'success', source: 'admin',
      amount: 50000, currency: 'INR', createdAt: now
    }],
    ['billingPayments/pay_invalidamount', {
      uid: 'user-1', providerPaymentId: 'pay_invalidamount', subscriptionId: 'sub_dashboardfallback',
      status: 'captured', amount: 99.5, currency: 'INR', createdAt: now
    }]
  ];
  for (const [key, value] of testRecords) fakeDatabase.records.set(key, value);

  try {
    const response = await request('/api/admin/dashboard', { token: 'admin-test-token' });
    assert.equal(response.status, 200);
    const dashboard = await response.json();

    assert.equal(dashboard.totals.users, 3);
    assert.equal(dashboard.totals.pro, 2);
    assert.equal(dashboard.totals.regular, 1);
    assert.equal(dashboard.totals.newUsers30Days, 2);
    assert.equal(dashboard.totals.conversionRate, 66.7);
    assert.equal(dashboard.totals.monthlyPro, 1);
    assert.equal(dashboard.totals.yearlyPro, 0);
    assert.equal(dashboard.totals.earnings, 49800);
    assert.equal(dashboard.totals.earningsThisMonth, 9900);
    assert.equal(dashboard.totals.paymentsThisMonth, 1);
    assert.equal(dashboard.totals.paymentCount, 2);
    assert.equal(dashboard.recentPayments.length, 2);
    assert.equal(dashboard.recentPayments[0].id, 'pay_dashboardcurrent');
    assert.equal(dashboard.users.find(user => user.uid === 'user-1').paidAmount, 49800);
    assert.equal(dashboard.users.find(user => user.uid === 'user-1').paymentCount, 2);
    assert.equal(dashboard.users.find(user => user.uid === 'user-1').activationSource, 'payment');
    assert.equal(dashboard.users.find(user => user.uid === 'user-1').subscriptionId, 'sub_dashboardfallback');
    const voucherUser = dashboard.users.find(user => user.uid === 'user-3');
    assert.equal(voucherUser.isPro, true);
    assert.equal(voucherUser.plan, 'pro');
    assert.equal(voucherUser.billingPlan, 'voucher');
    assert.equal(voucherUser.activationSource, 'voucher');
    assert.equal(dashboard.users.find(user => user.uid === 'user-2').isPro, false);
  } finally {
    for (const [key] of testRecords) fakeDatabase.records.delete(key);
    if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = originalAdminEmails;
  }
});

test('admin dashboard includes active and scheduled referral Pro rewards in activation and expiry', async () => {
  const originalAdminEmails = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'admin@example.com';
  const now = Date.now();
  const records = [
    ['users/user-4', { email: 'scheduled@example.com', name: 'Scheduled User' }],
    ['users/user-5', { email: 'admin-grant-referral@example.com' }],
    ['users/user-6', { email: 'voucher-referral@example.com' }],
    ['users/user-7', { email: 'referral-only@example.com' }],
    ['users/user-1/billing/entitlement', {
      planId: 'pro', billingPlan: 'monthly', status: 'active', source: 'server-verified',
      validUntil: now + 86400000
    }],
    ['users/user-2/billing/entitlement', {
      planId: 'pro', billingPlan: 'yearly', status: 'expired', source: 'razorpay',
      validUntil: now - 86400000
    }],
    ['users/user-5/billing/entitlement', {
      planId: 'pro', billingPlan: 'monthly', status: 'active', source: 'admin',
      validUntil: now + 5 * 86400000
    }],
    ['users/user-6/billing/entitlement', {
      planId: 'pro', billingPlan: 'voucher', status: 'expired', source: 'server-verified',
      validUntil: now - 86400000
    }],
    ['referralRewards/referrer-active', {
      beneficiaryUid: 'user-1', rewardSource: 'referral', rewardType: 'registration',
      status: 'active', startsAt: now - 86400000, expiresAt: now + 6 * 86400000
    }],
    ['referralRewards/referrer-scheduled', {
      beneficiaryUid: 'user-1', rewardSource: 'referral', rewardType: 'registration',
      status: 'scheduled', startsAt: now + 2 * 86400000, expiresAt: now + 9 * 86400000
    }],
    ['referralRewards/referred-active', {
      beneficiaryUid: 'user-2', rewardSource: 'referral', rewardType: 'registration',
      status: 'active', startsAt: now - 86400000, expiresAt: now + 6 * 86400000
    }],
    ['referralRewards/admin-grant-referral', {
      beneficiaryUid: 'user-5', rewardSource: 'referral', rewardType: 'registration',
      status: 'active', startsAt: now - 86400000, expiresAt: now + 6 * 86400000
    }],
    ['referralRewards/voucher-referral', {
      beneficiaryUid: 'user-6', rewardSource: 'referral', rewardType: 'registration',
      status: 'active', startsAt: now - 86400000, expiresAt: now + 6 * 86400000
    }],
    ['referralRewards/referral-only', {
      beneficiaryUid: 'user-7', rewardSource: 'referral', rewardType: 'registration',
      status: 'active', startsAt: now - 86400000, expiresAt: now + 6 * 86400000
    }],
    ['referralRewards/future-only', {
      beneficiaryUid: 'user-4', rewardSource: 'referral', rewardType: 'registration',
      status: 'scheduled', startsAt: now + 2 * 86400000, expiresAt: now + 9 * 86400000
    }],
    ['referralRewards/expired-only', {
      beneficiaryUid: 'user-3', rewardSource: 'referral', rewardType: 'registration',
      status: 'expired', startsAt: now - 9 * 86400000, expiresAt: now - 2 * 86400000
    }],
    ['referralRewards/reversed-original', {
      beneficiaryUid: 'user-3', rewardSource: 'referral', rewardType: 'conversion',
      status: 'active', startsAt: now - 86400000, expiresAt: now + 6 * 86400000
    }],
    ['referralRewards/reversal', {
      beneficiaryUid: 'user-3', rewardSource: 'referral', rewardType: 'reversal',
      status: 'revoked', originalRewardId: 'reversed-original'
    }]
  ];
  const previousRecords = records.map(([key]) => [key, fakeDatabase.records.get(key)]);
  for (const [key, value] of records) fakeDatabase.records.set(key, value);

  try {
    const response = await request('/api/admin/dashboard', { token: 'admin-test-token' });
    assert.equal(response.status, 200);
    const dashboard = await response.json();
    const referrer = dashboard.users.find(user => user.uid === 'user-1');
    assert.equal(referrer.isPro, true);
    assert.equal(referrer.activationSource, 'payment');
    assert.equal(referrer.validUntil, now + 9 * 86400000);
    const referredUser = dashboard.users.find(user => user.uid === 'user-2');
    assert.equal(referredUser.isPro, true);
    assert.equal(referredUser.activationSource, 'referral');
    assert.equal(referredUser.billingPlan, 'referral');
    assert.equal(referredUser.validUntil, now + 6 * 86400000);
    const futureOnlyUser = dashboard.users.find(user => user.uid === 'user-4');
    assert.equal(futureOnlyUser.isPro, false);
    assert.equal(futureOnlyUser.activationSource, null);
    assert.notEqual(futureOnlyUser.validUntil, now + 9 * 86400000);
    const expiredAndReversedUser = dashboard.users.find(user => user.uid === 'user-3');
    assert.equal(expiredAndReversedUser.isPro, false);
    assert.equal(expiredAndReversedUser.activationSource, null);
    assert.equal(dashboard.users.find(user => user.uid === 'user-5').activationSource, 'admin');
    assert.equal(dashboard.users.find(user => user.uid === 'user-6').activationSource, 'voucher');
    assert.equal(dashboard.users.find(user => user.uid === 'user-6').isPro, true);
    assert.equal(dashboard.users.find(user => user.uid === 'user-7').activationSource, 'referral');
  } finally {
    for (const [key, value] of previousRecords) {
      if (value === undefined) fakeDatabase.records.delete(key);
      else fakeDatabase.records.set(key, value);
    }
    if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = originalAdminEmails;
  }
});

test('admin dashboard and user details preserve voucher and admin grants after an old subscription revocation', async () => {
  const originalAdminEmails = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'admin@example.com';
  const now = Date.now();
  const records = [
    ['users/user-3/billing/entitlement', {
      planId: 'pro', billingPlan: 'voucher', status: 'active', source: 'server-verified',
      adminRevoked: false, validUntil: now + 30 * 86400000, updatedAt: now
    }],
    ['users/user-3/billing/checkout', { subscriptionId: 'sub_stalevoucher' }],
    ['billingSubscriptions/sub_stalevoucher', {
      uid: 'user-3', adminRevoked: true, adminRevokedAt: now - 86400000
    }],
    ['users/user-4', { email: 'ban@example.com', name: 'Admin granted user' }],
    ['users/user-4/billing/entitlement', {
      planId: 'pro', billingPlan: 'monthly', status: 'active', source: 'admin',
      validUntil: now + 30 * 86400000, updatedAt: now
    }],
    ['users/user-4/billing/checkout', { subscriptionId: 'sub_staleadmin' }],
    ['billingSubscriptions/sub_staleadmin', {
      uid: 'user-4', adminRevoked: true, adminRevokedAt: now - 86400000
    }]
  ];
  const previousRecords = records.map(([key]) => [key, fakeDatabase.records.get(key)]);
  for (const [key, value] of records) fakeDatabase.records.set(key, value);

  try {
    const dashboardResponse = await request('/api/admin/dashboard', { token: 'admin-test-token' });
    assert.equal(dashboardResponse.status, 200);
    const dashboard = await dashboardResponse.json();
    for (const [uid, activationSource] of [['user-3', 'voucher'], ['user-4', 'admin']]) {
      const user = dashboard.users.find(item => item.uid === uid);
      assert.equal(user.isPro, true);
      assert.equal(user.plan, 'pro');
      assert.equal(user.activationSource, activationSource);

      const detailsResponse = await request(`/api/admin/users/${uid}`, { token: 'admin-test-token' });
      assert.equal(detailsResponse.status, 200);
      const details = await detailsResponse.json();
      assert.equal(details.isPro, true);
      assert.equal(details.entitlement.status, 'active');
    }
  } finally {
    for (const [key, previous] of previousRecords) {
      if (previous === undefined) fakeDatabase.records.delete(key);
      else fakeDatabase.records.set(key, previous);
    }
    if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = originalAdminEmails;
  }
});

test('admin details allow immediate revocation of active voucher Pro access', async () => {
  const originalAdminEmails = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'admin@example.com';
  const entitlementKey = 'users/user-3/billing/entitlement';
  const originalEntitlement = fakeDatabase.records.get(entitlementKey);
  fakeDatabase.records.set(entitlementKey, {
    planId: 'pro',
    billingPlan: 'voucher',
    status: 'inactive',
    source: 'server-verified',
    validUntil: Date.now() + 30 * 86400000,
    subscriptionId: null
  });
  try {
    const detailsResponse = await request('/api/admin/users/user-3', { token: 'admin-test-token' });
    assert.equal(detailsResponse.status, 200);
    const details = await detailsResponse.json();
    assert.equal(details.isPro, true);
    assert.equal(details.entitlement.status, 'active');

    const cancelled = await request('/api/admin/users/user-3/cancel-pro', {
      method: 'POST',
      token: 'admin-test-token',
      body: { reason: 'Admin voucher access revocation', timing: 'immediate' }
    });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).isPro, false);
    assert.equal(fakeDatabase.records.get(entitlementKey).planId, 'free');
    assert.equal(fakeDatabase.records.get(entitlementKey).adminRevoked, true);
  } finally {
    if (originalEntitlement) fakeDatabase.records.set(entitlementKey, originalEntitlement);
    else fakeDatabase.records.delete(entitlementKey);
    if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = originalAdminEmails;
  }
});

test('admin lists lifetime and legacy-date Pro entitlements and can revoke lifetime access', async () => {
  const originalAdminEmails = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'admin@example.com';
  const lifetimeKey = 'users/user-3/billing/entitlement';
  const legacyDateKey = 'users/user-1/billing/entitlement';
  const voucherKey = 'adminVouchers/legacy-lifetime-voucher';
  const originalLifetime = fakeDatabase.records.get(lifetimeKey);
  const originalLegacyDate = fakeDatabase.records.get(legacyDateKey);
  const originalVoucher = fakeDatabase.records.get(voucherKey);
  const revokedAt = Date.now() - 2 * 86400000;
  const redeemedAt = Date.now() - 86400000;
  fakeDatabase.records.set(lifetimeKey, {
    planId: 'free',
    billingPlan: 'voucher',
    status: 'inactive',
    source: 'server-verified',
    adminRevoked: true,
    adminRevokedAt: revokedAt
  });
  fakeDatabase.records.set(voucherKey, {
    code: 'LIFETIME-LEGACY',
    lifetime: true,
    durationLabel: 'Lifetime',
    redeemedByUid: 'user-3',
    redeemedAt
  });
  fakeDatabase.records.set(legacyDateKey, {
    planId: 'pro',
    billingPlan: 'monthly',
    status: 'inactive',
    source: 'server-verified',
    lifetime: false,
    validUntil: new Date(Date.now() + 30 * 86400000).toISOString()
  });
  try {
    const dashboardResponse = await request('/api/admin/dashboard', { token: 'admin-test-token' });
    assert.equal(dashboardResponse.status, 200);
    const dashboard = await dashboardResponse.json();
    assert.equal(dashboard.totals.pro, 2);
    const lifetimeUser = dashboard.users.find(user => user.uid === 'user-3');
    assert.equal(lifetimeUser.isPro, true);
    assert.equal(lifetimeUser.lifetime, true);
    assert.equal(lifetimeUser.plan, 'pro');
    assert.equal(lifetimeUser.billingPlan, 'voucher');
    assert.equal(lifetimeUser.activationSource, 'voucher');
    assert.equal(lifetimeUser.isPro, true);
    assert.equal(dashboard.users.find(user => user.uid === 'user-1').isPro, true);

    const detailsResponse = await request('/api/admin/users/user-3', { token: 'admin-test-token' });
    assert.equal(detailsResponse.status, 200);
    const details = await detailsResponse.json();
    assert.equal(details.isPro, true);
    assert.equal(details.entitlement.status, 'active');
    assert.equal(details.entitlement.planId, 'pro');
    assert.equal(details.entitlement.lifetime, true);

    const revoked = await request('/api/admin/users/user-3/cancel-pro', {
      method: 'POST',
      token: 'admin-test-token',
      body: { reason: 'Remove lifetime voucher access', timing: 'immediate' }
    });
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json()).isPro, false);
    assert.equal(fakeDatabase.records.get(lifetimeKey).adminRevoked, true);
    assert.equal(fakeDatabase.records.get(lifetimeKey).planId, 'free');
  } finally {
    if (originalLifetime) fakeDatabase.records.set(lifetimeKey, originalLifetime);
    else fakeDatabase.records.delete(lifetimeKey);
    if (originalLegacyDate) fakeDatabase.records.set(legacyDateKey, originalLegacyDate);
    else fakeDatabase.records.delete(legacyDateKey);
    if (originalVoucher) fakeDatabase.records.set(voucherKey, originalVoucher);
    else fakeDatabase.records.delete(voucherKey);
    if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = originalAdminEmails;
  }
});

test('vouchers are single-use, require an inactive account, respect UID assignments, and support lifetime access', async () => {
  const recordsBefore = new Map(fakeDatabase.records);
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

  fakeDatabase.records.set('users/user-1/billing/entitlement', {
    planId: 'free',
    billingPlan: 'free',
    status: 'inactive',
    adminRevoked: true,
    adminRevokedAt: Date.now() - 86400000
  });
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
  assert.equal(entitlement.status, 'active');
  assert.equal(fakeDatabase.records.get('users/user-1/billing/entitlement').adminRevoked, false);
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
  assert.equal(secondAccount.status, 409);

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
  assert.equal(activeAccount.status, 409);
  assert.match((await activeAccount.json()).error, /cannot redeem a voucher.*active Pro access/i);

  const activeEntitlementKey = 'users/user-1/billing/entitlement';
  fakeDatabase.records.set(activeEntitlementKey, {
    ...fakeDatabase.records.get(activeEntitlementKey),
    validUntil: Date.now() - 1
  });
  const firstLimited = await request('/api/billing/vouchers/redeem', {
    method: 'POST',
    token: 'valid-test-token',
    body: { code: 'LIMITED7' }
  });
  assert.equal(firstLimited.status, 200);
  assert.equal((await firstLimited.json()).entitlement.billingPlan, 'voucher');

  const capped = await request('/api/billing/vouchers/redeem', {
    method: 'POST',
    token: 'third-test-token',
    body: { code: 'LIMITED7' }
  });
  assert.equal(capped.status, 409);
  assert.match((await capped.json()).error, /redemption limit/i);

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
  assert.equal((await assignedAccount.json()).queued, false);
  const assignedDuplicate = await request('/api/billing/vouchers/redeem', {
    method: 'POST',
    token: 'fourth-test-token',
    body: { code: assignedCode }
  });
  assert.equal(assignedDuplicate.status, 409);

  const lifetimeCode = 'LIFETIME-TEST-1';
  const lifetimeId = voucherDocumentId(lifetimeCode);
  fakeDatabase.records.set(`adminVouchers/${lifetimeId}`, {
    code: lifetimeCode,
    durationDays: null,
    lifetime: true,
    durationLabel: 'Lifetime',
    maxRedemptions: 1,
    assignedUid: '',
    redeemedCount: 0,
    createdAt: Date.now()
  });
  const lifetimeRedemption = await request('/api/billing/vouchers/redeem', {
    method: 'POST',
    token: 'fifth-test-token',
    body: { code: lifetimeCode }
  });
  assert.equal(lifetimeRedemption.status, 200);
  const lifetimeEntitlement = (await lifetimeRedemption.json()).entitlement;
  assert.equal(lifetimeEntitlement.lifetime, true);
  assert.equal(lifetimeEntitlement.validUntil, null);
  assert.equal(lifetimeEntitlement.status, 'active');
  const lifetimeHistory = fakeDatabase.records.get(`billingAccessHistory/voucher_${lifetimeId}_${voucherDocumentId('user-5')}`);
  assert.equal(lifetimeHistory.lifetime, true);

  const lifetimeActiveRejectsVoucher = await request('/api/billing/vouchers/redeem', {
    method: 'POST',
    token: 'fifth-test-token',
    body: { code: 'WELCOME30' }
  });
  assert.equal(lifetimeActiveRejectsVoucher.status, 409);

  const lifetimeDuplicateOnAnotherFreeAccount = await request('/api/billing/vouchers/redeem', {
    method: 'POST',
    token: 'third-test-token',
    body: { code: lifetimeCode }
  });
  assert.equal(lifetimeDuplicateOnAnotherFreeAccount.status, 409);
  assert.match((await lifetimeDuplicateOnAnotherFreeAccount.json()).error, /redemption limit/i);

  const activated = await request('/api/billing/entitlement', { token: 'valid-test-token' });
  assert.equal(activated.status, 200);
  const activatedEntitlement = (await activated.json()).entitlement;
  assert.equal(activatedEntitlement.billingPlan, 'voucher');
  assert.equal(activatedEntitlement.pendingVoucherCount, 0);
  assert.equal(activatedEntitlement.status, 'active');

  fakeDatabase.records.clear();
  for (const [key, value] of recordsBefore) fakeDatabase.records.set(key, value);
});

test('admin voucher generator supports the five durations and binds each code to one redemption', async () => {
  const options = [
    ['1-month', 30, false],
    ['3-months', 90, false],
    ['6-months', 180, false],
    ['1-year', 365, false],
    ['lifetime', null, true]
  ];
  const createdIds = [];
  const originalAdminEmails = process.env.ADMIN_EMAILS;
  const recordsBefore = new Map(fakeDatabase.records);
  process.env.ADMIN_EMAILS = 'admin@example.com';
  try {
    for (const [duration, durationDays, lifetime] of options) {
      const response = await request('/api/admin/vouchers', {
        method: 'POST',
        token: 'admin-test-token',
        body: { duration, uid: 'user-3' }
      });
      assert.equal(response.status, 201);
      const created = await response.json();
      const voucher = fakeDatabase.records.get(`adminVouchers/${created.id}`);
      createdIds.push(`adminVouchers/${created.id}`);
      assert.equal(created.duration, duration);
      assert.equal(created.durationDays, durationDays);
      assert.equal(created.lifetime, lifetime);
      assert.equal(voucher.maxRedemptions, 1);
      assert.equal(voucher.assignedUid, 'user-3');
    }

    const invalid = await request('/api/admin/vouchers', {
      method: 'POST',
      token: 'admin-test-token',
      body: { duration: 'two-years' }
    });
    assert.equal(invalid.status, 400);

    const assignedToEmail = await request('/api/admin/vouchers', {
      method: 'POST',
      token: 'admin-test-token',
      body: { duration: '1-month', user: 'EXPIRED@example.com' }
    });
    assert.equal(assignedToEmail.status, 201);
    const emailVoucher = await assignedToEmail.json();
    createdIds.push(`adminVouchers/${emailVoucher.id}`);
    assert.equal(emailVoucher.assignedUid, 'user-2');
    assert.equal(emailVoucher.assignedEmail, 'expired@example.com');
    assert.equal(fakeDatabase.records.get(`adminVouchers/${emailVoucher.id}`).assignedUid, 'user-2');

    const wrongAccount = await request('/api/billing/vouchers/redeem', {
      method: 'POST',
      token: 'third-test-token',
      body: { code: emailVoucher.code }
    });
    assert.equal(wrongAccount.status, 403);
    const assignedAccount = await request('/api/billing/vouchers/redeem', {
      method: 'POST',
      token: 'other-test-token',
      body: { code: emailVoucher.code }
    });
    assert.equal(assignedAccount.status, 200);
  } finally {
    fakeDatabase.records.clear();
    for (const [key, value] of recordsBefore) fakeDatabase.records.set(key, value);
    if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = originalAdminEmails;
  }
});

test('subscription checkout, payment verification, and signed webhook lifecycle update server entitlements', async () => {
  const priorVoucherHistoryId = `voucher_${voucherDocumentId('TEST-VOUCHER')}_${voucherDocumentId('user-1')}`;
  const priorVoucherHistoryKey = `billingAccessHistory/${priorVoucherHistoryId}`;
  fakeDatabase.records.set(priorVoucherHistoryKey, {
    uid: 'user-1',
    planKey: 'voucher',
    paymentMode: 'voucher',
    source: 'voucher',
    validFrom: Date.now() - 60_000,
    validUntil: Date.now() + 60_000,
    createdAt: Date.now() - 60_000
  });
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
    .update('pay_test1|sub_test1')
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
  assert.equal(adminUserDetails.subscriptionId, 'sub_test1');
  assert.ok(adminUserDetails.accessHistory.some(item => item.paymentId === 'pay_test1'));
  assert.ok(adminUserDetails.accessHistory.some(item => item.source === 'voucher' && item.paymentMode === 'voucher'));
  fakeDatabase.records.delete(priorVoucherHistoryKey);
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
  const currentPaidThrough = fakeDatabase.records.get('users/user-1/billing/entitlement').validUntil;

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
  assert.equal(fakeDatabase.records.get('users/user-1/billing/entitlement').validUntil, currentPaidThrough);
  assert.equal(providerCancellations.find(item => item.subscriptionId === 'sub_test1').body.cancel_at_cycle_end, true);
  const userActivityResponse = await request('/api/billing/activity', { token: 'valid-test-token' });
  const userActivity = (await userActivityResponse.json()).activity;
  const userCancellation = userActivity.find(item => item.title === 'Subscription cancelled by user');
  assert.equal(userCancellation.actorType, 'user');
  assert.equal(userCancellation.actorUid, 'user-1');
  assert.ok(Number.isFinite(userCancellation.occurredAt));

  fakeDatabase.records.set('users/user-2/billing/entitlement', {
    planId: 'pro', billingPlan: 'monthly', status: 'active', validUntil: Date.now() + 60_000,
    subscriptionId: 'sub_admincancel',
    pendingVouchers: [{ voucherId: 'pending-admin-test', durationDays: 30, startsAt: Date.now() + 60_000 }]
  });
  fakeDatabase.records.set('billingSubscriptions/sub_admincancel', {
    uid: 'user-2', planKey: 'monthly', planId: 'plan_monthly_test', currency: 'INR',
    status: 'active', currentEnd: Date.now() + 60_000
  });
  fakeDatabase.records.set('billingSubscriptions/sub_adminorphan', {
    uid: 'user-2', planKey: 'yearly', planId: 'plan_yearly_test', currency: 'INR',
    status: 'active', currentEnd: Date.now() + 60_000
  });
  const adminCancelled = await request('/api/admin/users/user-2/cancel-pro', {
    method: 'POST', token: 'admin-test-token', body: { reason: 'User requested cancellation' }
  });
  assert.equal(adminCancelled.status, 200);
  assert.equal((await adminCancelled.clone().json()).isPro, false);
  assert.equal(providerCancellations.find(item => item.subscriptionId === 'sub_admincancel').body.cancel_at_cycle_end, false);
  assert.equal(fakeDatabase.records.get('users/user-2/billing/entitlement').planId, 'free');
  assert.equal(fakeDatabase.records.get('users/user-2/billing/entitlement').adminRevoked, true);
  assert.deepEqual(fakeDatabase.records.get('users/user-2/billing/entitlement').pendingVouchers, []);
  assert.equal(fakeDatabase.records.get('billingSubscriptions/sub_admincancel').adminRevoked, true);
  assert.equal(fakeDatabase.records.get('billingSubscriptions/sub_admincancel').currentEnd, 0);
  assert.equal(fakeDatabase.records.get('billingSubscriptions/sub_adminorphan').adminRevoked, true);
  assert.equal(fakeDatabase.records.get('billingSubscriptions/sub_adminorphan').currentEnd, 0);
  assert.ok(providerCancellations.some(item => item.subscriptionId === 'sub_adminorphan'));
  const lateAdminWebhook = await signedWebhook({
    id: 'evt_admin_cancelled_late',
    event: 'subscription.cancelled',
    payload: {
      subscription: {
        entity: {
          id: 'sub_admincancel',
          plan_id: 'plan_monthly_test',
          status: 'cancelled',
          current_end: Math.floor((Date.now() + 60_000) / 1000)
        }
      }
    }
  });
  assert.equal(lateAdminWebhook.status, 200);
  const postWebhookEntitlement = fakeDatabase.records.get('users/user-2/billing/entitlement');
  assert.equal(postWebhookEntitlement.planId, 'free');
  assert.equal(postWebhookEntitlement.billingPlan, 'free');
  assert.equal(postWebhookEntitlement.subscriptionId, null);
  assert.deepEqual(postWebhookEntitlement.pendingVouchers, []);
  assert.equal(fakeDatabase.records.get('users/user-2/billing/checkout').currentEnd, 0);

  fakeDatabase.records.set('users/user-2/billing/entitlement', {
    planId: 'pro',
    billingPlan: 'monthly',
    status: 'active',
    validUntil: Date.now() + 60_000,
    subscriptionId: 'sub_admincancel'
  });
  const staleEntitlementResponse = await request('/api/billing/entitlement', { token: 'other-test-token' });
  assert.equal(staleEntitlementResponse.status, 200);
  assert.equal((await staleEntitlementResponse.json()).entitlement.planId, 'free');
  assert.equal(fakeDatabase.records.get('users/user-2/billing/entitlement').adminRevoked, true);

  const lateActivationWebhook = await signedWebhook({
    id: 'evt_admin_activation_late',
    event: 'subscription.activated',
    payload: {
      subscription: {
        entity: {
          id: 'sub_admincancel',
          plan_id: 'plan_monthly_test',
          status: 'active',
          current_end: Math.floor((Date.now() + 60_000) / 1000)
        }
      }
    }
  });
  assert.equal(lateActivationWebhook.status, 200);
  assert.equal(fakeDatabase.records.get('users/user-2/billing/entitlement').planId, 'free');
  assert.equal(fakeDatabase.records.get('users/user-2/billing/checkout').currentEnd, 0);
  const orphanActivationWebhook = await signedWebhook({
    id: 'evt_admin_orphan_activation',
    event: 'subscription.activated',
    payload: {
      subscription: {
        entity: {
          id: 'sub_adminorphan',
          plan_id: 'plan_yearly_test',
          status: 'active',
          current_end: Math.floor((Date.now() + 60_000) / 1000)
        }
      }
    }
  });
  assert.equal(orphanActivationWebhook.status, 200);
  assert.equal(fakeDatabase.records.get('users/user-2/billing/entitlement').planId, 'free');

  fakeDatabase.records.set('users/user-2/billing/entitlement', {
    planId: 'pro',
    billingPlan: 'monthly',
    status: 'active',
    validUntil: Date.now() + 60_000,
    subscriptionId: 'sub_admincancel'
  });
  const adminDashboard = await request('/api/admin/dashboard', { token: 'admin-test-token' });
  assert.equal(adminDashboard.status, 200);
  const dashboardUser = (await adminDashboard.json()).users.find(user => user.uid === 'user-2');
  assert.equal(dashboardUser.isPro, false);
  assert.equal(dashboardUser.plan, 'free');

  const refreshedAdminCancellation = await request('/api/billing/entitlement', { token: 'other-test-token' });
  assert.equal(refreshedAdminCancellation.status, 200);
  const refreshedEntitlement = (await refreshedAdminCancellation.json()).entitlement;
  assert.equal(refreshedEntitlement.planId, 'free');
  assert.equal(refreshedEntitlement.status, 'inactive');
  assert.equal(fakeDatabase.records.get('users/user-2/billing/entitlement').planId, 'free');
  assert.equal(fakeDatabase.records.get('users/user-2/billing/checkout').currentEnd, 0);
  const replacementCheckout = await request('/api/billing/subscriptions', {
    method: 'POST',
    token: 'other-test-token',
    body: { planKey: 'monthly', currency: 'INR', expectedAmount: 9900 }
  });
  assert.equal(replacementCheckout.status, 201);
  const replacement = await replacementCheckout.json();
  const replacementMapping = fakeDatabase.records.get(`billingSubscriptions/${replacement.subscriptionId}`);
  assert.ok(replacementMapping.createdAt > fakeDatabase.records.get('users/user-2/billing/entitlement').adminRevokedAt);
  const replacementActivation = await signedWebhook({
    id: 'evt_admin_re_subscribed',
    event: 'subscription.activated',
    payload: {
      subscription: {
        entity: {
          id: replacement.subscriptionId,
          plan_id: 'plan_monthly_test',
          status: 'active',
          current_end: Math.floor((Date.now() + 60_000) / 1000)
        }
      }
    }
  });
  assert.equal(replacementActivation.status, 200);
  assert.equal(fakeDatabase.records.get('users/user-2/billing/entitlement').planId, 'pro');
  assert.equal(fakeDatabase.records.get('users/user-2/billing/entitlement').adminRevoked, false);
  const adminActivityResponse = await request('/api/billing/activity', { token: 'other-test-token' });
  const adminActivity = (await adminActivityResponse.json()).activity;
  const adminCancellation = adminActivity.find(item => item.title === 'Pro access cancelled by admin');
  assert.equal(adminCancellation.actorType, 'admin');
  assert.equal(adminCancellation.actorUid, 'admin-1');
  assert.equal(adminCancellation.detail, 'User requested cancellation');
  assert.ok(Number.isFinite(adminCancellation.occurredAt));

  const periodEnd = Date.now() + 120_000;
  fakeDatabase.records.set('users/user-3/billing/entitlement', {
    planId: 'pro', billingPlan: 'monthly', status: 'active', source: 'server-verified',
    validUntil: periodEnd, cancelAtCycleEnd: false
  });
  fakeDatabase.records.set('billingSubscriptions/sub_periodend', {
    uid: 'user-3', planKey: 'monthly', status: 'active'
  });
  fakeDatabase.records.set('users/user-3/billing/checkout', { subscriptionId: 'sub_periodend' });
  const scheduledCancellation = await request('/api/admin/users/user-3/cancel-pro', {
    method: 'POST', token: 'admin-test-token',
    body: { reason: 'Do not renew', timing: 'period-end' }
  });
  assert.equal(scheduledCancellation.status, 200);
  assert.equal((await scheduledCancellation.json()).isPro, true);
  assert.equal(fakeDatabase.records.get('users/user-3/billing/entitlement').cancelAtCycleEnd, true);
  assert.equal(providerCancellations.find(item => item.subscriptionId === 'sub_periodend').body.cancel_at_cycle_end, true);

  fakeDatabase.records.set('users/user-4/billing/entitlement', {
    planId: 'pro', billingPlan: 'monthly', status: 'active', source: 'server-verified',
    validUntil: Date.now() + 60_000
  });
  fakeDatabase.records.set('users/user-4/billing/checkout', { subscriptionId: 'sub_banuser' });
  fakeDatabase.records.set('billingSubscriptions/sub_banuser', { uid: 'user-4', planKey: 'monthly' });
  const banned = await request('/api/admin/users/user-4/ban', {
    method: 'POST', token: 'admin-test-token', body: { reason: 'Abuse' }
  });
  assert.equal(banned.status, 200);
  assert.equal(authUsers.get('user-4').disabled, true);
  assert.equal(fakeDatabase.records.get('users/user-4/billing/entitlement').planId, 'free');
  assert.equal(providerCancellations.find(item => item.subscriptionId === 'sub_banuser').body.cancel_at_cycle_end, false);

  const unbanned = await request('/api/admin/users/user-4/unban', {
    method: 'POST', token: 'admin-test-token', body: {}
  });
  assert.equal(unbanned.status, 200);
  assert.equal(authUsers.get('user-4').disabled, false);

  fakeDatabase.records.set('users/user-5/resumes/resume-1', { title: 'Private resume' });
  const deleted = await request('/api/admin/users/user-5', { method: 'DELETE', token: 'admin-test-token' });
  assert.equal(deleted.status, 200);
  assert.equal(authUsers.has('user-5'), false);
  assert.equal(fakeDatabase.records.has('users/user-5/resumes/resume-1'), false);

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

test('admin ban can proceed with cancellation pending and deletion waits for Razorpay cancellation', async () => {
  const originalAdminEmails = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'admin@example.com';
  const originalRazorpayRequest = app.locals.razorpayRequest;
  const subscriptionIds = ['sub_banproviderfail', 'sub_deleteproviderfail', 'sub_deleteproviderfail_extra'];
  const userIds = ['user-6', 'user-7'];
  let razorpayCancellationUnavailable = true;
  const cancellationRequests = [];
  for (const [index, uid] of userIds.entries()) {
    const subscriptionId = subscriptionIds[index];
    fakeDatabase.records.set(`users/${uid}/billing/entitlement`, {
      planId: 'pro',
      billingPlan: 'monthly',
      status: 'active',
      validUntil: Date.now() + 86400000,
      subscriptionId
    });
    fakeDatabase.records.set(`users/${uid}/billing/checkout`, { subscriptionId });
    fakeDatabase.records.set(`billingSubscriptions/${subscriptionId}`, { uid, status: 'active' });
  }
  fakeDatabase.records.set('billingSubscriptions/sub_deleteproviderfail_extra', {
    uid: 'user-7',
    status: 'active'
  });
  fakeDatabase.records.set('billingPayments/payment_deleteproviderfail', { uid: 'user-7', amount: 1000 });
  fakeDatabase.records.set('billingAccessHistory/history_deleteproviderfail', { uid: 'user-7' });
  fakeDatabase.records.set('billingWebhookEvents/event_deleteproviderfail', {
    subscriptionId: 'sub_deleteproviderfail'
  });
  fakeDatabase.records.set('users/user-7/profile/current', { name: 'Delete test account' });
  fakeDatabase.records.set('sharedResumes/share_deleteproviderfail', { ownerUid: 'user-7', state: {} });
  fakeDatabase.records.set('forumPosts/post_deleteproviderfail', { authorUid: 'user-7', title: 'User post' });
  fakeDatabase.records.set('forumPosts/post_other/comments/comment_deleteproviderfail', {
    authorUid: 'user-7',
    content: 'User comment'
  });
  fakeDatabase.records.set('forumActivity/activity_deleteproviderfail', { userUid: 'user-7', postId: 'post_other' });
  fakeDatabase.records.set('adminVouchers/voucher_deleteproviderfail', {
    code: 'ASSIGNED-CODE',
    assignedUid: 'user-7',
    assignedEmail: 'delete-provider-failure@example.com',
    redeemedCount: 1,
    redeemedByUid: 'user-7',
    redeemedByEmail: 'delete-provider-failure@example.com'
  });
  app.locals.razorpayRequest = async (endpoint, options = {}) => {
    if (endpoint.endsWith('/cancel')) {
      cancellationRequests.push(endpoint);
      if (razorpayCancellationUnavailable) {
        const error = new Error('Razorpay cancellation is temporarily unavailable.');
        error.status = 503;
        throw error;
      }
      return { id: endpoint.split('/').at(-2), status: 'cancelled' };
    }
    if (/^\/subscriptions\/sub_(banproviderfail|deleteproviderfail(?:_extra)?|orphaneddelete)$/.test(endpoint)) {
      return { id: endpoint.split('/').at(-1), status: 'active' };
    }
    return originalRazorpayRequest(endpoint, options);
  };

  try {
    const banned = await request('/api/admin/users/user-6/ban', {
      method: 'POST',
      token: 'admin-test-token',
      body: { reason: 'Test provider failure handling' }
    });
    assert.equal(banned.status, 200);
    const banResult = await banned.json();
    assert.equal(banResult.disabled, true);
    assert.equal(banResult.subscriptionCancellationPending, true);
    assert.equal(authUsers.get('user-6').disabled, true);
    assert.equal(fakeDatabase.records.get('users/user-6/billing/entitlement').planId, 'free');
    assert.equal(fakeDatabase.records.get('billingSubscriptions/sub_banproviderfail').adminRevoked, true);
    assert.equal(fakeDatabase.records.get('billingSubscriptions/sub_banproviderfail').providerCancellationPending, true);

    const deleted = await request('/api/admin/users/user-7', {
      method: 'DELETE',
      token: 'admin-test-token'
    });
    assert.equal(deleted.status, 502);
    const deleteFailure = await deleted.json();
    assert.match(deleteFailure.error, /account was not deleted.*could not cancel/i);
    assert.equal(authUsers.has('user-7'), true);
    assert.equal(fakeDatabase.records.get('billingSubscriptions/sub_deleteproviderfail').providerCancellationPending, true);
    assert.equal(fakeDatabase.records.has('billingPayments/payment_deleteproviderfail'), true);

    razorpayCancellationUnavailable = false;
    const deletedAfterProviderRecovery = await request('/api/admin/users/user-7', {
      method: 'DELETE',
      token: 'admin-test-token'
    });
    assert.equal(deletedAfterProviderRecovery.status, 200);
    const deleteResult = await deletedAfterProviderRecovery.json();
    assert.equal(deleteResult.deleted, true);
    assert.equal(authUsers.has('user-7'), false);
    assert.deepEqual(cancellationRequests, [
      '/subscriptions/sub_banproviderfail/cancel',
      '/subscriptions/sub_deleteproviderfail/cancel',
      '/subscriptions/sub_deleteproviderfail_extra/cancel',
      '/subscriptions/sub_deleteproviderfail/cancel',
      '/subscriptions/sub_deleteproviderfail_extra/cancel'
    ]);
    assert.equal(fakeDatabase.records.has('billingSubscriptions/sub_deleteproviderfail'), false);
    assert.equal(fakeDatabase.records.has('billingSubscriptions/sub_deleteproviderfail_extra'), false);
    assert.equal(fakeDatabase.records.has('billingPayments/payment_deleteproviderfail'), false);
    assert.equal(fakeDatabase.records.has('billingAccessHistory/history_deleteproviderfail'), false);
    assert.equal(fakeDatabase.records.has('billingWebhookEvents/event_deleteproviderfail'), false);
    assert.equal(fakeDatabase.records.has('users/user-7/profile/current'), false);
    assert.equal(fakeDatabase.records.has('sharedResumes/share_deleteproviderfail'), false);
    assert.equal(fakeDatabase.records.has('forumPosts/post_deleteproviderfail'), false);
    assert.equal(fakeDatabase.records.has('forumPosts/post_other/comments/comment_deleteproviderfail'), false);
    assert.equal(fakeDatabase.records.has('forumActivity/activity_deleteproviderfail'), false);
    const voucher = fakeDatabase.records.get('adminVouchers/voucher_deleteproviderfail');
    assert.equal(voucher.assignedUid, '');
    assert.equal(voucher.assignedEmail, '');
    assert.equal(Object.hasOwn(voucher, 'redeemedByUid'), false);
    assert.equal(voucher.redeemedCount, 1);

    fakeDatabase.records.set('billingSubscriptions/sub_orphaneddelete', {
      uid: 'user-8',
      status: 'active',
      providerCancellationPending: true
    });
    fakeDatabase.records.set('users/user-8/profile/current', { name: 'Previously deleted account' });
    fakeDatabase.records.set('billingPayments/payment_orphaneddelete', { uid: 'user-8', amount: 500 });
    const pendingDashboardResponse = await request('/api/admin/dashboard', { token: 'admin-test-token' });
    assert.equal(pendingDashboardResponse.status, 200);
    const pendingDashboard = await pendingDashboardResponse.json();
    assert.ok(pendingDashboard.pendingSubscriptionCancellations.some(item => (
      item.subscriptionId === 'sub_orphaneddelete' && item.uid === 'user-8'
    )));

    const retriedOrphanCancellation = await request(
      '/api/admin/subscriptions/sub_orphaneddelete/retry-cancellation',
      { method: 'POST', token: 'admin-test-token', body: {} }
    );
    assert.equal(retriedOrphanCancellation.status, 200);
    assert.equal((await retriedOrphanCancellation.json()).accountDataDeleted, true);
    assert.equal(fakeDatabase.records.has('billingSubscriptions/sub_orphaneddelete'), false);
    assert.equal(fakeDatabase.records.has('billingPayments/payment_orphaneddelete'), false);
    assert.equal(fakeDatabase.records.has('users/user-8/profile/current'), false);
    assert.equal(cancellationRequests.at(-1), '/subscriptions/sub_orphaneddelete/cancel');
  } finally {
    app.locals.razorpayRequest = originalRazorpayRequest;
    if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = originalAdminEmails;
    authUsers.delete('user-6');
    authUsers.delete('user-7');
    for (const uid of userIds) {
      for (const key of [...fakeDatabase.records.keys()]) {
        if (key === `users/${uid}` || key.startsWith(`users/${uid}/`)) fakeDatabase.records.delete(key);
      }
    }
    for (const subscriptionId of subscriptionIds) fakeDatabase.records.delete(`billingSubscriptions/${subscriptionId}`);
    fakeDatabase.records.delete('billingPayments/payment_deleteproviderfail');
    fakeDatabase.records.delete('billingAccessHistory/history_deleteproviderfail');
    fakeDatabase.records.delete('billingWebhookEvents/event_deleteproviderfail');
    fakeDatabase.records.delete('sharedResumes/share_deleteproviderfail');
    fakeDatabase.records.delete('forumPosts/post_deleteproviderfail');
    fakeDatabase.records.delete('forumPosts/post_other/comments/comment_deleteproviderfail');
    fakeDatabase.records.delete('forumActivity/activity_deleteproviderfail');
    fakeDatabase.records.delete('adminVouchers/voucher_deleteproviderfail');
    fakeDatabase.records.delete('billingSubscriptions/sub_orphaneddelete');
    fakeDatabase.records.delete('billingPayments/payment_orphaneddelete');
    fakeDatabase.records.delete('users/user-8/profile/current');
  }
});

test('admin account details reconcile later paid Razorpay invoices for existing subscriptions', async () => {
  const uid = 'user-4';
  const subscriptionId = 'sub_invoicereconcile';
  const paymentId = 'pay_invoicereconcile';
  const previousPaymentId = 'pay_invoicereconcileprevious';
  const paidAt = Math.floor(Date.now() / 1000);
  const validUntil = paidAt + 30 * 86400;
  fakeDatabase.records.set(`billingSubscriptions/${subscriptionId}`, {
    uid,
    planKey: 'monthly',
    currency: 'INR',
    currentEnd: validUntil * 1000
  });
  fakeDatabase.records.set(`users/${uid}/billing/entitlement`, {
    planId: 'pro',
    billingPlan: 'monthly',
    status: 'active',
    source: 'server-verified',
    subscriptionId,
    validUntil: validUntil * 1000
  });
  fakeDatabase.records.set(`billingPayments/${previousPaymentId}`, {
    uid,
    providerPaymentId: previousPaymentId,
    subscriptionId,
    planKey: 'monthly',
    status: 'captured',
    amount: 9900,
    currency: 'INR',
    createdAt: (paidAt - 30 * 86400) * 1000
  });
  providerInvoices.set(subscriptionId, [{
    subscription_id: subscriptionId,
    payment_id: previousPaymentId,
    status: 'paid',
    amount_paid: 9900,
    currency: 'INR',
    paid_at: paidAt - 30 * 86400,
    billing_end: validUntil - 30 * 86400
  }, {
    subscription_id: subscriptionId,
    payment_id: paymentId,
    status: 'paid',
    amount_paid: 10900,
    currency: 'INR',
    paid_at: paidAt,
    billing_end: validUntil
  }]);

  try {
    const response = await request(`/api/admin/users/${uid}`, { token: 'admin-test-token' });
    assert.equal(response.status, 200);
    const details = await response.json();
    assert.equal(fakeDatabase.records.get(`billingPayments/${paymentId}`)?.amount, 10900);
    assert.equal(details.paidAmount, 20800);
    assert.ok(details.payments.some(payment => payment.id === paymentId));
    assert.equal(details.payments.length, 2);
    assert.ok(details.accessHistory.some(item => item.paymentId === paymentId));
    assert.equal(fakeDatabase.records.get(`billingPayments/${paymentId}`).status, 'captured');
    assert.equal(fakeDatabase.records.get(`billingPayments/${paymentId}`).subscriptionId, subscriptionId);
  } finally {
    providerInvoices.delete(subscriptionId);
    fakeDatabase.records.delete(`billingSubscriptions/${subscriptionId}`);
    fakeDatabase.records.delete(`users/${uid}/billing/entitlement`);
    fakeDatabase.records.delete(`billingPayments/${previousPaymentId}`);
    fakeDatabase.records.delete(`billingPayments/${paymentId}`);
    fakeDatabase.records.delete(`billingAccessHistory/${paymentId}`);
  }
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

test('checkout uses the configured default-price plan when Firestore has a stale plan ID', async () => {
  const configuredMonthlyPlanId = process.env.RAZORPAY_PLAN_MONTHLY_ID;
  const configuredYearlyPlanId = process.env.RAZORPAY_PLAN_YEARLY_ID;
  const pricingRecord = 'appConfig/pricing';
  const hadPricingRecord = fakeDatabase.records.has(pricingRecord);
  const previousPricing = fakeDatabase.records.get(pricingRecord);
  const checkoutKey = 'users/user-4/billing/checkout';
  const previousCheckout = fakeDatabase.records.get(checkoutKey);
  const entitlementKey = 'users/user-4/billing/entitlement';
  const previousEntitlement = fakeDatabase.records.get(entitlementKey);
  const previousNextSubscriptionId = nextSubscriptionId;
  process.env.RAZORPAY_PLAN_MONTHLY_ID = 'plan_monthly_test';
  process.env.RAZORPAY_PLAN_YEARLY_ID = 'plan_yearly_test';
  fakeDatabase.records.set(pricingRecord, {
    monthly: { actualPrice: 99, currentPrice: 99 },
    yearly: { actualPrice: 399, currentPrice: 399 },
    providerPlanIds: {
      INR: { monthly: 'plan_stale_monthly', yearly: 'plan_stale_yearly' }
    }
  });
  fakeDatabase.records.delete(checkoutKey);
  fakeDatabase.records.delete(entitlementKey);

  let createdSubscriptionId;
  try {
    const checkoutResponse = await request('/api/billing/subscriptions', {
      method: 'POST',
      token: 'fourth-test-token',
      body: { planKey: 'monthly', currency: 'INR', expectedAmount: 9900 }
    });
    const checkout = await checkoutResponse.json();
    assert.equal(checkoutResponse.status, 201, JSON.stringify(checkout));
    createdSubscriptionId = checkout.subscriptionId;
    assert.equal(
      fakeDatabase.records.get(`billingSubscriptions/${createdSubscriptionId}`).planId,
      'plan_monthly_test'
    );
  } finally {
    process.env.RAZORPAY_PLAN_MONTHLY_ID = configuredMonthlyPlanId;
    process.env.RAZORPAY_PLAN_YEARLY_ID = configuredYearlyPlanId;
    if (createdSubscriptionId) {
      fakeDatabase.records.delete(`billingSubscriptions/${createdSubscriptionId}`);
      providerSubscriptions.delete(createdSubscriptionId);
    }
    nextSubscriptionId = previousNextSubscriptionId;
    if (previousCheckout) fakeDatabase.records.set(checkoutKey, previousCheckout);
    else fakeDatabase.records.delete(checkoutKey);
    if (previousEntitlement) fakeDatabase.records.set(entitlementKey, previousEntitlement);
    else fakeDatabase.records.delete(entitlementKey);
    if (hadPricingRecord) fakeDatabase.records.set(pricingRecord, previousPricing);
    else fakeDatabase.records.delete(pricingRecord);
  }
});

test('checkout falls back to the saved plan when the configured default plan is missing', async () => {
  const configuredMonthlyPlanId = process.env.RAZORPAY_PLAN_MONTHLY_ID;
  const pricingRecord = 'appConfig/pricing';
  const hadPricingRecord = fakeDatabase.records.has(pricingRecord);
  const previousPricing = fakeDatabase.records.get(pricingRecord);
  const checkoutKey = 'users/user-4/billing/checkout';
  const previousCheckout = fakeDatabase.records.get(checkoutKey);
  const entitlementKey = 'users/user-4/billing/entitlement';
  const previousEntitlement = fakeDatabase.records.get(entitlementKey);
  const previousNextSubscriptionId = nextSubscriptionId;
  const originalRazorpayRequest = app.locals.razorpayRequest;
  process.env.RAZORPAY_PLAN_MONTHLY_ID = 'plan_missing_live';
  fakeDatabase.records.set(pricingRecord, {
    monthly: { actualPrice: 99, currentPrice: 99 },
    yearly: { actualPrice: 399, currentPrice: 399 },
    providerPlanIds: {
      INR: { monthly: 'plan_monthly_test', yearly: 'plan_yearly_test' }
    }
  });
  fakeDatabase.records.delete(checkoutKey);
  fakeDatabase.records.delete(entitlementKey);
  app.locals.razorpayRequest = async (endpoint, options) => {
    if (endpoint === '/plans/plan_missing_live') {
      const error = new Error('Razorpay request failed with status 404: The ID provided is invalid or could not be found.');
      error.status = 404;
      error.providerDetail = 'The ID provided is invalid or could not be found.';
      throw error;
    }
    return originalRazorpayRequest(endpoint, options);
  };

  let createdSubscriptionId;
  try {
    const checkoutResponse = await request('/api/billing/subscriptions', {
      method: 'POST',
      token: 'fourth-test-token',
      body: { planKey: 'monthly', currency: 'INR', expectedAmount: 9900 }
    });
    const checkout = await checkoutResponse.json();
    assert.equal(checkoutResponse.status, 201, JSON.stringify(checkout));
    createdSubscriptionId = checkout.subscriptionId;
    assert.equal(
      fakeDatabase.records.get(`billingSubscriptions/${createdSubscriptionId}`).planId,
      'plan_monthly_test'
    );
  } finally {
    app.locals.razorpayRequest = originalRazorpayRequest;
    process.env.RAZORPAY_PLAN_MONTHLY_ID = configuredMonthlyPlanId;
    if (createdSubscriptionId) {
      fakeDatabase.records.delete(`billingSubscriptions/${createdSubscriptionId}`);
      providerSubscriptions.delete(createdSubscriptionId);
    }
    nextSubscriptionId = previousNextSubscriptionId;
    if (previousCheckout) fakeDatabase.records.set(checkoutKey, previousCheckout);
    else fakeDatabase.records.delete(checkoutKey);
    if (previousEntitlement) fakeDatabase.records.set(entitlementKey, previousEntitlement);
    else fakeDatabase.records.delete(entitlementKey);
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

test('dismissing an unpaid checkout clears it and allows a different subscription plan', async () => {
  const uid = 'user-4';
  const checkoutKey = `users/${uid}/billing/checkout`;
  const entitlementKey = `users/${uid}/billing/entitlement`;
  const subscriptionId = 'sub_usercancelcheckout';
  const keys = [
    checkoutKey,
    entitlementKey,
    `billingSubscriptions/${subscriptionId}`
  ];
  const previousRecords = keys.map(key => [key, fakeDatabase.records.get(key)]);
  const previousProviderSubscription = providerSubscriptions.get(subscriptionId);
  const originalRazorpayRequest = app.locals.razorpayRequest;
  const previousNextSubscriptionId = nextSubscriptionId;
  let newSubscriptionId;
  const scheduledStartAt = Date.now() + 10 * 86_400_000;
  fakeDatabase.records.set(checkoutKey, {
    requestId: 'cancel-checkout-request',
    subscriptionId,
    planKey: 'monthly',
    currency: 'INR',
    status: 'created',
    scheduledStartAt,
    currentEnd: 0
  });
  fakeDatabase.records.set(entitlementKey, {
    planId: 'free',
    billingPlan: 'free',
    status: 'inactive',
    source: 'server-verified',
    lifetime: false,
    validUntil: 0
  });
  fakeDatabase.records.set(`billingSubscriptions/${subscriptionId}`, {
    uid,
    planKey: 'monthly',
    planId: 'plan_monthly_test',
    status: 'created',
    scheduledStartAt
  });
  providerSubscriptions.set(subscriptionId, {
    id: subscriptionId,
    plan_id: 'plan_monthly_test',
    status: 'created',
    paid_count: 0,
    current_end: null
  });
  app.locals.razorpayRequest = async (endpoint, options = {}) => {
    const cancellation = endpoint.match(/^\/subscriptions\/([^/]+)\/cancel$/);
    if (cancellation && options.method === 'POST') {
      const current = providerSubscriptions.get(cancellation[1]);
      if (current) {
        providerSubscriptions.set(cancellation[1], { ...current, status: 'cancelled' });
      }
    }
    return originalRazorpayRequest(endpoint, options);
  };

  try {
    const cancelled = await request('/api/billing/checkout/cancel', {
      method: 'POST',
      token: 'fourth-test-token',
      body: { subscriptionId }
    });
    assert.equal(cancelled.status, 200, JSON.stringify(await cancelled.clone().json()));
    assert.equal((await cancelled.json()).cancelled, true);
    assert.equal(fakeDatabase.records.get(`billingSubscriptions/${subscriptionId}`).status, 'cancelled');
    const clearedCheckout = fakeDatabase.records.get(checkoutKey);
    assert.equal(clearedCheckout.status, 'cancelled');
    assert.equal(clearedCheckout.subscriptionId, null);
    assert.equal(clearedCheckout.scheduledStartAt, null);
    assert.equal(clearedCheckout.amount, null);

    const yearly = await request('/api/billing/subscriptions', {
      method: 'POST',
      token: 'fourth-test-token',
      body: { planKey: 'yearly', currency: 'INR', expectedAmount: 39900 }
    });
    const yearlyBody = await yearly.json();
    assert.equal(yearly.status, 201, JSON.stringify(yearlyBody));
    newSubscriptionId = yearlyBody.subscriptionId;
    assert.equal(
      fakeDatabase.records.get(`billingSubscriptions/${yearlyBody.subscriptionId}`).planId,
      'plan_yearly_test'
    );
    assert.equal(yearlyBody.scheduledAt, null);
    providerSubscriptions.set(yearlyBody.subscriptionId, {
      ...providerSubscriptions.get(yearlyBody.subscriptionId),
      status: 'authenticated'
    });
    const authorizedCancellation = await request('/api/billing/checkout/cancel', {
      method: 'POST',
      token: 'fourth-test-token',
      body: { subscriptionId: yearlyBody.subscriptionId }
    });
    assert.equal(authorizedCancellation.status, 409);
    assert.equal(
      fakeDatabase.records.get(checkoutKey).subscriptionId,
      yearlyBody.subscriptionId
    );
  } finally {
    app.locals.razorpayRequest = originalRazorpayRequest;
    if (newSubscriptionId) {
      fakeDatabase.records.delete(`billingSubscriptions/${newSubscriptionId}`);
      providerSubscriptions.delete(newSubscriptionId);
    }
    nextSubscriptionId = previousNextSubscriptionId;
    for (const [key, value] of previousRecords) {
      if (value === undefined) fakeDatabase.records.delete(key);
      else fakeDatabase.records.set(key, value);
    }
    if (previousProviderSubscription) providerSubscriptions.set(subscriptionId, previousProviderSubscription);
    else providerSubscriptions.delete(subscriptionId);
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
  const originalReferralFlag = process.env.REFERRALS_ENABLED;
  process.env.REFERRALS_ENABLED = 'false';
  try {
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
  } finally {
    if (originalReferralFlag === undefined) delete process.env.REFERRALS_ENABLED;
    else process.env.REFERRALS_ENABLED = originalReferralFlag;
  }
});
