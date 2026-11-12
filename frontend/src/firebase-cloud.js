const firebaseConfig = {
  apiKey: 'AIzaSyCxl9HVMLrWJg-H9RxaEAVJJJk6iiWlIVU',
  authDomain: 'buildmyportfolio-5b714.firebaseapp.com',
  projectId: 'buildmyportfolio-5b714',
  appId: '1:1044468425413:web:b7bd4d482eb7d9b67146ac'
};

export const cloudConfigured = Object.values(firebaseConfig).every(value => typeof value === 'string' && value.length > 0);

export function isGoogleSignInCancellation(error) {
  return ['auth/cancelled-popup-request', 'auth/popup-closed-by-user', 'auth/user-cancelled'].includes(error?.code)
    || /\(auth\/(?:cancelled-popup-request|popup-closed-by-user|user-cancelled)\)/.test(error?.message || '');
}

export function googleSignInErrorMessage(error, hostname = globalThis.location?.hostname || 'this domain') {
  if (isGoogleSignInCancellation(error)) return '';
  switch (error?.code) {
    case 'auth/configuration-not-found':
    case 'auth/operation-not-allowed':
      return 'Google sign-in is not enabled for this Firebase project. Enable Google under Firebase Authentication → Sign-in method.';
    case 'auth/unauthorized-domain':
      if (hostname === '127.0.0.1') {
        return `This domain (${hostname}) is not authorized for Firebase sign-in. For local development, open this site using localhost, or add ${hostname} under Firebase Authentication → Settings → Authorized domains.`;
      }
      return `This domain (${hostname}) is not authorized for Firebase sign-in. Add it under Firebase Authentication → Settings → Authorized domains.`;
    case 'auth/popup-blocked':
    case 'auth/operation-not-supported-in-this-environment':
      return 'Your browser blocked the Google sign-in popup. Allow popups for this site and try again.';
    case 'auth/network-request-failed':
      return 'Google sign-in could not reach Firebase. Check your internet connection and try again.';
    default:
      return error?.message || 'Could not sign in with Google.';
  }
}

const loadFirebaseSdk = () => Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
      import('firebase/firestore')
    ]);

