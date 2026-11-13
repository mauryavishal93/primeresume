const SESSION_CACHE_PREFIX = 'resumeout:session-cache:v1:';
const PRO_BADGE_HINT_KEY = `${SESSION_CACHE_PREFIX}pro-badge-hint`;
const ACCOUNT_AVATAR_HINT_KEY = `${SESSION_CACHE_PREFIX}account-avatar-hint`;
const ACCOUNT_AVATAR_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const accountAvatarRequests = new Map();

function sessionCacheKey(name, uid = '') {
  return `${SESSION_CACHE_PREFIX}${name}${uid ? `:${encodeURIComponent(uid)}` : ''}`;
}

function getSessionStorage() {
  try {
    return globalThis.sessionStorage;
  } catch (error) {
    console.warn('Session cache is unavailable in this browser.', error);
    return null;
  }
}

function removeCachedValue(storage, key) {
  try {
    storage.removeItem(key);
  } catch (error) {
    console.warn('Could not remove a session cache entry.', error);
  }
}

function getLocalStorage() {
  try {
    const storage = globalThis.localStorage;
    if (!storage || ['getItem', 'setItem', 'removeItem'].some(method => typeof storage[method] !== 'function')) {
      return null;
    }
    return storage;
  } catch (error) {
    console.warn('Pro badge cache is unavailable in this browser.', error);
    return null;
  }
}

export function getCachedProBadgeHint(now = Date.now()) {
  const storage = getLocalStorage();
  if (!storage) return null;
  try {
    const serialized = storage.getItem(PRO_BADGE_HINT_KEY);
    if (!serialized) return null;
    const hint = JSON.parse(serialized);
    if (typeof hint?.uid !== 'string' || !hint.uid
      || !Number.isFinite(hint.validUntil) || hint.validUntil <= now) {
      removeCachedValue(storage, PRO_BADGE_HINT_KEY);
      return null;
    }
    return { uid: hint.uid, validUntil: hint.validUntil };
  } catch (error) {
    console.warn('Could not read the Pro badge cache.', error);
    removeCachedValue(storage, PRO_BADGE_HINT_KEY);
    return null;
  }
}

export function cacheProBadgeHint(uid, entitlement) {
  const storage = getLocalStorage();
  if (!storage || !uid) return;
  if (entitlement?.source !== 'server-verified'
    || entitlement.status !== 'active'
    || !Number.isFinite(entitlement.validUntil)
    || entitlement.validUntil <= Date.now()) {
    clearCachedProBadgeHint(uid);
    return;
  }
  try {
    storage.setItem(PRO_BADGE_HINT_KEY, JSON.stringify({ uid, validUntil: entitlement.validUntil }));
  } catch (error) {
    console.warn('Could not write the Pro badge cache.', error);
  }
}

export function clearCachedProBadgeHint(uid) {
  const storage = getLocalStorage();
  if (!storage) return;
  if (uid) {
    try {
      const serialized = storage.getItem(PRO_BADGE_HINT_KEY);
      if (serialized && JSON.parse(serialized)?.uid !== uid) return;
    } catch (error) {
      console.warn('Could not verify the Pro badge cache owner.', error);
    }
  }
  removeCachedValue(storage, PRO_BADGE_HINT_KEY);
}

export function getCachedAccountAvatarHint(now = Date.now()) {
  const storage = getLocalStorage();
  if (!storage) return null;
  try {
    const serialized = storage.getItem(ACCOUNT_AVATAR_HINT_KEY);
    if (!serialized) return null;
    const hint = JSON.parse(serialized);
    if (typeof hint?.uid !== 'string' || !hint.uid
      || typeof hint.photoDataUrl !== 'string' || !hint.photoDataUrl
      || !Number.isFinite(hint.savedAt) || now < hint.savedAt
      || now - hint.savedAt > ACCOUNT_AVATAR_CACHE_TTL_MS) {
      removeCachedValue(storage, ACCOUNT_AVATAR_HINT_KEY);
      return null;
    }
    return { uid: hint.uid, photoDataUrl: hint.photoDataUrl };
  } catch (error) {
    console.warn('Could not read the cached account avatar.', error);
    removeCachedValue(storage, ACCOUNT_AVATAR_HINT_KEY);
    return null;
  }
}

