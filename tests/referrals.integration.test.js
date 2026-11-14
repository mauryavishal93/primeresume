import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { app } from '../backend/server.js';

function createFakeDatabase() {
  const records = new Map();
  let generatedId = 0;
  const snapshot = key => ({
    id: key.split('/').at(-1),
    exists: records.has(key),
    ref: reference(key),
    data: () => records.get(key)
  });
  const reference = key => ({
    key,
    id: key.split('/').at(-1),
    get: async () => snapshot(key),
    create: async data => {
      if (records.has(key)) throw new Error(`Document already exists: ${key}`);
      records.set(key, data);
    },
    set: async (data, options = {}) => {
      records.set(key, options.merge ? { ...records.get(key), ...data } : data);
    },
    delete: async () => records.delete(key)
  });
  class Query {
    constructor(name, filters = [], order = [], max = Infinity, after = null) {
      Object.assign(this, { name, filters, order, max, after });
    }
    where(field, operator, value) {
      return new Query(this.name, [...this.filters, { field, operator, value }], this.order, this.max, this.after);
    }
    orderBy(field, direction = 'asc') {
      return new Query(this.name, this.filters, [...this.order, { field, direction }], this.max, this.after);
    }
    limit(max) {
      return new Query(this.name, this.filters, this.order, max, this.after);
    }
    startAfter(...values) {
      return new Query(this.name, this.filters, this.order, this.max, values);
    }
    async get() {
      let docs = [...records.entries()]
        .filter(([key, data]) => key.startsWith(`${this.name}/`) && key.split('/').length === 2)
        .filter(([, data]) => this.filters.every(({ field, operator, value }) => operator === '==' && data[field] === value))
        .map(([key]) => snapshot(key));
      for (const { field, direction } of [...this.order].reverse()) {
        docs.sort((left, right) => {
          const a = field === '__name__' ? left.id : left.data()?.[field];
          const b = field === '__name__' ? right.id : right.data()?.[field];
          return (a < b ? -1 : a > b ? 1 : 0) * (direction === 'desc' ? -1 : 1);
        });
      }
      if (this.after) {
        const [createdAt, id] = this.after;
        const index = docs.findIndex(document => Number(document.data()?.createdAt) === Number(createdAt) && document.id === id);
        docs = index < 0 ? [] : docs.slice(index + 1);
      }
      return { docs: docs.slice(0, this.max) };
    }
  }
  const collection = name => ({
    doc: id => reference(`${name}/${id || `generated-${++generatedId}`}`),
    where: (field, operator, value) => new Query(name).where(field, operator, value),
    orderBy: (field, direction) => new Query(name).orderBy(field, direction),
    get: () => new Query(name).get()
  });
  return {
    records,
    doc: reference,
    collection,
    runTransaction: callback => callback({
      get: ref => ref instanceof Query ? ref.get() : ref.get(),
      create: (ref, data) => {
        if (records.has(ref.key)) throw new Error(`Document already exists: ${ref.key}`);
        records.set(ref.key, data);
      },
      set: (ref, data, options = {}) => records.set(ref.key, options.merge ? { ...records.get(ref.key), ...data } : data),
      delete: ref => records.delete(ref.key)
    })
  };
}

const originalFlag = process.env.REFERRALS_ENABLED;
const billingEnvironmentKeys = [
  'BILLING_ENABLED', 'BILLING_TERMS_PUBLISHED', 'BILLING_REFUNDS_PUBLISHED',
  'BILLING_TEST_MODE_ENABLED', 'BILLING_LOCAL_TEST_MODE_ENABLED',
  'BILLING_TEST_MODE_VERIFIED', 'BILLING_LIVE_LAUNCH_APPROVED',
  'ADMIN_EMAILS',
  'FIREBASE_SERVICE_ACCOUNT_JSON', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_PLAN_MONTHLY_ID', 'RAZORPAY_PLAN_YEARLY_ID'
];
let originalBillingEnvironment;
let originalFirebaseAdmin;
let originalRazorpayRequest;
let server;
let origin;
let database;
const accountCreatedAt = new Date(Date.now() + 1000).toISOString();

