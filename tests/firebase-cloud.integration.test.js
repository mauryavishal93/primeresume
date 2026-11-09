import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirebaseCloudClient, googleSignInErrorMessage } from '../frontend/src/firebase-cloud.js';
import { chooseAuthenticatedResume } from '../frontend/src/resume-persistence.js';

function createFakeFirebase({ popupError = null, signOutError = null } = {}) {
  const records = new Map();
  let generatedId = 0;
  const auth = {
    currentUser: {
      uid: 'user-1',
      displayName: 'Existing Name',
      getIdToken: async () => 'firebase-token',
      reload: async () => {}
    }
  };
  let authObserver;
  let signedInWith;
  let redirectedWith;
  let signedOut = false;
  const appSdk = {
    getApps: () => [],
    initializeApp: config => ({ config }),
    getApp: () => ({})
  };
  class GoogleAuthProvider {}
  const authSdk = {
    getAuth: () => auth,
    GoogleAuthProvider,
    signInWithPopup: async (_auth, provider) => {
      if (popupError) throw popupError;
      signedInWith = provider;
    },
    signInWithRedirect: async (_auth, provider) => { redirectedWith = provider; },
    signOut: async () => {
      if (signOutError) throw signOutError;
      signedOut = true;
    },
    onAuthStateChanged: (_auth, next) => {
      authObserver = next;
      return () => { authObserver = null; };
    }
  };
  const firestoreSdk = {
    getFirestore: () => ({}),
    collection: (_db, ...segments) => ({ path: segments.join('/') }),
    doc: (parent, ...segments) => {
      const prefix = parent.path || '';
      const suffix = segments.join('/');
      const key = [prefix, suffix || `resume-${++generatedId}`].filter(Boolean).join('/');
      return { key, id: key.split('/').at(-1) };
    },
    getDoc: async ref => ({
      exists: () => records.has(ref.key),
      data: () => records.get(ref.key)
    }),
    setDoc: async (ref, value, options = {}) => {
      records.set(ref.key, options.merge ? { ...records.get(ref.key), ...value } : value);
    },
    orderBy: (field, direction) => ({ field, direction }),
    query: collection => collection,
    getDocs: async collection => ({
      docs: [...records.entries()]
        .filter(([key]) => key.startsWith(`${collection.path}/`))
        .map(([key, data]) => ({
          id: key.split('/').at(-1),
          data: () => data
        }))
    }),
    runTransaction: async (_db, callback) => callback({
      get: async ref => ({
        exists: () => records.has(ref.key),
        data: () => records.get(ref.key)
      }),
      set: (ref, value, options = {}) => {
        records.set(ref.key, options.merge ? { ...records.get(ref.key), ...value } : value);
      }
    }),
    serverTimestamp: () => ({ toMillis: () => 1_700_000_000_000 }),
    deleteDoc: async ref => { records.delete(ref.key); }
  };
  const fetchImpl = async (_url, options) => {
    const key = 'users/user-1/profile/account';
    const record = records.get(key) || { mobileNumber: '', photoDataUrl: '' };
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body);
      Object.assign(auth.currentUser, { displayName: body.displayName });
      records.set(key, { mobileNumber: body.mobileNumber, photoDataUrl: body.photoDataUrl });
      return { ok: true, json: async () => body };
    }
    return { ok: true, json: async () => record };
  };
  const client = createFirebaseCloudClient({
    config: { projectId: 'test-project' },
    loadSdk: async () => [appSdk, authSdk, firestoreSdk],
    fetchImpl
  });
  return {
    client,
    auth,
    records,
    GoogleAuthProvider,
    get signedInWith() { return signedInWith; },
    get redirectedWith() { return redirectedWith; },
    get signedOut() { return signedOut; },
    setSignOutError(error) { signOutError = error; },
    emitAuth(user) { authObserver?.(user); }
  };
}

test('Google auth, token ownership, and auth observer lifecycle use the signed-in account', async () => {
  const firebase = createFakeFirebase();
  let observedUser;
  const stopObserving = firebase.client.observeAuth(user => { observedUser = user; });
  await new Promise(resolve => setImmediate(resolve));
  firebase.emitAuth(firebase.auth.currentUser);
  assert.equal(observedUser.uid, 'user-1');

  await firebase.client.signInWithGoogle();
  assert.ok(firebase.signedInWith instanceof firebase.GoogleAuthProvider);
  assert.equal(await firebase.client.getFirebaseIdToken(firebase.auth.currentUser), 'firebase-token');
  await assert.rejects(firebase.client.getFirebaseIdToken({ uid: 'someone-else' }), /Sign in/);
  await firebase.client.signOutUser();
  assert.equal(firebase.signedOut, true);
  stopObserving();
});

test('Google sign-in falls back to redirect when the browser blocks a popup', async () => {
  const firebase = createFakeFirebase({ popupError: { code: 'auth/popup-blocked' } });

  await firebase.client.signInWithGoogle();

  assert.ok(firebase.redirectedWith instanceof firebase.GoogleAuthProvider);
  assert.equal(firebase.signedInWith, undefined);
});

test('Firebase sign-out errors are surfaced and the same client can retry', async () => {
  const firebase = createFakeFirebase({ signOutError: new Error('Temporary sign-out failure') });

  await assert.rejects(firebase.client.signOutUser(), /Temporary sign-out failure/);
  assert.equal(firebase.signedOut, false);

  firebase.setSignOutError(null);
  await firebase.client.signOutUser();
  assert.equal(firebase.signedOut, true);
});