export function createFirebaseCloudClient({ config = firebaseConfig, loadSdk = loadFirebaseSdk, fetchImpl = globalThis.fetch } = {}) {
  const isConfigured = Object.values(config).every(value => typeof value === 'string' && value.length > 0);
  let servicesPromise;

  async function getServices() {
    if (!isConfigured) throw new Error('Cloud saving is not configured yet.');
    if (!servicesPromise) {
      servicesPromise = loadSdk().then(([appSdk, authSdk, firestoreSdk]) => {
        const app = appSdk.getApps().length ? appSdk.getApp() : appSdk.initializeApp(config);
        return {
          auth: authSdk.getAuth(app),
          authSdk,
          db: firestoreSdk.getFirestore(app),
          firestoreSdk
        };
      });
    }
    return servicesPromise;
  }

  function resumeCollection(firestoreSdk, db, uid) {
    return firestoreSdk.collection(db, 'users', uid, 'resumes');
  }

  function editorPreference(firestoreSdk, db, uid) {
    return firestoreSdk.doc(db, 'users', uid, 'preferences', 'resumeEditor');
  }

  function requireCurrentAccount(auth, uid) {
    if (!auth.currentUser || auth.currentUser.uid !== uid) {
      throw new Error('Sign in to the account you want to update.');
    }
  }

  function validateAccountProfile(displayName, mobileNumber, photoDataUrl = '') {
    const name = typeof displayName === 'string' ? displayName.trim() : '';
    const mobile = typeof mobileNumber === 'string' ? mobileNumber.trim() : null;
    const photo = typeof photoDataUrl === 'string' ? photoDataUrl : null;
    if (!name || name.length > 80) throw new Error('Enter a name between 1 and 80 characters.');
    if (mobile === null || mobile.length > 24 || !/^[+0-9() .-]*$/.test(mobile)
      || (mobile && (mobile.match(/\d/g) || []).length < 7)
      || (mobile && (mobile.match(/\d/g) || []).length > 15)) {
      throw new Error('Enter a valid mobile number with 7 to 15 digits.');
    }
    if (photo === null || photo.length > 140000
      || (photo && !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(photo))) {
      throw new Error('Choose a valid profile image smaller than 100 KB.');
    }
    return { name, mobile, photo };
  }

  async function getAccountProfile(user) {
    if (!user?.uid) throw new Error('Sign in to view your account details.');
    const { auth } = await getServices();
    requireCurrentAccount(auth, user.uid);
    const token = await getFirebaseIdToken(user);
    const response = await fetchImpl('/api/account/profile', {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store'
    });
    const profile = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(profile.error || 'Could not load your account details. Please try again.');
    const { mobileNumber, photoDataUrl = '' } = profile;
    if (typeof mobileNumber !== 'string' || typeof photoDataUrl !== 'string'
      || photoDataUrl.length > 140000
      || (photoDataUrl && !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(photoDataUrl))) {
      throw new Error('Your saved account details are invalid. Contact support for help.');
    }
    return { mobileNumber, photoDataUrl };
  }

  async function saveAccountProfile(user, displayName, mobileNumber, photoDataUrl = '') {
    if (!user?.uid) throw new Error('Sign in to update your account details.');
    const profile = validateAccountProfile(displayName, mobileNumber, photoDataUrl);
    const { auth } = await getServices();
    requireCurrentAccount(auth, user.uid);
    const token = await getFirebaseIdToken(user);
    const response = await fetchImpl('/api/account/profile', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        displayName: profile.name,
        mobileNumber: profile.mobile,
        photoDataUrl: profile.photo
      })
    });
    const savedProfile = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(savedProfile.error || 'Could not save your account details. Please try again.');
    await auth.currentUser.reload();
    return {
      name: savedProfile.displayName,
      mobile: savedProfile.mobileNumber,
      photo: savedProfile.photoDataUrl
    };
  }

  function observeAuth(callback) {
    if (!isConfigured) {
      callback(null, new Error('Cloud saving is not configured yet.'));
      return () => {};
    }
    let cancelled = false;
    let unsubscribe = () => {};
    getServices().then(({ auth, authSdk }) => {
      if (cancelled) return;
      unsubscribe = authSdk.onAuthStateChanged(auth, user => callback(user, null), error => callback(null, error));
    }).catch(error => {
      if (!cancelled) callback(null, error);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }

  function signInWithGoogle() {
    return (async () => {
      try {
        const { auth, authSdk } = await getServices();
        const provider = new authSdk.GoogleAuthProvider();
        await authSdk.signInWithPopup(auth, provider);
      } catch (error) {
        if (isGoogleSignInCancellation(error)) return;
        if (!['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(error?.code)) {
          throw error;
        }
        const { auth, authSdk } = await getServices();
        const provider = new authSdk.GoogleAuthProvider();
        await authSdk.signInWithRedirect(auth, provider);
      }
    })();
  }

  async function signOutUser() {
    const { auth, authSdk } = await getServices();
    await authSdk.signOut(auth);
  }

  async function getFirebaseIdToken(user) {
    const { auth } = await getServices();
    const signedInUser = auth.currentUser;
    if (!user || !signedInUser || signedInUser.uid !== user.uid) {
      throw new Error('Sign in before accessing account features.');
    }
    return signedInUser.getIdToken();
  }

  async function listResumes(uid) {
    const { db, firestoreSdk } = await getServices();
    const result = await firestoreSdk.getDocs(firestoreSdk.query(
      resumeCollection(firestoreSdk, db, uid),
      firestoreSdk.orderBy('updatedAt', 'desc')
    ));
    return result.docs.map(snapshot => {
      const data = snapshot.data();
      return {
        id: snapshot.id,
        name: data.name,
        state: data.state,
        revision: data.revision,
        updatedAt: data.updatedAt?.toMillis?.() ?? 0
      };
    });
  }

  async function getLastWorkedResumeId(uid) {
    const { db, firestoreSdk } = await getServices();
    const snapshot = await firestoreSdk.getDoc(editorPreference(firestoreSdk, db, uid));
    if (!snapshot.exists()) return null;
    const id = snapshot.data().lastWorkedResumeId;
    if (typeof id !== 'string') {
      throw new Error('The saved last-opened resume preference is invalid.');
    }
    return id || null;
  }

  async function setLastWorkedResumeId(uid, resumeId) {
    if (typeof resumeId !== 'string' || !resumeId || resumeId.length > 1500) {
      throw new Error('A valid cloud resume ID is required.');
    }
    const { db, firestoreSdk } = await getServices();
    await firestoreSdk.setDoc(editorPreference(firestoreSdk, db, uid), {
      lastWorkedResumeId: resumeId
    });
  }

  async function saveResume(uid, id, name, state, expectedRevision = null) {
    const stateJson = JSON.stringify(state);
    const encoder = new TextEncoder();
    const documentSize = encoder.encode(stateJson).byteLength + encoder.encode(name).byteLength;
    if (documentSize > 800 * 1024) {
      throw new Error('This resume is too large to sync safely. Remove large images or content, then try again.');
    }

    const { db, firestoreSdk } = await getServices();
    const collectionRef = resumeCollection(firestoreSdk, db, uid);
    const ref = id ? firestoreSdk.doc(collectionRef, id) : firestoreSdk.doc(collectionRef);
    const revision = await firestoreSdk.runTransaction(db, async transaction => {
      const snapshot = await transaction.get(ref);
      if (snapshot.exists()) {
        const currentRevision = snapshot.data().revision;
        if (expectedRevision === null || currentRevision !== expectedRevision) {
          throw new Error('This resume was changed elsewhere. Reload it from your cloud resume list before continuing.');
        }
        const nextRevision = currentRevision + 1;
        transaction.set(ref, {
          name: name.slice(0, 120),
          state,
          revision: nextRevision,
          createdAt: snapshot.data().createdAt,
          updatedAt: firestoreSdk.serverTimestamp()
        });
        return nextRevision;
      }
      if (expectedRevision !== null) {
        throw new Error('This cloud resume no longer exists. Refresh your cloud resume list before continuing.');
      }
      transaction.set(ref, {
        name: name.slice(0, 120),
        state,
        revision: 1,
        createdAt: firestoreSdk.serverTimestamp(),
        updatedAt: firestoreSdk.serverTimestamp()
      });
      return 1;
    });
    return { id: ref.id, revision };
  }

  async function deleteResume(uid, id) {
    const { db, firestoreSdk } = await getServices();
    await firestoreSdk.deleteDoc(firestoreSdk.doc(resumeCollection(firestoreSdk, db, uid), id));
  }

  async function createSharedResume(uid, name, state, sourceResumeId = '') {
    if (typeof name !== 'string' || !name.trim() || name.length > 120) {
      throw new Error('A valid resume name is required to create a share link.');
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('The resume data is invalid and cannot be shared.');
    }
    const stateJson = JSON.stringify(state);
    if (new TextEncoder().encode(stateJson).byteLength > 800 * 1024) {
      throw new Error('This resume is too large to share safely. Remove large images or content, then try again.');
    }
    if (typeof sourceResumeId !== 'string' || sourceResumeId.length > 1500) {
      throw new Error('The source resume reference is invalid.');
    }
    const { auth } = await getServices();
    requireCurrentAccount(auth, uid);
    const user = auth.currentUser;
    const token = await getFirebaseIdToken(user);
    const response = await fetchImpl('/api/shared-resumes', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ name: name.trim(), state, sourceResumeId })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Could not create a resume share link.');
    if (typeof result.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(result.id)) {
      throw new Error('The server returned an invalid resume share link.');
    }
    return { id: result.id };
  }

  async function listSharedResumes(uid) {
    const { auth } = await getServices();
    requireCurrentAccount(auth, uid);
    const token = await getFirebaseIdToken(auth.currentUser);
    const response = await fetchImpl('/api/shared-resumes', {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Could not load your share links.');
    if (!Array.isArray(result.shares)) throw new Error('The server returned an invalid share-link list.');
    return result.shares.map(share => {
      if (!share || typeof share.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(share.id)
        || typeof share.name !== 'string' || typeof share.active !== 'boolean') {
        throw new Error('A saved share link is invalid. Refresh the list or contact support.');
      }
      return {
        id: share.id,
        name: share.name,
        sourceResumeId: typeof share.sourceResumeId === 'string' ? share.sourceResumeId : '',
        active: share.active,
        createdAt: Number.isFinite(share.createdAt) ? share.createdAt : 0
      };
    });
  }

  async function getSharedResume(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new Error('This resume share link is invalid.');
    }
    const response = await fetchImpl(`/api/shared-resumes/${encodeURIComponent(id)}`, {
      cache: 'no-store'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'This resume share link is unavailable.');
    if (typeof result.name !== 'string' || !result.state || typeof result.state !== 'object' || Array.isArray(result.state)) {
      throw new Error('This shared resume is invalid and cannot be opened.');
    }
    return { name: result.name, state: result.state };
  }

  async function revokeSharedResume(uid, id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new Error('This resume share link is invalid.');
    }
    const { auth } = await getServices();
    requireCurrentAccount(auth, uid);
    const token = await getFirebaseIdToken(auth.currentUser);
    const response = await fetchImpl(`/api/shared-resumes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Could not revoke this resume share link.');
  }

  async function getProTemplateDownloadStatus(uid) {
    const { db, firestoreSdk } = await getServices();
    const ref = firestoreSdk.doc(db, 'users', uid, 'trial', 'proTemplateDownloads');
    const snapshot = await firestoreSdk.getDoc(ref);
    const used = snapshot.exists() ? snapshot.data().count : 0;
    if (!Number.isInteger(used) || used < 0 || used > 2) {
      throw new Error('The Pro-template trial counter is invalid. Contact support before retrying.');
    }
    return { used, remaining: Math.max(0, 2 - used) };
  }

  async function consumeProTemplateDownload(uid) {
    const { db, firestoreSdk } = await getServices();
    const ref = firestoreSdk.doc(db, 'users', uid, 'trial', 'proTemplateDownloads');
    return firestoreSdk.runTransaction(db, async transaction => {
      const snapshot = await transaction.get(ref);
      const used = snapshot.exists() ? snapshot.data().count : 0;
      if (!Number.isInteger(used) || used < 0 || used > 2) {
        throw new Error('The Pro-template trial counter is invalid. Contact support before retrying.');
      }
      if (used >= 2) return { allowed: false, used, remaining: 0 };

      const nextUsed = used + 1;
      transaction.set(ref, {
        count: nextUsed,
        updatedAt: firestoreSdk.serverTimestamp()
      });
      return { allowed: true, used: nextUsed, remaining: 2 - nextUsed };
    });
  }

  return {
    cloudConfigured: isConfigured,
    observeAuth,
    signInWithGoogle,
    signOutUser,
    getFirebaseIdToken,
    getAccountProfile,
    saveAccountProfile,
    listResumes,
    getLastWorkedResumeId,
    setLastWorkedResumeId,
    saveResume,
    deleteResume,
    createSharedResume,
    listSharedResumes,
    getSharedResume,
    revokeSharedResume,
    getProTemplateDownloadStatus,
    consumeProTemplateDownload
  };
}

const defaultClient = createFirebaseCloudClient();
export const observeAuth = defaultClient.observeAuth;
export const signInWithGoogle = defaultClient.signInWithGoogle;
export const signOutUser = defaultClient.signOutUser;
export const getFirebaseIdToken = defaultClient.getFirebaseIdToken;
export const getAccountProfile = defaultClient.getAccountProfile;
export const saveAccountProfile = defaultClient.saveAccountProfile;
export const listResumes = defaultClient.listResumes;
export const getLastWorkedResumeId = defaultClient.getLastWorkedResumeId;
export const setLastWorkedResumeId = defaultClient.setLastWorkedResumeId;
export const saveResume = defaultClient.saveResume;
export const deleteResume = defaultClient.deleteResume;
export const createSharedResume = defaultClient.createSharedResume;
export const listSharedResumes = defaultClient.listSharedResumes;
export const getSharedResume = defaultClient.getSharedResume;
export const revokeSharedResume = defaultClient.revokeSharedResume;
export const getProTemplateDownloadStatus = defaultClient.getProTemplateDownloadStatus;
export const consumeProTemplateDownload = defaultClient.consumeProTemplateDownload;