before(async () => {
  process.env.REFERRALS_ENABLED = 'true';
  originalFirebaseAdmin = app.locals.firebaseAdmin;
  database = createFakeDatabase();
  database.records.set('referralCodes/INVITECODE12', {
    referrerUid: 'referrer-1',
    active: true,
    registrationCount: 0,
    codeVersion: 1
  });
  database.records.set('referralCodes/SECONDINVITE12', {
    referrerUid: 'referrer-1',
    active: true,
    registrationCount: 0,
    codeVersion: 1
  });
  database.records.set('referralCodes/SELFREFERRAL12', {
    referrerUid: 'self-user',
    active: true,
    registrationCount: 0,
    codeVersion: 1
  });
  const users = {
    'referrer-1': { uid: 'referrer-1', email: 'referrer@example.com', metadata: { creationTime: new Date(Date.now() - 86400000).toISOString() } },
    'new-user-1': { uid: 'new-user-1', email: 'new@example.com', metadata: { creationTime: accountCreatedAt } },
    'review-user': { uid: 'review-user', email: 'review@example.com', metadata: { creationTime: accountCreatedAt } },
    'old-user-1': { uid: 'old-user-1', email: 'old@example.com', metadata: { creationTime: new Date(Date.now() - 86400000).toISOString() } },
    'manual-user': { uid: 'manual-user', email: 'manual@example.com', metadata: { creationTime: new Date(Date.now() - 1000).toISOString() } },
    'expired-user': { uid: 'expired-user', email: 'expired@example.com', metadata: { creationTime: new Date(Date.now() - 31 * 86400000).toISOString() } },
    'self-user': { uid: 'self-user', email: 'self@example.com', metadata: { creationTime: new Date(Date.now() - 1000).toISOString() } }
  };
  app.locals.firebaseAdmin = {
    db: database,
    auth: {
      verifyIdToken: async token => {
        const uid = {
          'referrer-token': 'referrer-1',
          'new-user-token': 'new-user-1',
          'review-user-token': 'review-user',
          'old-user-token': 'old-user-1',
          'manual-user-token': 'manual-user',
          'expired-user-token': 'expired-user',
          'self-user-token': 'self-user'
        }[token];
        if (token === 'admin-token') return { uid: 'admin-1', email: 'admin@example.com' };
        if (!uid) throw new Error('Invalid test token');
        return { uid };
      },
      getUser: async uid => users[uid]
    }
  };
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  app.locals.firebaseAdmin = originalFirebaseAdmin;
  app.locals.razorpayRequest = originalRazorpayRequest;
  if (originalFlag === undefined) delete process.env.REFERRALS_ENABLED;
  else process.env.REFERRALS_ENABLED = originalFlag;
  for (const [key, value] of Object.entries(originalBillingEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('each signed-in user gets one stable, unique referral code', async () => {
  const loadReferral = token => fetch(`${origin}/api/referrals/me`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const firstResponse = await loadReferral('referrer-token');
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  const repeat = await (await loadReferral('referrer-token')).json();
  assert.equal(repeat.code, first.code);

  const secondResponse = await loadReferral('new-user-token');
  assert.equal(secondResponse.status, 200);
  const second = await secondResponse.json();
  assert.notEqual(second.code, first.code);
  assert.match(first.url, new RegExp(`ref=${first.code}`));
  assert.equal(database.records.get(`referralUserCodes/referrer-1`).code, first.code);
  assert.equal(database.records.get(`referralUserCodes/new-user-1`).code, second.code);
});

test('empty referral and reward endpoints return empty lists for informational UI states', async () => {
  for (const endpoint of ['history', 'rewards']) {
    const response = await fetch(`${origin}/api/referrals/${endpoint}?limit=20`, {
      headers: { authorization: 'Bearer referrer-token' }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { items: [], nextCursor: null });
  }
});

test('history endpoints fall back to user-scoped database reads when ordered indexes are unavailable', async () => {
  const originalCollection = database.collection;
  const originalReferral = database.records.get('referrals/fallback-history-entry');
  const originalReward = database.records.get('referralRewards/fallback-reward-entry');
  database.collection = name => {
    const collection = originalCollection(name);
    return {
      ...collection,
      where: (...whereArgs) => {
        const query = collection.where(...whereArgs);
        return {
          get: () => query.get(),
          orderBy: () => {
            const error = new Error('The query requires an index.');
            error.code = 'failed-precondition';
            throw error;
          }
        };
      }
    };
  };
  const load = endpoint => fetch(`${origin}/api/referrals/${endpoint}?limit=20`, {
    headers: { authorization: 'Bearer referrer-token' }
  });
  try {
    let response = await load('history');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { items: [], nextCursor: null });

    database.records.set('referrals/fallback-history-entry', {
      referrerUid: 'referrer-1',
      referredUid: 'new-user-1',
      referredIdentity: 'n***@e***.com',
      status: 'registered',
      createdAt: 200
    });
    database.records.set('referralRewards/fallback-reward-entry', {
      beneficiaryUid: 'referrer-1',
      rewardType: 'registration',
      durationDays: 7,
      status: 'active',
      createdAt: 200,
      startsAt: 200,
      expiresAt: 7 * 86_400_000 + 200
    });

    response = await load('history');
    assert.equal(response.status, 200);
    const history = await response.json();
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].referredIdentity, 'n***@e***.com');

    response = await load('rewards');
    assert.equal(response.status, 200);
    const rewards = await response.json();
    assert.equal(rewards.items.length, 1);
    assert.equal(rewards.items[0].durationDays, 7);
  } finally {
    database.collection = originalCollection;
    if (originalReferral === undefined) database.records.delete('referrals/fallback-history-entry');
    else database.records.set('referrals/fallback-history-entry', originalReferral);
    if (originalReward === undefined) database.records.delete('referralRewards/fallback-reward-entry');
    else database.records.set('referralRewards/fallback-reward-entry', originalReward);
  }
});

test('referral code stays available when reward summary queries fail', async () => {
  const originalCollection = database.collection;
  database.collection = name => {
    if (name === 'referrals') {
      return { where: () => ({ get: async () => { throw new Error('Simulated referral query failure'); } }) };
    }
    return originalCollection(name);
  };
  try {
    const response = await fetch(`${origin}/api/referrals/me`, {
      headers: { authorization: 'Bearer referrer-token' }
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.match(result.code, /^[A-Z0-9_-]{10,40}$/);
    assert.match(result.url, new RegExp(`ref=${result.code}`));
    assert.equal(result.summary, null);
    assert.match(result.summaryError, /referral code is ready/i);
  } finally {
    database.collection = originalCollection;
  }
});

test('new-account referral registration is one-time, server-verified, and ledgers both seven-day rewards', async () => {
  const attribution = await fetch(`${origin}/api/referrals/attribution`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'INVITECODE12' })
  });
  assert.equal(attribution.status, 200);
  const cookie = attribution.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const cookieValue = cookie.match(/resumeout_referral=([^;]+)/)[1];
  const headers = { authorization: 'Bearer new-user-token', cookie: `resumeout_referral=${cookieValue}` };
  const registration = await fetch(`${origin}/api/referrals/register`, { method: 'POST', headers });
  assert.equal(registration.status, 200);
  assert.deepEqual(await registration.json(), { registered: true, alreadyRegistered: false });
  const referrals = [...database.records.entries()].filter(([key]) => key.startsWith('referrals/'));
  const rewards = [...database.records.entries()].filter(([key]) => key.startsWith('referralRewards/'));
  assert.equal(referrals.length, 1);
  assert.equal(rewards.length, 2);
  assert.deepEqual(rewards.map(([, reward]) => reward.durationDays), [7, 7]);
  assert.ok(rewards.every(([, reward]) => reward.rewardType === 'registration'));
  const duplicate = await fetch(`${origin}/api/referrals/register`, { method: 'POST', headers });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { registered: false, alreadyRegistered: true });
  assert.equal([...database.records.keys()].filter(key => key.startsWith('referralRewards/')).length, 2);
});

test('Firebase account creation metadata rejects an existing account for registration rewards', async () => {
  const attribution = await fetch(`${origin}/api/referrals/attribution`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'INVITECODE12' })
  });
  const cookie = attribution.headers.get('set-cookie').match(/resumeout_referral=([^;]+)/)[1];
  const response = await fetch(`${origin}/api/referrals/register`, {
    method: 'POST',
    headers: { authorization: 'Bearer old-user-token', cookie: `resumeout_referral=${cookie}` }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { registered: false, reason: 'not-eligible' });
  assert.equal([...database.records.keys()].filter(key => key.startsWith('referralRewards/')).length, 2);
});

