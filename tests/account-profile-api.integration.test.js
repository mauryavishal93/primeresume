import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../backend/server.js';

const records = new Map();
const accountUpdates = [];
const previousAdmin = app.locals.firebaseAdmin;
let server;
let origin;

before(async () => {
  app.locals.firebaseAdmin = {
    auth: {
      verifyIdToken: async token => {
        if (token === 'account-one') return { uid: 'account-1' };
        if (token === 'account-two') return { uid: 'account-2' };
        throw new Error('Invalid test token');
      },
      updateUser: async (uid, values) => accountUpdates.push({ uid, values })
    },
    db: {
      doc: path => ({
        get: async () => ({
          exists: records.has(path),
          data: () => records.get(path)
        }),
        set: async value => records.set(path, value)
      })
    }
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
  if (previousAdmin) app.locals.firebaseAdmin = previousAdmin;
  else delete app.locals.firebaseAdmin;
});

async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { response, data: await response.json() };
}

test('account profile API requires auth and reads only the verified user profile', async () => {
  assert.equal((await request('/api/account/profile')).response.status, 401);
  const missing = await request('/api/account/profile', { token: 'account-one' });
  assert.equal(missing.response.status, 200);
  assert.deepEqual(missing.data, { mobileNumber: '', photoDataUrl: '' });

  records.set('users/account-2/profile/account', { mobileNumber: '1234567', photoDataUrl: '' });
  const ownProfile = await request('/api/account/profile', { token: 'account-one' });
  assert.deepEqual(ownProfile.data, { mobileNumber: '', photoDataUrl: '' });
});

test('account profile API validates and persists name, mobile, and profile photo', async () => {
  const photoDataUrl = `data:image/jpeg;base64,${'a'.repeat(100000)}`;
  const invalid = await request('/api/account/profile', {
    method: 'PUT',
    token: 'account-one',
    body: { displayName: 'Name', mobileNumber: '123', photoDataUrl: '' }
  });
  assert.equal(invalid.response.status, 400);

  const saved = await request('/api/account/profile', {
    method: 'PUT',
    token: 'account-one',
    body: { displayName: 'Account Owner', mobileNumber: '+1 (415) 555-0134', photoDataUrl }
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.displayName, 'Account Owner');
  assert.equal(records.get('users/account-1/profile/account').photoDataUrl, photoDataUrl);
  assert.deepEqual(accountUpdates, [{ uid: 'account-1', values: { displayName: 'Account Owner' } }]);

  const loaded = await request('/api/account/profile', { token: 'account-one' });
  assert.equal(loaded.data.mobileNumber, '+1 (415) 555-0134');
  assert.equal(loaded.data.photoDataUrl, photoDataUrl);
});
