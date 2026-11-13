import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirebaseCloudClient, googleSignInErrorMessage, isDisabledAccountSignInError, isGoogleSignInCancellation, resolveFirebaseConfig } from '../frontend/src/firebase-cloud.js';
import { chooseAuthenticatedResume } from '../frontend/src/resume-persistence.js';

test('Firebase web config can be selected per build environment', () => {
  assert.deepEqual(resolveFirebaseConfig({
    VITE_FIREBASE_API_KEY: 'new-api-key',
    VITE_FIREBASE_AUTH_DOMAIN: 'resumeout.firebaseapp.com',
    VITE_FIREBASE_PROJECT_ID: 'resumeout',
    VITE_FIREBASE_APP_ID: 'new-app-id'
  }), {
    apiKey: 'new-api-key',
    authDomain: 'resumeout.firebaseapp.com',
    projectId: 'resumeout',
    appId: 'new-app-id'
  });
  assert.equal(resolveFirebaseConfig({}).projectId, 'buildmyportfolio-5b714');
});

function createFakeFirebase({ popupError = null, popupDelay = null, signOutError = null } = {}) {
  const records = new Map();
  const sharedResumes = new Map();
  let activePopupError = popupError;
  let generatedId = 0;
  let generatedShareId = 0;
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
  let popupCalls = 0;
  let cancelPendingPopup;
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
      popupCalls++;
      if (cancelPendingPopup) {
        const cancel = cancelPendingPopup;
        cancelPendingPopup = null;
        cancel({ code: 'auth/cancelled-popup-request' });
      }
      if (popupDelay) {
        await new Promise((resolve, reject) => {
          cancelPendingPopup = reject;
          popupDelay.then(resolve, reject);
        });
      }
      if (activePopupError) throw activePopupError;
      signedInWith = provider;
      return { user: auth.currentUser };
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
    query: (collection, ...constraints) => ({ ...collection, constraints }),
    where: (field, operator, value) => ({ type: 'where', field, operator, value }),
    limit: count => ({ type: 'limit', count }),
    getDocs: async collection => ({
      docs: [...records.entries()]
        .filter(([key]) => key.startsWith(`${collection.path}/`))
        .filter(([, data]) => collection.constraints?.every(constraint =>
          constraint.type !== 'where'
          || (constraint.operator === '==' && data[constraint.field] === constraint.value)
        ))
        .slice(0, collection.constraints?.find(constraint => constraint.type === 'limit')?.count ?? Infinity)
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
  const fetchImpl = async (url, options = {}) => {
    const sharedRoute = /^\/api\/shared-resumes(?:\/([A-Za-z0-9_-]+))?$/.exec(url);
    if (sharedRoute) {
      const shareId = sharedRoute[1];
      const method = options.method || 'GET';
      const respond = (ok, data, status = ok ? 200 : 400) => ({
        ok,
        status,
        json: async () => data
      });
      if (method === 'POST' && !shareId) {
        const ownerShares = [...sharedResumes.values()].filter(share => share.ownerUid === 'user-1' && share.active);
        if (ownerShares.length >= 50) {
          return respond(false, { error: 'You have reached the limit of 50 active share links.' }, 409);
        }
        const body = JSON.parse(options.body);
        const id = `share-${++generatedShareId}`;
        sharedResumes.set(id, {
          ...body,
          ownerUid: 'user-1',
          active: true,
          createdAt: 1_700_000_000_000
        });
        return respond(true, { id }, 201);
      }
      if (method === 'GET' && !shareId) {
        return respond(true, {
          shares: [...sharedResumes.entries()]
            .filter(([, share]) => share.ownerUid === 'user-1')
            .slice(0, 50)
            .map(([id, share]) => ({ id, ...share }))
        });
      }
      if (method === 'GET' && shareId) {
        const share = sharedResumes.get(shareId);
        return share?.active
          ? respond(true, { name: share.name, state: share.state })
          : respond(false, { error: 'This resume share link is unavailable.' }, 404);
      }
      if (method === 'DELETE' && shareId) {
        sharedResumes.delete(shareId);
        return respond(true, {});
      }
      return respond(false, { error: 'Not found.' }, 404);
    }
    const key = 'users/user-1/profile/account';
    const record = records.get(key) || {
      mobileNumber: '',
      photoDataUrl: '',
      highestEducation: '',
      company: '',
      designation: ''
    };
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body);
      Object.assign(auth.currentUser, { displayName: body.displayName });
      records.set(key, {
        mobileNumber: body.mobileNumber,
        photoDataUrl: body.photoDataUrl,
        highestEducation: body.highestEducation,
        company: body.company,
        designation: body.designation
      });
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
    sharedResumes,
    GoogleAuthProvider,
    get signedInWith() { return signedInWith; },
    get popupCalls() { return popupCalls; },
    get redirectedWith() { return redirectedWith; },
    get signedOut() { return signedOut; },
    setPopupError(error) { activePopupError = error; },
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

  const signInResult = await firebase.client.signInWithGoogle();
  assert.equal(signInResult.user.uid, 'user-1');
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

test('rapid Google sign-in requests open a fresh popup and canceled popup requests are ignored', async () => {
  let finishPopup;
  const popupDelay = new Promise(resolve => { finishPopup = resolve; });
  const firebase = createFakeFirebase({ popupDelay });

  const firstRequest = firebase.client.signInWithGoogle();
  const secondRequest = firebase.client.signInWithGoogle();
  assert.notStrictEqual(firstRequest, secondRequest);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(firebase.popupCalls, 2);
  finishPopup();
  await Promise.all([firstRequest, secondRequest]);

  const canceledPopup = createFakeFirebase({ popupError: { code: 'auth/cancelled-popup-request' } });
  await assert.doesNotReject(canceledPopup.client.signInWithGoogle());
  assert.equal(canceledPopup.redirectedWith, undefined);

  const closedPopup = createFakeFirebase({ popupError: { code: 'auth/popup-closed-by-user' } });
  await assert.doesNotReject(closedPopup.client.signInWithGoogle());
  assert.equal(closedPopup.redirectedWith, undefined);
  const consentCancelled = createFakeFirebase({ popupError: { code: 'auth/user-cancelled' } });
  await assert.doesNotReject(consentCancelled.client.signInWithGoogle());
  assert.equal(consentCancelled.redirectedWith, undefined);
  assert.equal(isGoogleSignInCancellation({ code: 'auth/user-cancelled' }), true);
  assert.equal(isGoogleSignInCancellation({ message: 'Firebase: IdP denied access. (auth/user-cancelled).' }), true);
  assert.equal(googleSignInErrorMessage({ code: 'auth/user-cancelled' }), '');
  closedPopup.setPopupError(null);
  await closedPopup.client.signInWithGoogle();
  assert.ok(closedPopup.signedInWith instanceof closedPopup.GoogleAuthProvider);
});

test('Firebase sign-out errors are surfaced and the same client can retry', async () => {
  const firebase = createFakeFirebase({ signOutError: new Error('Temporary sign-out failure') });

  await assert.rejects(firebase.client.signOutUser(), /Temporary sign-out failure/);
  assert.equal(firebase.signedOut, false);

  firebase.setSignOutError(null);
  await firebase.client.signOutUser();
  assert.equal(firebase.signedOut, true);
});

test('account profile reads and writes personal details and updates only the signed-in display name', async () => {
  const firebase = createFakeFirebase();
  const user = firebase.auth.currentUser;

  assert.deepEqual(await firebase.client.getAccountProfile(user), {
    mobileNumber: '',
    photoDataUrl: '',
    highestEducation: '',
    company: '',
    designation: ''
  });
  const photoDataUrl = 'data:image/jpeg;base64,/9j/2Q==';
  assert.deepEqual(await firebase.client.saveAccountProfile(user, 'Updated Name', '+1 (415) 555-0134', photoDataUrl, {
    highestEducation: 'Bachelor of Science',
    company: 'Example Inc.',
    designation: 'Product Designer'
  }), {
    name: 'Updated Name',
    mobile: '+1 (415) 555-0134',
    photo: photoDataUrl,
    highestEducation: 'Bachelor of Science',
    company: 'Example Inc.',
    designation: 'Product Designer'
  });
  assert.equal(user.displayName, 'Updated Name');
  assert.deepEqual(await firebase.client.getAccountProfile(user), {
    mobileNumber: '+1 (415) 555-0134',
    photoDataUrl,
    highestEducation: 'Bachelor of Science',
    company: 'Example Inc.',
    designation: 'Product Designer'
  });
  assert.ok(firebase.records.has('users/user-1/profile/account'));
  assert.equal(firebase.records.get('users/user-1/profile/account').mobileNumber, '+1 (415) 555-0134');
  assert.equal(firebase.records.get('users/user-1/profile/account').photoDataUrl, photoDataUrl);
  assert.equal(firebase.records.get('users/user-1/profile/account').company, 'Example Inc.');

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

test('disabled Google accounts receive a friendly message and do not reject into UI error handlers', async () => {
  const firebase = createFakeFirebase({ popupError: { code: 'auth/user-disabled', message: 'Firebase: Error (auth/user-disabled).' } });
  const originalDispatchEvent = globalThis.dispatchEvent;
  const dispatchedEvents = [];
  globalThis.dispatchEvent = event => dispatchedEvents.push(event.type);

  try {
    assert.equal(isDisabledAccountSignInError({ code: 'auth/user-disabled' }), true);
    assert.equal(googleSignInErrorMessage({ code: 'auth/user-disabled' }), 'Please contact our support team for help.');
    assert.doesNotMatch(googleSignInErrorMessage({ code: 'auth/user-disabled' }), /Firebase|auth\//);
    assert.equal(await firebase.client.signInWithGoogle(), null);
    assert.equal(firebase.redirectedWith, undefined);
    assert.deepEqual(dispatchedEvents, ['firebase-account-sign-in-disabled']);
  } finally {
    if (originalDispatchEvent === undefined) delete globalThis.dispatchEvent;
    else globalThis.dispatchEvent = originalDispatchEvent;
  }
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

test('shared resumes can be opened by link, listed and revoked only by the owner', async () => {
  const firebase = createFakeFirebase();
  const state = {
    version: 4,
    docName: 'Alex resume',
    template: 'classic',
    profile: { name: 'Alex', email: 'alex@example.com', photo: 'data:image/jpeg;base64,abc' },
    design: { accent: '#31547a', font: 'Arial' },
    sections: [
      { id: 'experience-1', type: 'experience', title: 'Experience', entries: [
        { role: 'Engineer', company: 'Example Co.', date: '2022—Present', details: 'Built the full product.\nImproved reliability.' }
      ] },
      { id: 'skills-1', type: 'skills', title: 'Skills', content: 'JavaScript, TypeScript' }
    ],
    importedSourceText: 'Complete imported source resume'
  };
  const created = await firebase.client.createSharedResume('user-1', 'Alex resume', state, 'resume-1');

  assert.match(created.id, /^share-/);
  assert.deepEqual(await firebase.client.getSharedResume(created.id), {
    name: 'Alex resume',
    state
  });
  assert.deepEqual(firebase.sharedResumes.get(created.id).state, state);
  assert.deepEqual(await firebase.client.listSharedResumes('user-1'), [{
    id: created.id,
    name: 'Alex resume',
    sourceResumeId: 'resume-1',
    active: true,
    createdAt: 1_700_000_000_000
  }]);

  await assert.rejects(firebase.client.listSharedResumes('user-2'), /Sign in to the account/);
  await assert.rejects(
    firebase.client.createSharedResume('user-2', 'Other account', state),
    /Sign in to the account/
  );
  await assert.rejects(firebase.client.revokeSharedResume('user-2', created.id), /Sign in to the account/);

  await firebase.client.revokeSharedResume('user-1', created.id);
  assert.deepEqual(await firebase.client.listSharedResumes('user-1'), []);
  await assert.rejects(firebase.client.getSharedResume(created.id), /unavailable/);
});

test('shared resume creation rejects invalid names, references, and oversized payloads', async () => {
  const firebase = createFakeFirebase();
  await assert.rejects(firebase.client.createSharedResume('user-1', ' ', {}), /valid resume name/);
  await assert.rejects(firebase.client.createSharedResume('user-1', 'Valid name', null), /resume data is invalid/);
  await assert.rejects(
    firebase.client.createSharedResume('user-1', 'Valid name', {}, 'x'.repeat(1501)),
    /source resume reference is invalid/
  );
  await assert.rejects(
    firebase.client.createSharedResume('user-1', 'Valid name', { data: 'x'.repeat(800 * 1024) }),
    /too large to share/
  );
  await assert.rejects(firebase.client.getSharedResume('../invalid'), /share link is invalid/);
});

test('shared resume creation limits each owner to 50 active links', async () => {
  const firebase = createFakeFirebase();
  for (let index = 0; index < 50; index++) {
    await firebase.client.createSharedResume('user-1', `Resume ${index + 1}`, {});
  }
  await assert.rejects(
    firebase.client.createSharedResume('user-1', 'Resume 51', {}),
    /limit of 50 active share links/
  );
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