function saveAccountAvatarHint(uid, photoDataUrl) {
  const storage = getLocalStorage();
  if (!storage || !uid || !photoDataUrl) return;
  try {
    storage.setItem(ACCOUNT_AVATAR_HINT_KEY, JSON.stringify({
      uid,
      photoDataUrl,
      savedAt: Date.now()
    }));
  } catch (error) {
    console.warn('Could not persist the account avatar cache.', error);
  }
}

function dataUrlFromBlob(blob) {
  return blob.arrayBuffer().then(buffer => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return `data:${blob.type};base64,${btoa(binary)}`;
  });
}

export async function cacheAccountPhotoFromUrls(uid, photoUrls) {
  if (!uid) return;
  const cached = getCachedAccountAvatarHint();
  if (cached?.uid === uid) return;
  if (accountAvatarRequests.has(uid)) return accountAvatarRequests.get(uid);

  const request = (async () => {
    for (const url of photoUrls) {
      if (typeof url !== 'string' || !/^https:\/\//i.test(url)) continue;
      try {
        const response = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'force-cache' });
        if (!response.ok) continue;
        const blob = await response.blob();
        if (!/^image\/(?:jpeg|png|webp)$/i.test(blob.type) || blob.size > 256_000) continue;
        saveAccountAvatarHint(uid, await dataUrlFromBlob(blob));
        return;
      } catch {
        continue;
      }
    }
  })();
  accountAvatarRequests.set(uid, request);
  try {
    await request;
  } finally {
    if (accountAvatarRequests.get(uid) === request) accountAvatarRequests.delete(uid);
  }
}

export function readSessionCache(name, uid, maxAgeMs, now = Date.now()) {
  const storage = getSessionStorage();
  if (!storage) return null;
  const key = sessionCacheKey(name, uid);
  try {
    const serialized = storage.getItem(key);
    if (!serialized) return null;
    const cached = JSON.parse(serialized);
    if (!Number.isFinite(cached?.savedAt) || now < cached.savedAt || now - cached.savedAt > maxAgeMs) {
      removeCachedValue(storage, key);
      return null;
    }
    return cached.value ?? null;
  } catch (error) {
    console.warn('Could not read the session cache.', error);
    removeCachedValue(storage, key);
    return null;
  }
}

export function writeSessionCache(name, uid, value, now = Date.now()) {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(sessionCacheKey(name, uid), JSON.stringify({ savedAt: now, value }));
  } catch (error) {
    console.warn('Could not write the session cache.', error);
  }
}

export function clearSessionCache(name, uid) {
  const storage = getSessionStorage();
  if (!storage) return;
  removeCachedValue(storage, sessionCacheKey(name, uid));
}

export function clearUserSessionCache(uid) {
  clearSessionCache('billing-entitlement', uid);
  clearSessionCache('account-photo', uid);
  clearCachedProBadgeHint(uid);
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    const serialized = storage.getItem(ACCOUNT_AVATAR_HINT_KEY);
    if (serialized && JSON.parse(serialized)?.uid === uid) {
      removeCachedValue(storage, ACCOUNT_AVATAR_HINT_KEY);
    }
  } catch (error) {
    console.warn('Could not clear the cached account avatar.', error);
    removeCachedValue(storage, ACCOUNT_AVATAR_HINT_KEY);
  }
}

const ACCOUNT_PHOTO_CACHE_TTL_MS = 30 * 60 * 1000;

export function getCachedAccountPhoto(uid) {
  if (!uid) return null;
  const cached = readSessionCache('account-photo', uid, ACCOUNT_PHOTO_CACHE_TTL_MS);
  if (typeof cached?.photoDataUrl === 'string' && cached.photoDataUrl) return cached.photoDataUrl;
  const hint = getCachedAccountAvatarHint();
  return hint?.uid === uid ? hint.photoDataUrl : null;
}

export function cacheAccountPhoto(uid, photoDataUrl) {
  if (!uid || typeof photoDataUrl !== 'string') return;
  writeSessionCache('account-photo', uid, { photoDataUrl });
  if (photoDataUrl) saveAccountAvatarHint(uid, photoDataUrl);
}

export function clearCachedAccountAvatar(uid) {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    const serialized = storage.getItem(ACCOUNT_AVATAR_HINT_KEY);
    if (serialized && JSON.parse(serialized)?.uid === uid) {
      removeCachedValue(storage, ACCOUNT_AVATAR_HINT_KEY);
    }
  } catch (error) {
    console.warn('Could not remove the cached account avatar.', error);
    removeCachedValue(storage, ACCOUNT_AVATAR_HINT_KEY);
  }
}