test('account profile reads and writes mobile privately and updates only the signed-in display name', async () => {
  const firebase = createFakeFirebase();
  const user = firebase.auth.currentUser;

  assert.deepEqual(await firebase.client.getAccountProfile(user), { mobileNumber: '', photoDataUrl: '' });
  const photoDataUrl = 'data:image/jpeg;base64,/9j/2Q==';
  assert.deepEqual(await firebase.client.saveAccountProfile(user, 'Updated Name', '+1 (415) 555-0134', photoDataUrl), {
    name: 'Updated Name',
    mobile: '+1 (415) 555-0134',
    photo: photoDataUrl
  });
  assert.equal(user.displayName, 'Updated Name');
  assert.deepEqual(await firebase.client.getAccountProfile(user), {
    mobileNumber: '+1 (415) 555-0134',
    photoDataUrl
  });
  assert.ok(firebase.records.has('users/user-1/profile/account'));
  assert.equal(firebase.records.get('users/user-1/profile/account').mobileNumber, '+1 (415) 555-0134');
  assert.equal(firebase.records.get('users/user-1/profile/account').photoDataUrl, photoDataUrl);

  await assert.rejects(firebase.client.getAccountProfile({ uid: 'someone-else' }), /Sign in to the account/);
  await assert.rejects(firebase.client.saveAccountProfile(user, '  ', '1234567'), /Enter a name/);
  await assert.rejects(firebase.client.saveAccountProfile(user, 'Valid Name', '123'), /valid mobile number/);
  await assert.rejects(firebase.client.saveAccountProfile(user, 'Valid Name', '', 'data:image/svg+xml;base64,abc'), /valid profile image/);
});

test('Google sign-in reports actionable Firebase configuration and domain errors', () => {
  assert.match(googleSignInErrorMessage({ code: 'auth/operation-not-allowed' }), /Enable Google/);
  assert.match(googleSignInErrorMessage({ code: 'auth/unauthorized-domain' }, 'example.com'), /example\.com/);
  assert.match(googleSignInErrorMessage({ code: 'auth/unauthorized-domain' }, '127.0.0.1'), /using localhost/);
});

test('cloud resume create, list, revision update, conflict detection, and delete are scoped per user', async () => {
  const firebase = createFakeFirebase();
  const firstState = { profile: { name: 'Alex' } };
  const created = await firebase.client.saveResume('user-1', null, 'First resume', firstState);
  assert.deepEqual(created, { id: 'resume-1', revision: 1 });
  assert.ok(firebase.records.has('users/user-1/resumes/resume-1'));

  const listed = await firebase.client.listResumes('user-1');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'First resume');
  assert.deepEqual(listed[0].state, firstState);

  await firebase.client.setLastWorkedResumeId('user-1', created.id);
  assert.equal(await firebase.client.getLastWorkedResumeId('user-1'), created.id);
  assert.equal(await firebase.client.getLastWorkedResumeId('user-2'), null);
  await firebase.client.setLastWorkedResumeId('user-2', 'other-account-resume');
  assert.equal(await firebase.client.getLastWorkedResumeId('user-1'), created.id);

  const updated = await firebase.client.saveResume(
    'user-1', created.id, 'Updated resume', { profile: { name: 'Alex M.' } }, 1
  );
  assert.equal(updated.revision, 2);
  await assert.rejects(
    firebase.client.saveResume('user-1', created.id, 'Stale edit', firstState, 1),
    /changed elsewhere/
  );
  assert.equal((await firebase.client.listResumes('user-2')).length, 0);

  await firebase.client.deleteResume('user-1', created.id);
  assert.equal((await firebase.client.listResumes('user-1')).length, 0);
});

test('last-worked resume selection prefers the saved account selection and falls back to newest', () => {
  const resumes = [
    { id: 'newest-resume' },
    { id: 'previously-opened-resume' }
  ];

  assert.deepEqual(chooseAuthenticatedResume({
    hasGuestDraft: true,
    resumes,
    lastWorkedResumeId: 'previously-opened-resume'
  }), { type: 'open-cloud-resume', resumeId: 'previously-opened-resume' });
  assert.deepEqual(chooseAuthenticatedResume({
    hasGuestDraft: false,
    resumes,
    lastWorkedResumeId: 'deleted-resume'
  }), { type: 'open-cloud-resume', resumeId: 'newest-resume' });
});

test('Pro-template PDF trial allowance allows two lifetime claims and rejects later claims', async () => {
  const firebase = createFakeFirebase();
  assert.deepEqual(await firebase.client.getProTemplateDownloadStatus('user-1'), { used: 0, remaining: 2 });

  assert.deepEqual(await firebase.client.consumeProTemplateDownload('user-1'), {
    allowed: true, used: 1, remaining: 1
  });
  assert.deepEqual(await firebase.client.consumeProTemplateDownload('user-1'), {
    allowed: true, used: 2, remaining: 0
  });
  assert.deepEqual(await firebase.client.getProTemplateDownloadStatus('user-1'), { used: 2, remaining: 0 });
  assert.deepEqual(await firebase.client.consumeProTemplateDownload('user-1'), {
    allowed: false, used: 2, remaining: 0
  });
  assert.deepEqual(await firebase.client.getProTemplateDownloadStatus('user-2'), { used: 0, remaining: 2 });
});