test('new accounts can apply one valid referral code within 30 days and receive seven-day registration rewards', async () => {
  const headers = {
    authorization: 'Bearer manual-user-token',
    'content-type': 'application/json'
  };
  const statusResponse = await fetch(`${origin}/api/referrals/claim-status`, {
    headers: { authorization: 'Bearer manual-user-token' }
  });
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).eligible, true);

  const invalid = await fetch(`${origin}/api/referrals/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ code: 'INVALIDCODE12' })
  });
  assert.equal(invalid.status, 404);

  const response = await fetch(`${origin}/api/referrals/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ code: 'INVITECODE12' })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    registered: true,
    alreadyRegistered: false,
    pendingReview: false
  });
  const mapping = database.records.get('referralByUser/manual-user');
  const referral = database.records.get(`referrals/${mapping.referralId}`);
  assert.equal(referral.referralCode, 'INVITECODE12');
  const registrationRewards = [...database.records.entries()]
    .filter(([key]) => key.startsWith(`referralRewards/${mapping.referralId}_`))
    .map(([, reward]) => reward);
  assert.deepEqual(registrationRewards.map(reward => reward.durationDays), [7, 7]);

  const duplicate = await fetch(`${origin}/api/referrals/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ code: 'SECONDINVITE12' })
  });
  assert.equal(duplicate.status, 409);
  assert.equal([...database.records.keys()].filter(key => key === 'referralByUser/manual-user').length, 1);
  assert.equal((await (await fetch(`${origin}/api/referrals/claim-status`, {
    headers: { authorization: 'Bearer manual-user-token' }
  })).json()).claimed, true);
});

test('manual referral codes reject self-referrals and accounts outside the 30-day claim window', async () => {
  const expiredStatus = await fetch(`${origin}/api/referrals/claim-status`, {
    headers: { authorization: 'Bearer expired-user-token' }
  });
  assert.deepEqual(await expiredStatus.json(), {
    eligible: false,
    claimed: false,
    reason: 'window-expired'
  });
  const expiredClaim = await fetch(`${origin}/api/referrals/register`, {
    method: 'POST',
    headers: { authorization: 'Bearer expired-user-token', 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'INVITECODE12' })
  });
  assert.equal(expiredClaim.status, 403);

  const selfClaim = await fetch(`${origin}/api/referrals/register`, {
    method: 'POST',
    headers: { authorization: 'Bearer self-user-token', 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'SELFREFERRAL12' })
  });
  assert.equal(selfClaim.status, 400);
});

test('only provider-verified first monthly and yearly captured payments grant one conversion reward', async () => {
  originalBillingEnvironment = Object.fromEntries(billingEnvironmentKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    BILLING_ENABLED: 'true',
    BILLING_TEST_MODE_ENABLED: 'true',
    BILLING_LOCAL_TEST_MODE_ENABLED: 'true',
    BILLING_TERMS_PUBLISHED: 'true',
    BILLING_REFUNDS_PUBLISHED: 'true',
    BILLING_TEST_MODE_VERIFIED: 'true',
    BILLING_LIVE_LAUNCH_APPROVED: 'true',
    ADMIN_EMAILS: 'admin@example.com',
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      type: 'service_account',
      project_id: 'test-project',
      client_email: 'test@test-project.iam.gserviceaccount.com',
      private_key: 'test-private-key'
    }),
    RAZORPAY_KEY_ID: 'rzp_test_referrals',
    RAZORPAY_KEY_SECRET: 'test-secret',
    RAZORPAY_WEBHOOK_SECRET: 'referral-webhook-secret',
    RAZORPAY_PLAN_MONTHLY_ID: 'plan_monthly_test',
    RAZORPAY_PLAN_YEARLY_ID: 'plan_yearly_test'
  });
  originalRazorpayRequest = app.locals.razorpayRequest;
  const providerState = new Map();
  app.locals.razorpayRequest = async endpoint => {
    const [, resource, id] = endpoint.match(/^\/(payments|subscriptions|disputes)\/([^/]+)$/) || [];
    return providerState.get(`${resource}/${id}`);
  };
  const registration = [...database.records.entries()].find(([key]) => key.startsWith('referrals/'));
  const registrationId = registration[0].split('/').at(-1);
  const yearlyReferralId = 'referral-yearly';
  database.records.set(`referrals/${yearlyReferralId}`, {
    referrerUid: 'referrer-1',
    referredUid: 'new-user-yearly',
    referralCode: 'INVITECODE12',
    status: 'registered',
    registeredAt: Date.now(),
    firstQualifyingPaymentId: null,
    paidConversionRewardStatus: 'not_eligible'
  });
  database.records.set('billingSubscriptions/sub_monthlyreferral', {
    uid: 'new-user-1',
    planKey: 'monthly',
    planId: 'plan_monthly_test',
    currency: 'INR',
    status: 'active',
    createdAt: Date.now()
  });
  database.records.set('billingSubscriptions/sub_yearlyreferral', {
    uid: 'new-user-yearly',
    planKey: 'yearly',
    planId: 'plan_yearly_test',
    currency: 'INR',
    status: 'active',
    createdAt: Date.now()
  });

  const makeEvent = (id, subscriptionId, paymentId, planId, amount) => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payment = {
      id: paymentId, status: 'captured', subscription_id: subscriptionId,
      amount, currency: 'INR', created_at: nowSeconds
    };
    const subscription = {
      id: subscriptionId, plan_id: planId, status: 'active',
      current_end: nowSeconds + 30 * 86400, notes: { plan_key: planId === 'plan_yearly_test' ? 'yearly' : 'monthly' }
    };
    providerState.set(`payments/${paymentId}`, payment);
    providerState.set(`subscriptions/${subscriptionId}`, subscription);
    return { id, event: 'subscription.charged', payload: { payment: { entity: payment }, subscription: { entity: subscription } } };
  };
  const sendWebhook = async event => {
    const body = JSON.stringify(event);
    const signature = createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
    return fetch(`${origin}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature },
      body
    });
  };

  const monthlyEvent = makeEvent('evt_monthly_conversion', 'sub_monthlyreferral', 'pay_monthlyreferral', 'plan_monthly_test', 9900);
  const monthlyResponse = await sendWebhook(monthlyEvent);
  assert.equal(monthlyResponse.status, 200);
  const monthlyReward = database.records.get(`referralRewards/${registrationId}_conversion`);
  assert.equal(monthlyReward.durationDays, 7);
  assert.equal(monthlyReward.relatedPaymentId, 'pay_monthlyreferral');
  const duplicateEvent = { ...monthlyEvent, id: 'evt_monthly_duplicate' };
  assert.equal((await sendWebhook(duplicateEvent)).status, 200);
  assert.equal([...database.records.keys()].filter(key => key === `referralRewards/${registrationId}_conversion`).length, 1);

  const yearlyResponse = await sendWebhook(makeEvent(
    'evt_yearly_conversion', 'sub_yearlyreferral', 'pay_yearlyreferral', 'plan_yearly_test', 39900
  ));
  assert.equal(yearlyResponse.status, 200);
  assert.equal(database.records.get(`referralRewards/${yearlyReferralId}_conversion`).durationDays, 30);
  assert.equal([...database.records.entries()].filter(([key, reward]) =>
    key.startsWith('referralRewards/') && reward.rewardType === 'conversion' && reward.beneficiaryUid === 'new-user-1'
  ).length, 0);

  database.records.set('referrals/referral-unverified', {
    referrerUid: 'referrer-1',
    referredUid: 'unverified-user',
    referralCode: 'INVITECODE12',
    status: 'registered',
    firstQualifyingPaymentId: null,
    paidConversionRewardStatus: 'not_eligible'
  });
  database.records.set('billingSubscriptions/sub_unverified', {
    uid: 'unverified-user',
    planKey: 'monthly',
    planId: 'plan_monthly_test',
    currency: 'INR',
    status: 'active'
  });
  const unverifiedEvent = makeEvent('evt_unverified_payment', 'sub_unverified', 'pay_unverified', 'plan_monthly_test', 9900);
  providerState.get('payments/pay_unverified').status = 'authorized';
  assert.equal((await sendWebhook(unverifiedEvent)).status, 200);
  assert.equal(database.records.has('referralRewards/referral-unverified_conversion'), false);

  const activeUntil = Math.floor(Date.now() / 1000) + 10 * 86400;
  providerState.set('subscriptions/sub_monthlyreferral', {
    id: 'sub_monthlyreferral', plan_id: 'plan_monthly_test', status: 'cancelled', current_end: activeUntil
  });
  const periodEndCancellation = await sendWebhook({
    id: 'evt_period_end_cancellation',
    event: 'subscription.cancelled',
    payload: { subscription: { entity: { id: 'sub_monthlyreferral', status: 'cancelled', current_end: activeUntil, plan_id: 'plan_monthly_test' } } }
  });
  assert.equal(periodEndCancellation.status, 200);
  assert.equal(database.records.get(`referrals/${registrationId}`).paidConversionRewardStatus, 'issued');
  assert.equal(database.records.has(`referralRewards/${registrationId}_reversal_evt_period_end_cancellation`), false);

  providerState.set('payments/pay_monthlyreferral', {
    id: 'pay_monthlyreferral', status: 'refunded', subscription_id: 'sub_monthlyreferral',
    amount: 9900, currency: 'INR'
  });
  const refundEvent = {
    id: 'evt_refund_monthly',
    event: 'payment.refunded',
    payload: { payment: { entity: { id: 'pay_monthlyreferral', status: 'refunded', subscription_id: 'sub_monthlyreferral' } } }
  };
  assert.equal((await sendWebhook(refundEvent)).status, 200);
  assert.equal(database.records.get(`referrals/${registrationId}`).paidConversionRewardStatus, 'revoked');
  assert.equal(database.records.get(`referralRewards/${registrationId}_conversion`).status, 'scheduled');
  assert.equal(database.records.get(`referralRewards/${registrationId}_reversal_evt_refund_monthly`).rewardType, 'reversal');
  assert.equal(database.records.get(`referralRewards/${registrationId}_registration_referrer`).status, 'active');
  assert.equal((await sendWebhook(refundEvent)).status, 200);
  assert.equal([...database.records.keys()].filter(key => key.startsWith('referralRewards/')
    && key.includes(`${registrationId}_reversal_`)).length, 1);

  providerState.set('disputes/disp_yearly', {
    id: 'disp_yearly', payment_id: 'pay_yearlyreferral', status: 'lost'
  });
  const chargebackEvent = {
    id: 'evt_chargeback_yearly',
    event: 'payment.dispute.lost',
    payload: { dispute: { entity: { id: 'disp_yearly', payment_id: 'pay_yearlyreferral' } } }
  };
  assert.equal((await sendWebhook(chargebackEvent)).status, 200);
  assert.equal(database.records.get(`referrals/${yearlyReferralId}`).paidConversionRewardStatus, 'revoked');
  assert.equal(database.records.get(`referralRewards/${yearlyReferralId}_reversal_evt_chargeback_yearly`).reason, 'verified-chargeback');
});

