import test from 'node:test';
import assert from 'node:assert/strict';
import { clearBillingEntitlementCache, getCachedBillingEntitlement, loadBillingConfig, loadBillingEntitlement, parseBillingResponse } from '../frontend/src/billing-client.js';
import { cacheAccountPhoto, cacheAccountPhotoFromUrls, cacheProBadgeHint, clearCachedAccountAvatar, clearCachedProBadgeHint, clearUserSessionCache, getCachedAccountAvatarHint, getCachedAccountPhoto, getCachedProBadgeHint, readSessionCache, writeSessionCache } from '../frontend/src/session-cache.js';

async function withSessionStorage(callback) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const originalLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  const storage = {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key)
  };
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    return await callback();
  } finally {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    else delete globalThis.sessionStorage;
    if (originalLocal) Object.defineProperty(globalThis, 'localStorage', originalLocal);
    else delete globalThis.localStorage;
  }
}

test('billing client parses successful JSON responses', async () => {
  const result = await parseBillingResponse(new Response(JSON.stringify({ entitlement: { planId: 'pro' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  }));
  assert.deepEqual(result, { entitlement: { planId: 'pro' } });
});

test('billing client surfaces backend JSON errors', async () => {
  await assert.rejects(
    parseBillingResponse(new Response(JSON.stringify({ error: 'Voucher has expired.' }), {
      status: 404,
      headers: { 'content-type': 'application/json' }
    })),
    { message: 'Voucher has expired.' }
  );
});

test('billing client diagnoses a missing non-JSON API route', async () => {
  await assert.rejects(
    parseBillingResponse(new Response('<!doctype html><title>Not found</title>', { status: 404 })),
    { message: 'Billing request failed (HTTP 404). The billing API route was not found. Check that /api is routed to the backend.' }
  );
});

test('billing client diagnoses non-JSON backend failures without hiding the HTTP status', async () => {
  await assert.rejects(
    parseBillingResponse(new Response('<!doctype html><title>Internal Server Error</title>', { status: 502 })),
    { message: 'Billing request failed (HTTP 502). The backend returned an unexpected response. Check its deployment and server logs.' }
  );
});

test('session cache scopes data to a user and expires stale entries', async () => withSessionStorage(() => {
  writeSessionCache('example', 'user-1', { value: 'cached' }, 1000);
  assert.deepEqual(readSessionCache('example', 'user-1', 500, 1400), { value: 'cached' });
  assert.equal(readSessionCache('example', 'user-1', 500, 1600), null);
  assert.equal(readSessionCache('example', 'user-2', 500, 1400), null);
}));

test('Pro badge hint renders from verified cache before auth and expires with the plan', async () => withSessionStorage(() => {
  const entitlement = {
    planId: 'pro',
    status: 'active',
    source: 'server-verified',
    validUntil: Date.now() + 60_000
  };
  cacheProBadgeHint('user-1', entitlement);
  assert.deepEqual(getCachedProBadgeHint(), { uid: 'user-1', validUntil: entitlement.validUntil });
  cacheProBadgeHint('user-2', { ...entitlement, source: 'client-claimed' });
  assert.deepEqual(getCachedProBadgeHint(), { uid: 'user-1', validUntil: entitlement.validUntil });
  assert.equal(getCachedProBadgeHint(entitlement.validUntil), null);
  cacheProBadgeHint('user-1', entitlement);
  clearCachedProBadgeHint('another-user');
  assert.equal(getCachedProBadgeHint()?.uid, 'user-1');
  clearCachedProBadgeHint('user-1');
  assert.equal(getCachedProBadgeHint(), null);
}));

test('billing entitlement cache is server-originated, short lived, and reused across pages', async () => withSessionStorage(async () => {
  const user = { uid: 'user-1' };
  const entitlement = {
    planId: 'pro',
    status: 'active',
    source: 'server-verified',
    validUntil: Date.now() + 60_000
  };
  writeSessionCache('billing-entitlement', user.uid, entitlement);
  const config = { checkoutEnabled: true, entitlementEnabled: true };
  writeSessionCache('billing-config', '', config);
  assert.deepEqual(getCachedBillingEntitlement(user), entitlement);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('Fresh server request should not be needed for a valid cached entitlement.');
  };
  try {
    assert.deepEqual(await loadBillingEntitlement(user), entitlement);
    assert.deepEqual(await loadBillingConfig(), config);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(getCachedBillingEntitlement({ uid: 'another-user' }), null);
  writeSessionCache('billing-entitlement', user.uid, { ...entitlement, source: 'client-claimed' });
  assert.equal(getCachedBillingEntitlement(user), null);
  writeSessionCache('billing-entitlement', user.uid, entitlement, Date.now() - 6 * 60 * 1000);
  assert.equal(getCachedBillingEntitlement(user), null);
  writeSessionCache('billing-entitlement', user.uid, entitlement);
  clearBillingEntitlementCache(user);
  assert.equal(getCachedBillingEntitlement(user), null);
}));

test('account photo cache is reused within the session and cleared on logout', async () => withSessionStorage(() => {
  cacheAccountPhoto('user-1', 'data:image/jpeg;base64,abc');
  assert.equal(getCachedAccountPhoto('user-1'), 'data:image/jpeg;base64,abc');
  cacheAccountPhoto('user-1', '');
  assert.equal(getCachedAccountPhoto('user-1'), 'data:image/jpeg;base64,abc');
  assert.equal(getCachedAccountPhoto('user-2'), null);
  writeSessionCache('billing-entitlement', 'user-1', {
    planId: 'pro',
    status: 'active',
    source: 'server-verified',
    validUntil: Date.now() + 60_000
  });
  clearUserSessionCache('user-1');
  assert.equal(getCachedAccountPhoto('user-1'), null);
  assert.equal(getCachedAccountAvatarHint(), null);
  assert.equal(getCachedBillingEntitlement({ uid: 'user-1' }), null);
}));

test('remote account avatar is snapshotted for instant display on later page loads', async () => withSessionStorage(async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Blob(['avatar'], { type: 'image/png' }), { status: 200 });
  try {
    await cacheAccountPhotoFromUrls('user-1', ['https://google.test/avatar.png']);
    const hint = getCachedAccountAvatarHint();
    assert.equal(hint.uid, 'user-1');
    assert.equal(hint.photoDataUrl, 'data:image/png;base64,YXZhdGFy');
    assert.equal(getCachedAccountPhoto('user-1'), hint.photoDataUrl);
    clearCachedAccountAvatar('user-1');
    assert.equal(getCachedAccountAvatarHint(), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
}));