test('high-volume codes wait for an audited admin approval before registration rewards issue', async () => {
  const rewardCountBefore = [...database.records.keys()].filter(key => key.startsWith('referralRewards/')).length;
  database.records.set('referralCodes/HIGHVOLUME12', {
    referrerUid: 'referrer-1',
    active: true,
    registrationCount: 49,
    codeVersion: 1
  });
  const attribution = await fetch(`${origin}/api/referrals/attribution`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'HIGHVOLUME12' })
  });
  const cookie = attribution.headers.get('set-cookie').match(/resumeout_referral=([^;]+)/)[1];
  const registration = await fetch(`${origin}/api/referrals/register`, {
    method: 'POST',
    headers: { authorization: 'Bearer review-user-token', cookie: `resumeout_referral=${cookie}` }
  });
  assert.equal(registration.status, 200);
  const referralId = database.records.get('referralByUser/review-user').referralId;
  assert.equal(database.records.get(`referrals/${referralId}`).status, 'pending_review');
  assert.equal(database.records.get(`referrals/${referralId}`).riskFlags[0], 'high-volume-code');
  assert.equal([...database.records.keys()].filter(key => key.startsWith('referralRewards/')).length, rewardCountBefore);

  const approval = await fetch(`${origin}/api/admin/referrals/${referralId}/action`, {
    method: 'POST',
    headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve', reason: 'Reviewed high-volume code activity.' })
  });
  assert.equal(approval.status, 200);
  assert.equal(database.records.get(`referrals/${referralId}`).registrationRewardStatus, 'issued');
  assert.ok(database.records.has(`referralRewards/${referralId}_registration_referrer`));
  assert.ok(database.records.has(`referralRewards/${referralId}_registration_referred`));
  assert.equal([...database.records.keys()].filter(key => key.startsWith('referralAdminAudit/')).length, 1);
});
