import express from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  billingPlan,
  billingPlanEnvKey,
  BILLING_CURRENCY_PLANS,
  BILLING_PLANS,
  billingCheckoutConfigured,
  configuredVouchers,
  currencyForRazorpayPlanId,
  entitlementFromSubscription,
  firebaseAdminConfigured,
  isRazorpayPlanId,
  planKeyForRazorpayPlanId,
  planMatchesRazorpay,
  validRazorpaySignature,
  validWebhookSignature,
  voucherDocumentId
} from './billing.js';

const backendDir = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.resolve(backendDir, '../.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const distDir = path.resolve(backendDir, '../dist');
const app = express();
const port = Number(process.env.PORT) || 3000;
const subscriptionCollection = 'billingSubscriptions';
let firebaseAdmin;

app.disable('x-powered-by');

app.use((request, response, next) => {
  const hostname = String(request.hostname || '').toLowerCase();
  const isApiRequest = request.path === '/api' || request.path.startsWith('/api/');
  if (hostname === 'buildmyportfolio.onrender.com' && !isApiRequest) {
    return response.redirect(301, `https://primeresume-ten.vercel.app${request.originalUrl || '/'}`);
  }
  next();
});

function requireBillingConfig(_request, response, next) {
  if (!billingCheckoutConfigured()) {
    response.status(503).json({ error: 'Paid plans are not configured on this server yet.' });
    return;
  }
  next();
}

function requireEntitlementConfig(_request, response, next) {
  if (!firebaseAdminConfigured()) {
    response.status(503).json({ error: 'Plan status is unavailable on this server.' });
    return;
  }
  next();
}

function requireSubscriptionManagementConfig(_request, response, next) {
  const { keyId, keySecret } = razorpayConfiguration();
  if (!firebaseAdminConfigured() || !keyId || !keySecret) {
    response.status(503).json({ error: 'Subscription management is unavailable on this server.' });
    return;
  }
  next();
}

async function getFirebaseAdmin() {
  if (app.locals.firebaseAdmin) return app.locals.firebaseAdmin;
  if (firebaseAdmin) return firebaseAdmin;
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) throw new Error('Firebase Admin credentials are not configured.');

  const [{ cert, getApps, initializeApp }, { getAuth }, { getFirestore }] = await Promise.all([
    import('firebase-admin/app'),
    import('firebase-admin/auth'),
    import('firebase-admin/firestore')
  ]);
  const appInstance = getApps()[0] || initializeApp({
    credential: cert(JSON.parse(serviceAccountJson))
  });
  firebaseAdmin = {
    auth: getAuth(appInstance),
    db: getFirestore(appInstance)
  };
  return firebaseAdmin;
}

async function requireFirebaseUser(request, response, next) {
  const match = /^Bearer\s+(.+)$/i.exec(request.get('authorization') || '');
  if (!match) {
    response.status(401).json({ error: 'Sign in before accessing this feature.' });
    return;
  }

  if (!app.locals.firebaseAdmin && !firebaseAdmin && !firebaseAdminConfigured()) {
    response.status(503).json({ error: 'Firebase Admin credentials are not configured on this server.' });
    return;
  }

  try {
    const admin = await getFirebaseAdmin();
    request.user = await admin.auth.verifyIdToken(match[1], true);
    next();
  } catch (error) {
    console.error('Firebase authentication failed.', error);
    response.status(401).json({ error: 'Your sign-in could not be verified. Sign in again and retry.' });
  }
}

async function optionalFirebaseUser(request, response, next) {
  const match = /^Bearer\s+(.+)$/i.exec(request.get('authorization') || '');
  if (!match) {
    next();
    return;
  }
  if (!app.locals.firebaseAdmin && !firebaseAdmin && !firebaseAdminConfigured()) {
    response.status(503).json({ error: 'Firebase Admin credentials are not configured on this server.' });
    return;
  }
  try {
    const admin = await getFirebaseAdmin();
    request.user = await admin.auth.verifyIdToken(match[1], true);
    next();
  } catch (error) {
    console.error('Optional Firebase authentication failed.', error);
    response.status(401).json({ error: 'Your sign-in could not be verified. Sign in again and retry.' });
  }
}

function validForumText(value, minimum, maximum) {
  return typeof value === 'string' && value.trim().length >= minimum && value.trim().length <= maximum
    ? value.trim()
    : null;
}

function forumPostInput(body, type = body?.type) {
  if (!['review', 'discussion'].includes(type)) return null;
  const title = validForumText(body?.title, 4, 120);
  const content = validForumText(body?.content, 10, 4000);
  const rating = body?.rating;
  if (!title || !content) return null;
  if (type === 'review' && (!Number.isInteger(rating) || rating < 1 || rating > 5)) return null;
  return { type, title, content, ...(type === 'review' ? { rating } : {}) };
}

function forumCommentInput(body) {
  return validForumText(body?.content, 1, 2000);
}

function forumAuthorName(user) {
  return validForumText(user?.name, 1, 80)
    || validForumText(user?.email?.split('@')[0], 1, 80)
    || 'Google user';
}

function forumSnapshotExists(snapshot) {
  return Boolean(snapshot?.exists);
}

function publicForumPost(document, viewerUid = null, includeDeleted = false) {
  const data = document.data();
  if (data.isDeleted && !includeDeleted) return null;
  const post = forumPostInput(data);
  if (!post) return null;
  return {
    id: document.id,
    ...post,
    authorName: forumAuthorName({ name: data.authorName }),
    isOwner: Boolean(viewerUid && viewerUid === data.authorUid),
    createdAt: Number.isFinite(data.createdAt) ? data.createdAt : 0,
    updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : 0,
    ...(includeDeleted ? {
      isDeleted: Boolean(data.isDeleted),
      deletedAt: Number.isFinite(data.deletedAt) ? data.deletedAt : null
    } : {})
  };
}

function publicForumComment(document, viewerUid = null) {
  const data = document.data();
  const content = forumCommentInput(data);
  if (!content) return null;
  return {
    id: document.id,
    content,
    authorName: forumAuthorName({ name: data.authorName }),
    isOwner: Boolean(viewerUid && viewerUid === data.authorUid),
    createdAt: Number.isFinite(data.createdAt) ? data.createdAt : 0
  };
}

async function deleteForumComments(postReference, post, actor) {
  const comments = postReference.collection('comments');
  while (true) {
    const snapshot = await comments.limit(100).get();
    if (!snapshot.docs.length) return;
    const { db } = await getFirebaseAdmin();
    const batch = db.batch();
    for (const document of snapshot.docs) {
      const comment = document.data();
      const activity = {
        eventType: 'comment_deleted',
        userUid: comment.authorUid,
        userName: forumAuthorName({ name: comment.authorName }),
        actorUid: actor.uid,
        actorName: forumAuthorName(actor),
        postId: postReference.id,
        postTitle: post.title,
        commentId: document.id,
        reason: 'post_deleted',
        before: { content: forumCommentInput(comment) },
        after: null,
        occurredAt: Date.now()
      };
      appendForumActivityWrites(batch, db, activity);
      batch.delete(comments.doc(document.id));
    }
    await batch.commit();
  }
}

async function permanentlyDeleteForumComments(db, postReference) {
  const comments = postReference.collection('comments');
  let deletedCount = 0;
  while (true) {
    const snapshot = await comments.limit(400).get();
    if (!snapshot.docs.length) return deletedCount;
    const batch = db.batch();
    snapshot.docs.forEach(document => batch.delete(comments.doc(document.id)));
    await batch.commit();
    deletedCount += snapshot.docs.length;
  }
}

async function permanentlyDeleteForumActivity(db, postId, commentId = null) {
  const collection = db.collection('forumActivity');
  let query = collection.where('postId', '==', postId);
  let cursor = null;
  let deletedCount = 0;
  while (true) {
    let pageQuery = query.limit(250);
    if (cursor) pageQuery = pageQuery.startAfter(cursor);
    const snapshot = await pageQuery.get();
    if (!snapshot.docs.length) break;
    const matchingDocs = commentId
      ? snapshot.docs.filter(document => document.data().commentId === commentId)
      : snapshot.docs;
    if (matchingDocs.length) {
      const batch = db.batch();
      matchingDocs.forEach(document => {
        const event = document.data();
        batch.delete(db.doc(document.ref.path));
        if (typeof event.userUid === 'string' && event.userUid) {
          batch.delete(db.collection('users').doc(event.userUid).collection('forumActivity').doc(document.id));
        }
      });
      await batch.commit();
      deletedCount += matchingDocs.length;
    }
    if (snapshot.docs.length < 250) break;
    cursor = snapshot.docs.at(-1);
  }
  return deletedCount;
}

async function permanentlyDeleteForumPost(db, postReference, postId) {
  await permanentlyDeleteForumComments(db, postReference);
  await permanentlyDeleteForumActivity(db, postId);
  await postReference.delete();
}

async function permanentlyDeleteAdminPost(db, postId) {
  const postReference = db.collection('forumPosts').doc(postId);
  const snapshot = await postReference.get();
  if (!forumSnapshotExists(snapshot)) {
    const commentCount = await permanentlyDeleteForumComments(db, postReference);
    const activityCount = await permanentlyDeleteForumActivity(db, postId);
    return Boolean(commentCount || activityCount);
  }
  await permanentlyDeleteForumPost(db, postReference, postId);
  return true;
}

async function permanentlyDeleteAdminComment(db, postId, commentId) {
  const postReference = db.collection('forumPosts').doc(postId);
  const commentReference = postReference.collection('comments').doc(commentId);
  const commentSnapshot = await commentReference.get();
  const activityCount = await permanentlyDeleteForumActivity(db, postId, commentId);
  if (!forumSnapshotExists(commentSnapshot) && !activityCount) return false;
  if (forumSnapshotExists(commentSnapshot)) await commentReference.delete();
  return true;
}

function forumPostSnapshot(post) {
  if (!post) return null;
  return {
    type: post.type,
    title: post.title,
    content: post.content,
    ...(post.type === 'review' ? { rating: post.rating } : {})
  };
}

function appendForumActivityWrites(batch, db, activity) {
  const eventId = randomUUID();
  const record = { ...activity, id: eventId };
  batch.set(db.collection('forumActivity').doc(eventId), record);
  batch.set(db.collection('users').doc(activity.userUid).collection('forumActivity').doc(eventId), record);
}

function publicForumActivity(document) {
  const data = document.data();
  if (!data || typeof data.userUid !== 'string' || typeof data.eventType !== 'string') return null;
  return {
    id: document.id,
    eventType: data.eventType,
    userUid: data.userUid,
    userName: forumAuthorName({ name: data.userName }),
    actorUid: typeof data.actorUid === 'string' ? data.actorUid : null,
    actorName: forumAuthorName({ name: data.actorName }),
    postId: typeof data.postId === 'string' ? data.postId : '',
    postTitle: typeof data.postTitle === 'string' ? data.postTitle : '',
    commentId: typeof data.commentId === 'string' ? data.commentId : null,
    reason: typeof data.reason === 'string' ? data.reason : null,
    before: data.before && typeof data.before === 'object' ? data.before : null,
    after: data.after && typeof data.after === 'object' ? data.after : null,
    occurredAt: Number.isFinite(data.occurredAt) ? data.occurredAt : 0
  };
}

function validForumActivityCursor(cursor) {
  return cursor === undefined || (typeof cursor === 'string' && validForumText(cursor, 1, 150));
}

async function loadForumActivity(collection, cursor, includeDeletions = true) {
  let query = collection.orderBy('occurredAt', 'desc');
  if (cursor) {
    const cursorSnapshot = await collection.doc(cursor).get();
    if (!forumSnapshotExists(cursorSnapshot)) return null;
    query = query.startAfter(cursorSnapshot);
  }
  const deletionEventsPromise = includeDeletions
    ? Promise.resolve([])
    : Promise.all(['post_deleted', 'comment_deleted'].map(eventType =>
      collection.where('eventType', '==', eventType).get()
    )).then(snapshots => snapshots.flatMap(result =>
      result.docs.map(publicForumActivity).filter(Boolean)
    ));
  const [snapshot, deletionEvents] = await Promise.all([
    query.limit(50).get(),
    deletionEventsPromise
  ]);
  const events = snapshot.docs.map(publicForumActivity).filter(Boolean);
  const deletedPostIds = new Set(deletionEvents
    .filter(event => event.eventType === 'post_deleted' || event.reason === 'post_deleted')
    .map(event => event.postId)
    .filter(Boolean));
  const deletedCommentIds = new Set(deletionEvents
    .filter(event => event.eventType === 'comment_deleted')
    .map(event => event.commentId)
    .filter(Boolean));
  return {
    events: includeDeletions
      ? events
      : events.filter(event =>
        !['post_deleted', 'comment_deleted'].includes(event.eventType)
        && !deletedPostIds.has(event.postId)
        && !deletedCommentIds.has(event.commentId)
      ),
    nextCursor: snapshot.docs.length === 50 ? snapshot.docs.at(-1).id : null
  };
}

function forumContentCursorPath(cursor, kind) {
  if (cursor === undefined) return null;
  if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return false;
  const path = Buffer.from(cursor, 'base64url').toString('utf8');
  if (Buffer.from(path, 'utf8').toString('base64url') !== cursor) return false;
  const parts = path.split('/');
  if (parts.some(part => !part || part.length > 150)) return false;
  const validPath = kind === 'posts'
    ? parts.length === 2 && parts[0] === 'forumPosts'
    : parts.length === 4 && parts[0] === 'forumPosts' && parts[2] === 'comments';
  return validPath ? path : false;
}

async function loadForumContent(db, kind, cursor, userUid = null) {
  const cursorPath = forumContentCursorPath(cursor, kind);
  if (cursorPath === false) return null;
  let query = kind === 'posts'
    ? db.collection('forumPosts')
    : db.collectionGroup('comments');
  if (userUid) query = query.where('authorUid', '==', userUid);
  if (cursorPath) {
    const cursorSnapshot = await db.doc(cursorPath).get();
    if (!forumSnapshotExists(cursorSnapshot)
      || (userUid && cursorSnapshot.data().authorUid !== userUid)) return null;
    query = query.startAfter(cursorSnapshot);
  }
  let snapshot;
  const documents = [];
  let hasMore = false;
  do {
    snapshot = await query.limit(25).get();
    const candidates = kind === 'posts' && userUid
      ? snapshot.docs.filter(document => !document.data().isDeleted && forumPostInput(document.data()))
      : snapshot.docs;
    const remaining = 25 - documents.length;
    documents.push(...candidates.slice(0, remaining));
    if (kind !== 'posts' || !userUid) {
      hasMore = snapshot.docs.length === 25;
      break;
    }
    if (candidates.length > remaining) {
      hasMore = true;
      break;
    }
    if (documents.length === 25 || snapshot.docs.length < 25) {
      hasMore = snapshot.docs.length === 25;
      break;
    }
    query = query.startAfter(snapshot.docs.at(-1));
  } while (true);
  const items = await Promise.all(documents.map(async document => {
    const data = document.data();
    const path = document.ref.path.split('/');
    if (kind === 'posts') {
      if (userUid && data.isDeleted) return null;
      const post = forumPostInput(data);
      if (!post) return null;
      return {
        id: document.id,
        ...post,
        authorName: forumAuthorName({ name: data.authorName }),
        ...(!userUid ? { authorUid: data.authorUid || '' } : {}),
        createdAt: Number.isFinite(data.createdAt) ? data.createdAt : 0,
        updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : 0,
        ...(!userUid ? {
          isDeleted: Boolean(data.isDeleted),
          deletedAt: Number.isFinite(data.deletedAt) ? data.deletedAt : null
        } : {})
      };
    }
    if (path.length !== 4 || path[0] !== 'forumPosts' || path[2] !== 'comments') return null;
    const content = forumCommentInput(data);
    if (!content) return null;
    const postSnapshot = await db.doc(`forumPosts/${path[1]}`).get();
    return {
      id: document.id,
      postId: path[1],
      postTitle: forumSnapshotExists(postSnapshot) && typeof postSnapshot.data().title === 'string'
        ? postSnapshot.data().title
        : 'Deleted post',
      content,
      authorName: forumAuthorName({ name: data.authorName }),
      ...(!userUid ? { authorUid: data.authorUid || '' } : {}),
      createdAt: Number.isFinite(data.createdAt) ? data.createdAt : 0
    };
  }));
  const validItems = items.filter(Boolean);
  const nextCursorDocument = kind === 'posts' && userUid ? documents.at(-1) : snapshot.docs.at(-1);
  return {
    items: validItems,
    nextCursor: hasMore
      ? Buffer.from(nextCursorDocument.ref.path, 'utf8').toString('base64url')
      : null
  };
}

export function normalizeAdminEmail(value) {
  if (typeof value !== 'string') return '';
  const cleaned = value.trim().replace(/^['"]+|['"]+$/g, '').replace(/\s+/g, '').toLowerCase().replace(/@+/g, '@');
  if (!cleaned || (cleaned.match(/@/g) || []).length !== 1) return '';
  const [localPart, domainPart] = cleaned.split('@');
  if (!localPart || !domainPart || localPart.includes('..') || domainPart.includes('..')) return '';
  return `${localPart}@${domainPart}`;
}

export function adminEmails() {
  return (process.env.ADMIN_EMAILS || '')
    .split(/[\n,;]+/)
    .map(normalizeAdminEmail)
    .filter(Boolean);
}

export function isAdminUser(user) {
  if (user?.admin === true || user?.claims?.admin === true) return true;
  const email = normalizeAdminEmail(user?.email || '');
  if (!email) return false;
  return adminEmails().includes(email);
}

async function requireAdmin(request, response, next) {
  try {
    if (!isAdminUser(request.user)) {
      response.status(403).json({ error: 'Administrator access required.' });
      return;
    }
    next();
  } catch (error) {
    response.status(403).json({ error: 'Administrator access required.' });
  }
}

function razorpayConfiguration() {
  return {
    keyId: (process.env.RAZORPAY_KEY_ID || '').trim(),
    keySecret: (process.env.RAZORPAY_KEY_SECRET || '').trim(),
    webhookSecret: (process.env.RAZORPAY_WEBHOOK_SECRET || '').trim()
  };
}

async function razorpayRequest(endpoint, { method = 'GET', body } = {}) {
  if (app.locals.razorpayRequest) {
    return app.locals.razorpayRequest(endpoint, { method, body });
  }
  const { keyId, keySecret } = razorpayConfiguration();
  const response = await fetch(`https://api.razorpay.com/v1${endpoint}`, {
    method,
    signal: AbortSignal.timeout(15_000),
    headers: {
      authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const providerDetail = data?.error?.description || data?.error?.code || data?.message || `HTTP ${response.status}`;
    const error = new Error(`Razorpay request failed with status ${response.status}: ${providerDetail}.`);
    error.status = response.status;
    error.providerDetail = providerDetail;
    throw error;
  }
  return data;
}

function providerPlanId(planKey, currency = 'INR', pricing = {}) {
  const envKey = billingPlanEnvKey(planKey, currency);
  const envValue = envKey ? (process.env[envKey] || '').trim() : '';
  const hasSavedCurrencyPlans = pricing?.providerPlanIds
    && Object.hasOwn(pricing.providerPlanIds, currency);
  const planId = pricing?.providerPlanIds?.[currency]?.[planKey]
    || (hasSavedCurrencyPlans ? '' : envValue);
  return isRazorpayPlanId(planId) ? planId : null;
}

function providerSubscriptionId(planKey, currency = 'INR') {
  const envKey = billingPlanEnvKey(planKey, currency);
  const envValue = envKey ? (process.env[envKey] || '').trim() : '';
  return /^sub_[A-Za-z0-9]+$/.test(envValue) ? envValue : null;
}

function providerPlanReferenceExists(planKey, currency, pricing) {
  return Boolean(providerPlanId(planKey, currency, pricing) || providerSubscriptionId(planKey, currency));
}

function pricingPlanEntry(pricing, planKey, currency) {
  return currency === 'INR' ? pricing?.[planKey] : pricing?.[currency]?.[planKey];
}

function pricedBillingPlan(planKey, currency, pricing) {
  const plan = billingPlan(planKey, currency);
  const currentPrice = Number(pricingPlanEntry(pricing, planKey, currency)?.currentPrice);
  if (!plan || !Number.isFinite(currentPrice) || currentPrice <= 0) return null;
  return { ...plan, amount: Math.round(currentPrice * 100) };
}

async function verifiedProviderPlan(planKey, currency = 'INR', pricing = {}) {
  const expected = pricedBillingPlan(planKey, currency, pricing);
  if (!expected) return null;
  let resolvedPlanId = providerPlanId(planKey, currency, pricing);
  if (!resolvedPlanId) {
    const subscriptionId = providerSubscriptionId(planKey, currency);
    if (!subscriptionId) {
      throw new Error(`The Razorpay ${currency} ${planKey} plan is not configured.`);
    }
    const subscription = await razorpayRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
    resolvedPlanId = subscription?.plan_id;
    if (!isRazorpayPlanId(resolvedPlanId)) {
      const error = new Error(`The configured Razorpay ${currency} ${planKey} subscription does not reference a valid plan.`);
      error.status = 503;
      throw error;
    }
  }
  const plan = await razorpayRequest(`/plans/${encodeURIComponent(resolvedPlanId)}`);
  if (!planMatchesRazorpay(plan, expected)) {
    const error = new Error(`The Razorpay ${currency} ${planKey} plan does not match the configured price and billing interval.`);
    error.status = 503;
    throw error;
  }
  return plan;
}

function subscriptionDocument(db, subscriptionId) {
  return db.collection(subscriptionCollection).doc(subscriptionId);
}

function userEntitlementDocument(db, uid) {
  return db.doc(`users/${uid}/billing/entitlement`);
}

function userCheckoutDocument(db, uid) {
  return db.doc(`users/${uid}/billing/checkout`);
}

function activatePendingVouchers(entitlement, now = Date.now()) {
  const pendingVouchers = Array.isArray(entitlement?.pendingVouchers)
    ? entitlement.pendingVouchers
    : [];
  const currentValidUntil = Number(entitlement?.validUntil) || 0;
  if (!pendingVouchers.length || currentValidUntil > now) return null;

  const durationMs = pendingVouchers.reduce((total, voucher) => {
    if (!Number.isInteger(voucher?.durationDays) || voucher.durationDays < 1 || voucher.durationDays > 3650) {
      throw new Error('Stored pending voucher duration is invalid.');
    }
    return total + voucher.durationDays * 24 * 60 * 60 * 1000;
  }, 0);
  return {
    ...entitlement,
    planId: 'pro',
    billingPlan: 'voucher',
    status: 'active',
    source: 'server-verified',
    validUntil: now + durationMs,
    subscriptionId: null,
    cancelAtCycleEnd: false,
    voucherId: pendingVouchers.at(-1).voucherId,
    pendingVouchers: [],
    updatedAt: now
  };
}

function schedulePendingVouchers(pendingVouchers, startsAt) {
  let nextStartAt = startsAt;
  return pendingVouchers.map(voucher => {
    const scheduledVoucher = { ...voucher, startsAt: nextStartAt };
    nextStartAt += voucher.durationDays * 24 * 60 * 60 * 1000;
    return scheduledVoucher;
  });
}

function publicEntitlement(data) {
  const validUntil = Number(data?.validUntil) || 0;
  const pendingVouchers = Array.isArray(data?.pendingVouchers) ? data.pendingVouchers : [];
  const status = data?.planId === 'pro' && validUntil > Date.now() ? 'active' : 'inactive';
  return {
    planId: data?.planId || 'free',
    billingPlan: data?.billingPlan || null,
    currency: data?.currency || 'INR',
    status,
    source: 'server-verified',
    validUntil,
    subscriptionId: data?.subscriptionId || null,
    cancelAtCycleEnd: data?.cancelAtCycleEnd === true,
    scheduledPlan: Object.hasOwn(BILLING_PLANS, data?.scheduledPlan) ? data.scheduledPlan : null,
    scheduledAt: Number(data?.scheduledAt) || null,
    planChangeStatus: data?.planChangeStatus || null,
    pendingVoucherCount: pendingVouchers.length,
    pendingVoucherStartAt: pendingVouchers.length
      ? Number(pendingVouchers[0].startsAt) || validUntil || null
      : null
  };
}


function billingActivityDocument(db, uid, id) {
  return db.doc(`users/${uid}/billingActivity/${id}`);
}

async function recordBillingActivity(db, uid, activity) {
  const occurredAt = Date.now();
  try {
    await billingActivityDocument(db, uid, randomUUID()).set({
      type: String(activity.type || 'billing'),
      status: String(activity.status || 'success'),
      title: String(activity.title || 'Billing activity'),
      detail: String(activity.detail || ''),
      planKey: activity.planKey || null,
      currency: activity.currency || null,
      amount: activity.amount || null,
      providerSubscriptionId: activity.providerSubscriptionId || null,
      actorType: ['user', 'admin'].includes(activity.actorType) ? activity.actorType : null,
      actorUid: activity.actorUid || null,
      occurredAt
    });
  } catch (error) {
    console.error('Could not write billing activity.', { uid, type: activity.type, error });
  }
  return occurredAt;
}

function normalizePlanPrice(rawValue, fallback) {
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.round(numeric * 100) / 100;
}

function calculateDiscount(actualPrice, currentPrice) {
  if (!Number.isFinite(actualPrice) || actualPrice <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(((actualPrice - currentPrice) / actualPrice) * 100)));
}

function normalizePricingAnnouncement(value) {
  const text = String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 240);
}

function normalizePricingConfig(rawConfig = {}) {
  const providerPlanIds = { INR: {}, USD: {} };
  const announcement = normalizePricingAnnouncement(rawConfig?.announcement ?? rawConfig?.priceAnnouncement ?? rawConfig?.message ?? rawConfig?.notice);
  const normalizePlan = (planKey, currency) => {
    const basePlan = billingPlan(planKey, currency);
    const rawPlan = pricingPlanEntry(rawConfig, planKey, currency);
    const actualPrice = normalizePlanPrice(rawPlan?.actualPrice, basePlan.amount / 100);
    const requestedCurrentPrice = normalizePlanPrice(rawPlan?.currentPrice, basePlan.amount / 100);
    const requestedPlanId = rawConfig?.providerPlanIds?.[currency]?.[planKey];
    const hasSavedCurrencyPlans = rawConfig?.providerPlanIds
      && Object.hasOwn(rawConfig.providerPlanIds, currency);
    const defaultPlanId = !hasSavedCurrencyPlans && requestedCurrentPrice * 100 === basePlan.amount
      ? providerPlanId(planKey, currency)
      : null;
    const planId = isRazorpayPlanId(requestedPlanId)
      ? requestedPlanId
      : defaultPlanId;
    const currentPrice = requestedCurrentPrice;
    if (planId) providerPlanIds[currency][planKey] = planId;
    return {
      actualPrice,
      currentPrice,
      discountPercent: calculateDiscount(actualPrice, currentPrice)
    };
  };
  const monthly = normalizePlan('monthly', 'INR');
  const yearly = normalizePlan('yearly', 'INR');
  const usdMonthly = normalizePlan('monthly', 'USD');
  const usdYearly = normalizePlan('yearly', 'USD');
  return {
    currency: 'INR',
    monthly,
    yearly,
    USD: {
      currency: 'USD',
      monthly: usdMonthly,
      yearly: usdYearly
    },
    announcement,
    providerPlanIds,
    updatedAt: Date.now()
  };
}

function publicPricingConfig(pricing) {
  const { providerPlanIds: _providerPlanIds, ...publicConfig } = pricing;
  return publicConfig;
}

async function loadPricingConfigFromStore() {
  try {
    const { db } = await getFirebaseAdmin();
    const snapshot = await db.doc('appConfig/pricing').get();
    return normalizePricingConfig(snapshot.exists ? snapshot.data() : {});
  } catch (error) {
    console.error('Could not load stored pricing configuration; using the server defaults.', error);
    return normalizePricingConfig({});
  }
}

async function findExistingMatchingProviderPlan(planKey, currency, amount) {
  const basePlan = billingPlan(planKey, currency);
  if (!basePlan) return null;
  try {
    const plans = await razorpayRequest('/plans');
    const items = Array.isArray(plans?.items) ? plans.items : [];
    const match = items.find(plan => plan?.item?.amount === amount
      && plan?.item?.currency === currency
      && plan?.period === basePlan.period
      && plan?.interval === basePlan.interval);
    if (!match) return null;
    const verified = await razorpayRequest(`/plans/${encodeURIComponent(match.id)}`);
    if (!planMatchesRazorpay(verified, { ...basePlan, amount })) {
      return null;
    }
    return verified.id;
  } catch {
    return null;
  }
}

async function createVerifiedProviderPlan(planKey, currency, amount) {
  const basePlan = billingPlan(planKey, currency);
  const expected = { ...basePlan, amount };
  const existing = await findExistingMatchingProviderPlan(planKey, currency, amount);
  if (existing) return existing;

  try {
    const created = await razorpayRequest('/plans', {
      method: 'POST',
      body: {
        period: basePlan.period,
        interval: basePlan.interval,
        item: {
          name: `ResumeOut.com ${basePlan.label}`,
          amount,
          currency,
          description: `${basePlan.label} recurring subscription`
        }
      }
    });
    if (typeof created?.id !== 'string' || !/^plan_[A-Za-z0-9]+$/.test(created.id)) {
      throw new Error(`Razorpay did not return a valid ${currency} ${planKey} plan ID.`);
    }
    const verified = await razorpayRequest(`/plans/${encodeURIComponent(created.id)}`);
    if (!planMatchesRazorpay(verified, expected)) {
      throw new Error(`The new Razorpay ${currency} ${planKey} plan failed amount or interval verification.`);
    }
    return verified.id;
  } catch (error) {
    const fallback = await findExistingMatchingProviderPlan(planKey, currency, amount);
    if (fallback) return fallback;
    throw error;
  }
}

function isUnsupportedRazorpayCurrency(error) {
  const providerDetail = typeof error?.providerDetail === 'string' ? error.providerDetail : '';
  const message = error instanceof Error ? error.message : '';
  return /currency provided is not supported/i.test(`${providerDetail} ${message}`);
}

app.get('/api/health', (_request, response) => {
  response
    .status(200)
    .set('Cache-Control', 'no-store')
    .json({
      status: 'ok',
      service: 'ResumeOut.com API',
      timestamp: new Date().toISOString()
    });
});

app.use('/api/billing/webhook', express.raw({ type: 'application/json', limit: '256kb' }));
app.use('/api/account/profile', express.json({ limit: '160kb' }));
app.use(express.json({ limit: '32kb' }));

app.use('/api/forum', (_request, response, next) => {
  response.set('Cache-Control', 'no-store');
  next();
});

app.use('/api/admin/forum', (_request, response, next) => {
  response.set('Cache-Control', 'no-store');
  next();
});

app.get('/api/account/profile', requireFirebaseUser, async (request, response) => {
  response.set('Cache-Control', 'no-store');
  try {
    const { db } = await getFirebaseAdmin();
    const snapshot = await db.doc(`users/${request.user.uid}/profile/account`).get();
    if (!snapshot.exists) {
      response.json({ mobileNumber: '', photoDataUrl: '' });
      return;
    }
    const { mobileNumber, photoDataUrl = '' } = snapshot.data();
    if (typeof mobileNumber !== 'string' || typeof photoDataUrl !== 'string'
      || photoDataUrl.length > 140000
      || (photoDataUrl && !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(photoDataUrl))) {
      response.status(500).json({ error: 'Your saved account details are invalid. Contact support for help.' });
      return;
    }
    response.json({ mobileNumber, photoDataUrl });
  } catch (error) {
    console.error('Could not load the account profile.', error);
    response.status(500).json({ error: 'Could not load your account details. Please try again.' });
  }
});

app.put('/api/account/profile', requireFirebaseUser, async (request, response) => {
  response.set('Cache-Control', 'no-store');
  const displayName = typeof request.body?.displayName === 'string' ? request.body.displayName.trim() : '';
  const mobileNumber = typeof request.body?.mobileNumber === 'string' ? request.body.mobileNumber.trim() : null;
  const photoDataUrl = typeof request.body?.photoDataUrl === 'string' ? request.body.photoDataUrl : null;
  if (!displayName || displayName.length > 80) {
    response.status(400).json({ error: 'Enter a name between 1 and 80 characters.' });
    return;
  }
  if (mobileNumber === null || mobileNumber.length > 24 || !/^[+0-9() .-]*$/.test(mobileNumber)
    || (mobileNumber && (mobileNumber.match(/\d/g) || []).length < 7)
    || (mobileNumber && (mobileNumber.match(/\d/g) || []).length > 15)) {
    response.status(400).json({ error: 'Enter a valid mobile number with 7 to 15 digits.' });
    return;
  }
  if (photoDataUrl === null || photoDataUrl.length > 140000
    || (photoDataUrl && !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(photoDataUrl))) {
    response.status(400).json({ error: 'Choose a valid profile image smaller than 100 KB.' });
    return;
  }
  try {
    const { auth, db } = await getFirebaseAdmin();
    await Promise.all([
      auth.updateUser(request.user.uid, { displayName }),
      db.doc(`users/${request.user.uid}/profile/account`).set({
        mobileNumber,
        photoDataUrl,
        updatedAt: new Date()
      })
    ]);
    response.json({ displayName, mobileNumber, photoDataUrl });
  } catch (error) {
    console.error('Could not save the account profile.', error);
    response.status(500).json({ error: 'Could not save your account details. Please try again.' });
  }
});

app.get('/api/forum/activity', requireFirebaseUser, async (request, response) => {
  const cursor = request.query.cursor;
  if (!validForumActivityCursor(cursor)) {
    response.status(400).json({ error: 'The activity page cursor is invalid.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const collection = db.collection('users').doc(request.user.uid).collection('forumActivity');
    const page = await loadForumActivity(collection, cursor, false);
    if (!page) {
      response.status(400).json({ error: 'This activity page cursor is no longer available. Reload your history.' });
      return;
    }
    response.json(page);
  } catch (error) {
    console.error('Could not load user community activity.', error);
    response.status(503).json({ error: 'Your community history is temporarily unavailable. Please try again.' });
  }
});

app.get('/api/admin/forum/activity', requireFirebaseUser, requireAdmin, async (request, response) => {
  const cursor = request.query.cursor;
  if (!validForumActivityCursor(cursor)) {
    response.status(400).json({ error: 'The activity page cursor is invalid.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const page = await loadForumActivity(db.collection('forumActivity'), cursor);
    if (!page) {
      response.status(400).json({ error: 'This activity page cursor is no longer available. Reload community history.' });
      return;
    }
    response.json(page);
  } catch (error) {
    console.error('Could not load admin community activity.', error);
    response.status(503).json({ error: 'Community history is temporarily unavailable. Please try again.' });
  }
});

app.get('/api/forum/my-content', requireFirebaseUser, async (request, response) => {
  const { kind, cursor } = request.query;
  if (!['posts', 'comments'].includes(kind)) {
    response.status(400).json({ error: 'Choose posts or comments to view your current content.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const page = await loadForumContent(db, kind, cursor, request.user.uid);
    if (!page) {
      response.status(400).json({ error: 'This content page cursor is invalid or no longer available. Reload your content.' });
      return;
    }
    response.json(page);
  } catch (error) {
    console.error('Could not load user community content.', error);
    response.status(503).json({ error: 'Your current community content is temporarily unavailable. Please try again.' });
  }
});

app.get('/api/admin/forum/content', requireFirebaseUser, requireAdmin, async (request, response) => {
  const { kind, cursor } = request.query;
  if (!['posts', 'comments'].includes(kind)) {
    response.status(400).json({ error: 'Choose posts or comments to view current community content.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const page = await loadForumContent(db, kind, cursor);
    if (!page) {
      response.status(400).json({ error: 'This content page cursor is invalid or no longer available. Reload community content.' });
      return;
    }
    response.json(page);
  } catch (error) {
    console.error('Could not load admin community content.', error);
    response.status(503).json({ error: 'Current community content is temporarily unavailable. Please try again.' });
  }
});

app.delete('/api/admin/forum/posts/:postId', requireFirebaseUser, requireAdmin, async (request, response) => {
  const { postId } = request.params;
  if (!postId || postId.length > 150) {
    response.status(400).json({ error: 'The post ID is invalid.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    if (!await permanentlyDeleteAdminPost(db, postId)) {
      response.status(404).json({ error: 'This post no longer exists.' });
      return;
    }
    response.status(204).end();
  } catch (error) {
    console.error('Could not permanently delete community post.', error);
    response.status(500).json({ error: 'The post and its community history could not be permanently deleted.' });
  }
});

app.post('/api/admin/forum/permanent-delete', requireFirebaseUser, requireAdmin, async (request, response) => {
  const { kind, postId, commentId } = request.body || {};
  if (!['post', 'comment'].includes(kind)
    || typeof postId !== 'string'
    || !postId
    || postId.length > 150
    || (kind === 'comment' && (typeof commentId !== 'string' || !commentId || commentId.length > 150))) {
    response.status(400).json({ error: 'The post or comment identifiers are invalid.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const deleted = kind === 'post'
      ? await permanentlyDeleteAdminPost(db, postId)
      : await permanentlyDeleteAdminComment(db, postId, commentId);
    if (!deleted) {
      response.status(404).json({ error: `This ${kind} no longer exists.` });
      return;
    }
    response.json({ deleted: true });
  } catch (error) {
    console.error(`Could not permanently delete community ${kind}.`, error);
    response.status(500).json({
      error: kind === 'post'
        ? 'The post and its community history could not be permanently deleted.'
        : 'The comment and its community history could not be permanently deleted.'
    });
  }
});

app.delete('/api/admin/forum/posts/:postId/comments/:commentId', requireFirebaseUser, requireAdmin, async (request, response) => {
  const { postId, commentId } = request.params;
  if (!postId || postId.length > 150 || !commentId || commentId.length > 150) {
    response.status(400).json({ error: 'The post or comment ID is invalid.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    if (!await permanentlyDeleteAdminComment(db, postId, commentId)) {
      response.status(404).json({ error: 'This comment no longer exists.' });
      return;
    }
    response.status(204).end();
  } catch (error) {
    console.error('Could not permanently delete community comment.', error);
    response.status(500).json({ error: 'The comment and its community history could not be permanently deleted.' });
  }
});

app.get('/api/forum/posts', optionalFirebaseUser, async (request, response) => {
  const cursor = request.query.cursor;
  if (cursor !== undefined && (typeof cursor !== 'string' || !validForumText(cursor, 1, 150))) {
    response.status(400).json({ error: 'The post page cursor is invalid.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const collection = db.collection('forumPosts');
    let query = collection.orderBy('createdAt', 'desc');
    if (cursor) {
      const cursorSnapshot = await collection.doc(cursor).get();
      if (!forumSnapshotExists(cursorSnapshot)) {
        response.status(400).json({ error: 'This post page cursor is no longer available. Reload the community feed.' });
        return;
      }
      query = query.startAfter(cursorSnapshot);
    }
    const posts = [];
    while (posts.length < 51) {
      const snapshot = await query.limit(50).get();
      for (const document of snapshot.docs) {
        const post = publicForumPost(document, request.user?.uid);
        if (post) posts.push({ post, document });
        if (posts.length === 51) break;
      }
      if (posts.length === 51 || snapshot.docs.length < 50) break;
      query = collection.orderBy('createdAt', 'desc').startAfter(snapshot.docs.at(-1));
    }
    const hasMore = posts.length > 50;
    const visiblePosts = posts.slice(0, 50);
    const feedPosts = visiblePosts.map(item => item.post);
    const ratings = feedPosts.filter(post => post.type === 'review' && Number.isInteger(post.rating));
    response.json({
      posts: feedPosts,
      nextCursor: hasMore ? visiblePosts.at(-1).document.id : null,
      ratingSummary: {
        count: ratings.length,
        average: ratings.length
          ? Math.round(ratings.reduce((total, post) => total + post.rating, 0) / ratings.length * 10) / 10
          : null
      }
    });

    app.get('/api/forum/posts/:postId', optionalFirebaseUser, async (request, response) => {
      const postId = request.params.postId;
      if (!postId || postId.length > 150) {
        response.status(400).json({ error: 'The post ID is invalid.' });
        return;
      }
      try {
        const { db } = await getFirebaseAdmin();
        const snapshot = await db.collection('forumPosts').doc(postId).get();
        if (!forumSnapshotExists(snapshot)) {
          response.status(404).json({ error: 'This post no longer exists.' });
          return;
        }
        const isDeleted = Boolean(snapshot.data().isDeleted);
        if (isDeleted && !isAdminUser(request.user)) {
          response.status(404).json({ error: 'This post is no longer available.' });
          return;
        }
        const post = publicForumPost(snapshot, request.user?.uid, true);
        if (!post) {
          response.status(404).json({ error: 'This post no longer exists.' });
          return;
        }
        response.json({ post });
      } catch (error) {
        console.error('Could not load community post.', error);
        response.status(503).json({ error: 'This community post is temporarily unavailable. Please try again.' });
      }
    });
  } catch (error) {
    console.error('Could not load community posts.', error);
    response.status(503).json({ error: 'Community posts are temporarily unavailable. Please try again.' });
  }
});

app.post('/api/forum/posts', requireFirebaseUser, async (request, response) => {
  const post = forumPostInput(request.body);
  if (!post) {
    response.status(400).json({ error: 'Enter a title and message. Reviews also need a rating from 1 to 5 stars.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const reference = db.collection('forumPosts').doc();
    const record = {
      ...post,
      authorUid: request.user.uid,
      authorName: forumAuthorName(request.user),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    const batch = db.batch();
    batch.set(reference, record);
    appendForumActivityWrites(batch, db, {
      eventType: 'post_created',
      userUid: request.user.uid,
      userName: forumAuthorName(request.user),
      actorUid: request.user.uid,
      actorName: forumAuthorName(request.user),
      postId: reference.id,
      postTitle: post.title,
      commentId: null,
      reason: null,
      before: null,
      after: forumPostSnapshot(post),
      occurredAt: record.createdAt
    });
    await batch.commit();
    response.status(201).json({
      post: {
        id: reference.id,
        ...post,
        authorName: record.authorName,
        isOwner: true,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
      }
    });
  } catch (error) {
    console.error('Could not create community post.', error);
    response.status(500).json({ error: 'Your post could not be published. Please try again.' });
  }
});

app.patch('/api/forum/posts/:postId', requireFirebaseUser, async (request, response) => {
  const postId = request.params.postId;
  if (!postId || postId.length > 150) {
    response.status(400).json({ error: 'The post ID is invalid.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const reference = db.collection('forumPosts').doc(postId);
    const snapshot = await reference.get();
    if (!forumSnapshotExists(snapshot)) {
      response.status(404).json({ error: 'This post no longer exists.' });
      return;
    }
    const current = snapshot.data();
    if (current.isDeleted) {
      response.status(404).json({ error: 'This post is no longer available.' });
      return;
    }
    if (current.authorUid !== request.user.uid) {
      response.status(403).json({ error: 'You can only edit your own posts.' });
      return;
    }
    if (request.body?.type && request.body.type !== current.type) {
      response.status(400).json({ error: 'A post cannot be changed between a review and a discussion.' });
      return;
    }
    const post = forumPostInput(request.body, current.type);
    if (!post) {
      response.status(400).json({ error: 'Enter a title and message. Reviews also need a rating from 1 to 5 stars.' });
      return;
    }
    const updated = { ...post, updatedAt: Date.now() };
    const batch = db.batch();
    batch.set(reference, updated, { merge: true });
    appendForumActivityWrites(batch, db, {
      eventType: 'post_edited',
      userUid: request.user.uid,
      userName: forumAuthorName(request.user),
      actorUid: request.user.uid,
      actorName: forumAuthorName(request.user),
      postId,
      postTitle: post.title,
      commentId: null,
      reason: null,
      before: forumPostSnapshot(current),
      after: forumPostSnapshot(post),
      occurredAt: updated.updatedAt
    });
    await batch.commit();
    response.json({
      post: {
        id: postId,
        ...post,
        authorName: forumAuthorName(request.user),
        isOwner: true,
        createdAt: current.createdAt,
        updatedAt: updated.updatedAt
      }
    });
  } catch (error) {
    console.error('Could not update community post.', error);
    response.status(500).json({ error: 'Your post could not be updated. Please try again.' });
  }
});

app.delete('/api/forum/posts/:postId', requireFirebaseUser, async (request, response) => {
  const postId = request.params.postId;
  if (!postId || postId.length > 150) {
    response.status(400).json({ error: 'The post ID is invalid.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const reference = db.collection('forumPosts').doc(postId);
    const snapshot = await reference.get();
    if (!forumSnapshotExists(snapshot)) {
      response.status(404).json({ error: 'This post no longer exists.' });
      return;
    }
    const current = snapshot.data();
    if (current.isDeleted) {
      response.status(404).json({ error: 'This post is no longer available.' });
      return;
    }
    if (current.authorUid !== request.user.uid) {
      response.status(403).json({ error: 'You can only delete your own posts.' });
      return;
    }
    await deleteForumComments(reference, current, request.user);
    const deletedAt = Date.now();
    const batch = db.batch();
    appendForumActivityWrites(batch, db, {
      eventType: 'post_deleted',
      userUid: request.user.uid,
      userName: forumAuthorName(request.user),
      actorUid: request.user.uid,
      actorName: forumAuthorName(request.user),
      postId,
      postTitle: current.title,
      commentId: null,
      reason: null,
      before: forumPostSnapshot(current),
      after: null,
      occurredAt: deletedAt
    });
    batch.set(reference, {
      isDeleted: true,
      deletedAt,
      deletedBy: request.user.uid,
      updatedAt: deletedAt
    }, { merge: true });
    await batch.commit();
    response.status(204).end();
  } catch (error) {
    console.error('Could not delete community post.', error);
    response.status(500).json({ error: 'Your post could not be deleted. Please try again.' });
  }
});

app.get('/api/forum/posts/:postId/comments', optionalFirebaseUser, async (request, response) => {
  const postId = request.params.postId;
  const cursor = request.query.cursor;
  if (!postId || postId.length > 150) {
    response.status(400).json({ error: 'The post ID is invalid.' });
    return;
  }
  if (cursor !== undefined && (typeof cursor !== 'string' || !validForumText(cursor, 1, 150))) {
    response.status(400).json({ error: 'The comment page cursor is invalid.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const postReference = db.collection('forumPosts').doc(postId);
    const postSnapshot = await postReference.get();
    if (!forumSnapshotExists(postSnapshot) || postSnapshot.data().isDeleted) {
      response.status(404).json({ error: 'This post no longer exists.' });
      return;
    }
    const collection = postReference.collection('comments');
    let query = collection.orderBy('createdAt', 'desc');
    if (cursor) {
      const cursorSnapshot = await collection.doc(cursor).get();
      if (!forumSnapshotExists(cursorSnapshot)) {
        response.status(400).json({ error: 'This comment page cursor is no longer available. Reload the comments.' });
        return;
      }
      query = query.startAfter(cursorSnapshot);
    }
    const snapshot = await query.limit(100).get();
    response.json({
      comments: snapshot.docs.map(document => publicForumComment(document, request.user?.uid)).filter(Boolean),
      nextCursor: snapshot.docs.length === 100 ? snapshot.docs.at(-1).id : null
    });
  } catch (error) {
    console.error('Could not load community comments.', error);
    response.status(503).json({ error: 'Comments are temporarily unavailable. Please try again.' });
  }
});

app.post('/api/forum/posts/:postId/comments', requireFirebaseUser, async (request, response) => {
  const postId = request.params.postId;
  const content = forumCommentInput(request.body);
  if (!postId || postId.length > 150 || !content) {
    response.status(400).json({ error: 'Enter a comment of up to 2,000 characters.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const postReference = db.collection('forumPosts').doc(postId);
    const postSnapshot = await postReference.get();
    if (!forumSnapshotExists(postSnapshot) || postSnapshot.data().isDeleted) {
      response.status(404).json({ error: 'This post no longer exists.' });
      return;
    }
    const reference = postReference.collection('comments').doc();
    const comment = {
      content,
      authorUid: request.user.uid,
      authorName: forumAuthorName(request.user),
      createdAt: Date.now()
    };
    const batch = db.batch();
    batch.set(reference, comment);
    appendForumActivityWrites(batch, db, {
      eventType: 'comment_created',
      userUid: request.user.uid,
      userName: forumAuthorName(request.user),
      actorUid: request.user.uid,
      actorName: forumAuthorName(request.user),
      postId,
      postTitle: postSnapshot.data().title,
      commentId: reference.id,
      reason: null,
      before: null,
      after: { content },
      occurredAt: comment.createdAt
    });
    await batch.commit();
    response.status(201).json({
      comment: {
        id: reference.id,
        content,
        authorName: comment.authorName,
        isOwner: true,
        createdAt: comment.createdAt
      }
    });
  } catch (error) {
    console.error('Could not create community comment.', error);
    response.status(500).json({ error: 'Your comment could not be published. Please try again.' });
  }
});

app.delete('/api/forum/posts/:postId/comments/:commentId', requireFirebaseUser, async (request, response) => {
  const { postId, commentId } = request.params;
  if (!postId || postId.length > 150 || !commentId || commentId.length > 150) {
    response.status(400).json({ error: 'The comment ID is invalid.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const postReference = db.collection('forumPosts').doc(postId);
    const postSnapshot = await postReference.get();
    if (!forumSnapshotExists(postSnapshot) || postSnapshot.data().isDeleted) {
      response.status(404).json({ error: 'This post no longer exists.' });
      return;
    }
    const reference = postReference.collection('comments').doc(commentId);
    const snapshot = await reference.get();
    if (!forumSnapshotExists(snapshot)) {
      response.status(404).json({ error: 'This comment no longer exists.' });
      return;
    }
    if (snapshot.data().authorUid !== request.user.uid) {
      response.status(403).json({ error: 'You can only delete your own comments.' });
      return;
    }
    const comment = snapshot.data();
    const batch = db.batch();
    appendForumActivityWrites(batch, db, {
      eventType: 'comment_deleted',
      userUid: request.user.uid,
      userName: forumAuthorName(request.user),
      actorUid: request.user.uid,
      actorName: forumAuthorName(request.user),
      postId,
      postTitle: postSnapshot.data().title,
      commentId,
      reason: null,
      before: { content: forumCommentInput(comment) },
      after: null,
      occurredAt: Date.now()
    });
    batch.delete(reference);
    await batch.commit();
    response.status(204).end();
  } catch (error) {
    console.error('Could not delete community comment.', error);
    response.status(500).json({ error: 'Your comment could not be deleted. Please try again.' });
  }
});

app.use('/api/billing', (_request, response, next) => {
  response.set('Cache-Control', 'no-store');
  next();
});

app.get('/api/pricing/config', async (_request, response) => {
  try {
    response.json({ pricing: publicPricingConfig(await loadPricingConfigFromStore()) });
  } catch (error) {
    console.error('Could not load public pricing config.', error);
    response.status(500).json({ error: 'Pricing configuration is temporarily unavailable.' });
  }
});

app.get('/api/admin/pricing', requireFirebaseUser, requireAdmin, async (_request, response) => {
  try {
    const { db } = await getFirebaseAdmin();
    const snapshot = await db.doc('appConfig/pricing').get();
    const pricing = normalizePricingConfig(snapshot.exists ? snapshot.data() : {});
    response.json({ pricing: publicPricingConfig(pricing) });
  } catch (error) {
    console.error('Could not load admin pricing config.', error);
    response.status(500).json({ error: 'Unable to load pricing configuration.' });
  }
});

app.put('/api/admin/pricing', requireFirebaseUser, requireAdmin, async (request, response) => {
  const rawPricing = request.body?.pricing || request.body || {};
  const announcement = normalizePricingAnnouncement(rawPricing?.announcement ?? rawPricing?.priceAnnouncement ?? rawPricing?.message ?? rawPricing?.notice);
  const defaultPricing = normalizePricingConfig({});
  const requestedPlans = {};
  for (const currency of ['INR', 'USD']) {
    requestedPlans[currency] = {};
    for (const planKey of Object.keys(BILLING_PLANS)) {
      const base = billingPlan(planKey, currency);
      const rawPlan = pricingPlanEntry(rawPricing, planKey, currency);
      const fallback = pricingPlanEntry(defaultPricing, planKey, currency);
      const parsePrice = (value, defaultValue) => {
        const numeric = value === undefined ? defaultValue : Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0
          || Math.abs(numeric * 100 - Math.round(numeric * 100)) > 1e-7
          || (currency === 'INR' && !Number.isInteger(numeric))
          || !Number.isSafeInteger(Math.round(numeric * 100))) {
          return null;
        }
        return Math.round(numeric * 100) / 100;
      };
      const actualPrice = parsePrice(rawPlan?.actualPrice, fallback.actualPrice);
      const currentPrice = parsePrice(rawPlan?.currentPrice, fallback.currentPrice);
      if (actualPrice === null || currentPrice === null) {
        response.status(400).json({
          error: `${currency} ${planKey} prices must be positive valid amounts${currency === 'INR' ? ' in whole rupees' : ' with no more than two decimal places'}.`
        });
        return;
      }
      requestedPlans[currency][planKey] = {
        actualPrice,
        currentPrice,
        amount: Math.round(currentPrice * 100),
        currency,
        period: base.period,
        interval: base.interval
      };
    }
  }

  try {
    const { db } = await getFirebaseAdmin();
    const storedSnapshot = await db.doc('appConfig/pricing').get();
    const previousPricing = normalizePricingConfig(storedSnapshot.exists ? storedSnapshot.data() : {});
    const providerPlanIds = { INR: {}, USD: {} };
    const unavailableCurrencies = [];

    for (const currency of ['INR', 'USD']) {
      try {
        for (const planKey of Object.keys(BILLING_PLANS)) {
          const requested = requestedPlans[currency][planKey];
          const basePlan = billingPlan(planKey, currency);
          const previousPlan = pricingPlanEntry(previousPricing, planKey, currency);
          const previousPlanId = providerPlanId(planKey, currency, previousPricing);
          const envPlanId = providerPlanId(planKey, currency);
          let planId;

          if (previousPlanId && Math.round(previousPlan.currentPrice * 100) === requested.amount) {
            planId = previousPlanId;
          } else if (envPlanId && requested.amount === basePlan.amount) {
            planId = envPlanId;
          } else {
            planId = await createVerifiedProviderPlan(planKey, currency, requested.amount);
          }

          const verified = await razorpayRequest(`/plans/${encodeURIComponent(planId)}`);
          if (!planMatchesRazorpay(verified, requested)) {
            response.status(400).json({
              error: `The configured Razorpay ${currency} ${planKey} plan does not match the requested checkout price.`
            });
            return;
          }
          providerPlanIds[currency][planKey] = planId;
        }
      } catch (error) {
        if (!isUnsupportedRazorpayCurrency(error)) throw error;
        providerPlanIds[currency] = {};
        unavailableCurrencies.push(currency);
        console.warn(`Razorpay does not support ${currency}; saving pricing without enabling ${currency} checkout.`);
      }
    }

    const pricing = normalizePricingConfig({
      monthly: requestedPlans.INR.monthly,
      yearly: requestedPlans.INR.yearly,
      USD: {
        currency: 'USD',
        monthly: requestedPlans.USD.monthly,
        yearly: requestedPlans.USD.yearly
      },
      providerPlanIds,
      announcement
    });
    await db.doc('appConfig/pricing').set(pricing, { merge: true });
    response.json({
      pricing: publicPricingConfig(pricing),
      unavailableCurrencies,
      warnings: unavailableCurrencies.map(currency => (
        `Pricing was saved, but Razorpay does not support ${currency}; ${currency} checkout is disabled.`
      ))
    });
  } catch (error) {
    console.error('Could not create, verify, or save regional pricing.', error);
    const detail = error?.providerDetail || error?.message || 'Razorpay rejected the pricing update.';
    response.status(502).json({
      error: `Could not create or verify Razorpay plans. ${detail} No pricing changes were published.`
    });
  }
});

app.get('/api/billing/config', async (_request, response) => {
  const checkoutEnabled = billingCheckoutConfigured();
  try {
    const pricing = await loadPricingConfigFromStore();
    const supportedCurrencies = checkoutEnabled
      && Object.keys(BILLING_PLANS).every(planKey => providerPlanReferenceExists(planKey, 'INR', pricing))
      ? ['INR']
      : [];
    const currencyPlans = {
      INR: Object.fromEntries(Object.entries(BILLING_PLANS).map(([key, plan]) => {
        const pricedPlan = pricedBillingPlan(key, 'INR', pricing) || plan;
        return [key, {
          id: plan.id,
          label: plan.label,
          amount: pricedPlan.amount,
          currency: plan.currency,
          period: plan.period
        }];
      }))
    };
    response.json({
      checkoutEnabled,
      supportedCurrencies,
      entitlementEnabled: firebaseAdminConfigured(),
      voucherEnabled: firebaseAdminConfigured(),
      keyId: checkoutEnabled ? (process.env.RAZORPAY_KEY_ID || '').trim() || null : null,
      plans: currencyPlans.INR,
      currencyPlans
    });
  } catch (error) {
    console.error('Could not load billing configuration.', error);
    response.status(500).json({ error: 'Could not load paid plan configuration.' });
  }
});

app.post('/api/billing/webhook', async (request, response) => {
    if (!billingCheckoutConfigured()
      || !validWebhookSignature(request.body, request.get('x-razorpay-signature'), process.env.RAZORPAY_WEBHOOK_SECRET)) {
      response.status(400).json({ error: 'Invalid webhook signature.' });
      return;
    }

    let event;
    try {
      event = JSON.parse(request.body.toString('utf8'));
    } catch {
      response.status(400).json({ error: 'Invalid webhook body.' });
      return;
    }

    const eventId = event.id;
    const subscription = event.payload?.subscription?.entity;
    const payment = event.payload?.payment?.entity;
    const subscriptionId = subscription?.id || payment?.subscription_id;
    const lifecycleEvents = new Set([
      'subscription.activated',
      'subscription.charged',
      'subscription.halted',
      'subscription.cancelled',
      'subscription.completed',
      'subscription.expired'
    ]);
    if (typeof eventId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(eventId)
      || typeof subscriptionId !== 'string' || !/^sub_[A-Za-z0-9]+$/.test(subscriptionId)
      || !lifecycleEvents.has(event.event)) {
      response.status(200).json({ received: true });
      return;
    }

    try {
      const { db } = await getFirebaseAdmin();
      const mappedSubscription = await subscriptionDocument(db, subscriptionId).get();
      if (!mappedSubscription.exists) {
        console.warn('Ignoring Razorpay subscription event without a local subscription record.', { eventId, subscriptionId });
        response.status(200).json({ received: true });
        return;
      }
      const mapping = mappedSubscription.data();
      const eventRef = db.collection('billingWebhookEvents').doc(eventId);
      const entitlementRef = userEntitlementDocument(db, mapping.uid);
      const checkoutRef = userCheckoutDocument(db, mapping.uid);
      const eventPaymentId = typeof payment?.id === 'string' && /^pay_[A-Za-z0-9]+$/.test(payment.id)
        ? payment.id
        : null;
      await db.runTransaction(async transaction => {
        const duplicate = await transaction.get(eventRef);
        if (duplicate.exists) return;

        const currentEntitlement = await transaction.get(entitlementRef);
        const currentCheckout = await transaction.get(checkoutRef);
        const validUntil = Number(subscription?.current_end) * 1000
          || Number(currentEntitlement.data()?.validUntil)
          || 0;
        const isPaidThrough = validUntil > Date.now();
        const activated = ['subscription.activated', 'subscription.charged'].includes(event.event);
        const pendingPlanMatches = subscription?.plan_id === mapping.pendingPlanId;
        const currentPlanMatches = subscription?.plan_id === mapping.planId;
        const providerPlanKey = pendingPlanMatches
          ? mapping.pendingPlanKey
          : currentPlanMatches
            ? mapping.planKey
            : planKeyForRazorpayPlanId(subscription?.plan_id);
        const providerCurrency = pendingPlanMatches
          ? mapping.pendingCurrency
          : currentPlanMatches
            ? mapping.currency || 'INR'
            : currencyForRazorpayPlanId(subscription?.plan_id);
        const planChangeApplied = event.event === 'subscription.charged'
          && providerPlanKey
          && (pendingPlanMatches || providerPlanKey !== mapping.planKey || providerCurrency !== (mapping.currency || 'INR'));
        const planChangeCancelled = ['subscription.cancelled', 'subscription.completed', 'subscription.expired'].includes(event.event)
          && !isPaidThrough;
        const billingPlanKey = planChangeApplied ? providerPlanKey : mapping.planKey;
        const billingCurrency = planChangeApplied ? providerCurrency : mapping.currency || providerCurrency || 'INR';
        const scheduledPlan = planChangeApplied || planChangeCancelled ? null : mapping.pendingPlanKey || null;
        const scheduledAt = scheduledPlan ? Number(mapping.scheduledAt) || null : null;
        const entitlement = activated
          ? entitlementFromSubscription(subscription, billingPlanKey)
          : isPaidThrough
            ? {
                planId: 'pro',
                billingPlan: billingPlanKey,
                status: 'active',
                source: 'server-verified',
                validUntil
              }
            : {
                planId: 'free',
                billingPlan: mapping.planKey,
                status: 'inactive',
                source: 'server-verified',
                validUntil: 0
              };
        if (entitlement) {
          entitlement.billingPlan = billingPlanKey;
          entitlement.currency = billingCurrency;
          entitlement.scheduledPlan = scheduledPlan;
          entitlement.scheduledAt = scheduledAt;
          entitlement.subscriptionId = subscriptionId;
          entitlement.cancelAtCycleEnd = event.event === 'subscription.cancelled'
            || currentEntitlement.data()?.cancelAtCycleEnd === true
            || mapping.cancelAtCycleEnd === true;
        }

        transaction.create(eventRef, { event: event.event, subscriptionId, receivedAt: Date.now() });
        if (payment?.status === 'captured'
          && eventPaymentId
          && payment.subscription_id === subscriptionId
          && Number.isSafeInteger(payment.amount) && payment.amount > 0) {
          const paymentCreatedAt = Number(payment.created_at) > 0
            ? Number(payment.created_at) * 1000
            : Date.now();
          transaction.set(db.doc(`billingPayments/${payment.id}`), {
            uid: mapping.uid,
            providerPaymentId: payment.id,
            subscriptionId,
            planKey: billingPlanKey,
            status: 'captured',
            amount: payment.amount,
            currency: typeof payment.currency === 'string' ? payment.currency : billingCurrency,
            paymentMode: payment.method || subscription?.payment_method || 'unknown',
            source: 'razorpay',
            createdAt: paymentCreatedAt
          }, { merge: true });
          transaction.set(db.doc(`billingAccessHistory/${payment.id}`), {
            uid: mapping.uid,
            subscriptionId,
            planKey: billingPlanKey,
            validFrom: paymentCreatedAt,
            validUntil: validUntil || null,
            paymentId: payment.id,
            paymentMode: payment.method || subscription?.payment_method || 'unknown',
            amount: payment.amount,
            currency: typeof payment.currency === 'string' ? payment.currency : billingCurrency,
            status: isPaidThrough ? 'active' : 'paid',
            source: 'razorpay',
            createdAt: paymentCreatedAt
          }, { merge: true });
        }
        transaction.set(subscriptionDocument(db, subscriptionId), {
          status: subscription?.status || event.event.replace('subscription.', ''),
          currentEnd: validUntil,
          ...(planChangeApplied ? {
            planKey: billingPlanKey,
            currency: billingCurrency,
            planId: subscription.plan_id,
            amount: Number.isSafeInteger(mapping.pendingPlanAmount)
              ? mapping.pendingPlanAmount
              : billingPlan(billingPlanKey, billingCurrency)?.amount
          } : {}),
          ...(planChangeApplied || planChangeCancelled ? {
            pendingPlanKey: null,
            pendingPlanId: null,
            pendingPlanAmount: null,
            pendingPlanStatus: null,
            planChangeRequestId: null,
            scheduledAt: null
          } : {}),
          updatedAt: Date.now()
        }, { merge: true });
        const nextEntitlement = {
          ...(entitlement || {
            planId: 'free',
            billingPlan: mapping.planKey,
            status: 'inactive',
            source: 'server-verified',
            validUntil: 0
          }),
          pendingVouchers: schedulePendingVouchers(
            Array.isArray(currentEntitlement.data()?.pendingVouchers)
              ? currentEntitlement.data().pendingVouchers
              : [],
            Number(entitlement?.validUntil) || 0
          )
        };
        transaction.set(entitlementRef, activatePendingVouchers(nextEntitlement) || nextEntitlement);
        if (currentCheckout.data()?.subscriptionId === subscriptionId) {
          if (['subscription.completed', 'subscription.expired'].includes(event.event) && !isPaidThrough) {
            transaction.delete(checkoutRef);
          } else {
            transaction.set(checkoutRef, {
              status: event.event.replace('subscription.', ''),
              currentEnd: validUntil,
              planKey: billingPlanKey,
              currency: billingCurrency,
              scheduledPlan,
              scheduledAt,
              planChangeStatus: scheduledPlan ? mapping.pendingPlanStatus || 'scheduled' : null,
              updatedAt: Date.now()
            }, { merge: true });
          }
        }
      });
      response.json({ received: true });
    } catch (error) {
      console.error('Could not process Razorpay subscription webhook.', error);
      response.status(500).json({ error: 'Webhook processing failed.' });
    }
  }
);

app.get('/api/billing/activity', requireEntitlementConfig, requireFirebaseUser, async (request, response) => {
  try {
    const { db } = await getFirebaseAdmin();
    let activity = [];
    const records = db.records;
    if (records instanceof Map) {
      activity = [...records.entries()]
        .filter(([key]) => key.startsWith(`users/${request.user.uid}/billingActivity/`))
        .map(([key, value]) => ({ id: key.split('/').at(-1), ...value }))
        .sort((a, b) => Number(b.occurredAt) - Number(a.occurredAt))
        .slice(0, 50);
    } else {
      const collection = db.collection(`users/${request.user.uid}/billingActivity`);
      const snapshot = await collection.orderBy?.('occurredAt', 'desc').limit?.(50).get?.();
      activity = snapshot?.docs?.map(document => ({ id: document.id, ...document.data() })) || [];
    }
    response.json({ activity });
  } catch (error) {
    console.error('Could not load billing activity.', error);
    response.status(500).json({ error: 'Could not load your billing history.' });
  }
});

app.get('/api/billing/payments', requireEntitlementConfig, requireFirebaseUser, async (request, response) => {
  try {
    const { db } = await getFirebaseAdmin();
    let payments;
    let refundRequests;
    if (db.records instanceof Map) {
      payments = [...db.records.entries()]
        .filter(([key, value]) => key.startsWith('billingPayments/')
          && key.split('/').length === 2 && value.uid === request.user.uid)
        .map(([key, value]) => ({ id: key.split('/').at(-1), ...value }));
      refundRequests = [...db.records.entries()]
        .filter(([key]) => key.startsWith(`users/${request.user.uid}/billingRefundRequests/`))
        .map(([key, value]) => ({ id: key.split('/').at(-1), ...value }));
    } else {
      const [paymentSnapshot, refundSnapshot] = await Promise.all([
        db.collection('billingPayments').where('uid', '==', request.user.uid).get(),
        db.collection(`users/${request.user.uid}/billingRefundRequests`).get()
      ]);
      payments = (paymentSnapshot.docs || []).map(document => ({ id: document.id, ...document.data() }));
      refundRequests = (refundSnapshot.docs || []).map(document => ({ id: document.id, ...document.data() }));
    }
    const requestsByPayment = new Map(refundRequests.map(item => [item.paymentId || item.id, item]));
    const eligiblePayments = payments
      .filter(payment => payment.status === 'captured'
        && payment.providerPaymentId === payment.id
        && typeof payment.subscriptionId === 'string'
        && /^sub_[A-Za-z0-9]+$/.test(payment.subscriptionId))
      .sort((left, right) => Number(right.createdAt) - Number(left.createdAt))
      .slice(0, 50)
      .map(payment => {
        const refundRequest = requestsByPayment.get(payment.id);
        return {
          paymentId: payment.id,
          planKey: payment.planKey,
          amount: payment.amount,
          currency: payment.currency || 'INR',
          createdAt: payment.createdAt,
          refundRequest: refundRequest ? {
            status: refundRequest.status,
            createdAt: refundRequest.createdAt
          } : null
        };
      });
    response.json({ payments: eligiblePayments });
  } catch (error) {
    console.error('Could not load billing payments.', error);
    response.status(500).json({ error: 'Could not load your payment history.' });
  }
});

app.post('/api/billing/refunds/request', requireEntitlementConfig, requireFirebaseUser, async (request, response) => {
  const paymentId = typeof request.body?.paymentId === 'string' ? request.body.paymentId.trim() : '';
  const reason = typeof request.body?.reason === 'string' ? request.body.reason.trim() : '';
  if (!/^pay_[A-Za-z0-9]+$/.test(paymentId) || reason.length > 500) {
    response.status(400).json({ error: 'A valid payment ID and a reason under 500 characters are required.' });
    return;
  }

  try {
    const { db } = await getFirebaseAdmin();
    const paymentRef = db.doc(`billingPayments/${paymentId}`);
    const refundRequestRef = db.doc(`users/${request.user.uid}/billingRefundRequests/${paymentId}`);
    let existingRequest = false;
    let paymentFound = false;
    await db.runTransaction(async transaction => {
      const [paymentSnapshot, requestSnapshot] = await Promise.all([
        transaction.get(paymentRef),
        transaction.get(refundRequestRef)
      ]);
      const payment = paymentSnapshot.data();
      if (!paymentSnapshot.exists || payment.uid !== request.user.uid
        || payment.providerPaymentId !== paymentId || payment.status !== 'captured'
        || typeof payment.subscriptionId !== 'string' || !/^sub_[A-Za-z0-9]+$/.test(payment.subscriptionId)) {
        return;
      }
      paymentFound = true;
      if (requestSnapshot.exists) {
        existingRequest = true;
        return;
      }
      const now = Date.now();
      transaction.create(refundRequestRef, {
        uid: request.user.uid,
        paymentId,
        subscriptionId: payment.subscriptionId,
        planKey: payment.planKey || null,
        amount: payment.amount,
        currency: payment.currency || 'INR',
        reason,
        status: 'requested',
        createdAt: now,
        updatedAt: now
      });
    });
    if (!paymentFound) {
      response.status(404).json({ error: 'No eligible captured payment was found for this account.' });
      return;
    }
    if (existingRequest) {
      response.status(409).json({ error: 'A refund review has already been requested for this payment.' });
      return;
    }
    await recordBillingActivity(db, request.user.uid, {
      type: 'refund_request',
      status: 'pending',
      title: 'Refund review requested',
      detail: `Review requested for Razorpay payment ${paymentId}.${reason ? ` Reason: ${reason}` : ''}`,
      planKey: null,
      currency: null,
      amount: null
    });
    response.status(201).json({ requested: true, paymentId });
  } catch (error) {
    console.error('Could not submit refund review request.', error);
    response.status(500).json({ error: 'Could not submit the refund request. Please retry or contact support.' });
  }
});

app.get('/api/billing/entitlement', requireEntitlementConfig, requireFirebaseUser, async (request, response) => {
  try {
    const { db } = await getFirebaseAdmin();
    const entitlementRef = userEntitlementDocument(db, request.user.uid);
    const snapshot = await entitlementRef.get();
    let data = snapshot.data() || {};
    if (Array.isArray(data.pendingVouchers) && Number(data.validUntil) <= Date.now()) {
      await db.runTransaction(async transaction => {
        const currentSnapshot = await transaction.get(entitlementRef);
        const current = currentSnapshot.data() || {};
        data = activatePendingVouchers(current) || current;
        if (data !== current) transaction.set(entitlementRef, data);
      });
    }
    if (data.billingPlan !== 'voucher' && publicEntitlement(data).status !== 'active') {
      const checkoutSnapshot = await userCheckoutDocument(db, request.user.uid).get();
      const checkoutSubscriptionId = typeof checkoutSnapshot.data()?.subscriptionId === 'string'
        ? checkoutSnapshot.data().subscriptionId.trim()
        : '';
      let subscriptionId = typeof data.subscriptionId === 'string' && data.subscriptionId
        ? data.subscriptionId
        : checkoutSubscriptionId;
      let mappingSnapshot = subscriptionId
        ? await subscriptionDocument(db, subscriptionId).get()
        : null;

      if (!mappingSnapshot?.exists) {
        const userSubscriptions = await db.collection(subscriptionCollection)
          .where('uid', '==', request.user.uid)
          .get();
        const latestSubscription = (userSubscriptions.docs || [])
          .map(document => ({ id: document.id, ...(document.data() || {}) }))
          .filter(subscription => subscription.uid === request.user.uid)
          .sort((left, right) => Number(right.createdAt) - Number(left.createdAt))[0];
        if (latestSubscription) {
          subscriptionId = latestSubscription.id;
          mappingSnapshot = {
            exists: true,
            data: () => latestSubscription
          };
        }
      }

      const mapping = mappingSnapshot?.data() || {};
      if (mappingSnapshot?.exists
        && mapping.uid === request.user.uid
        && /^sub_[A-Za-z0-9]+$/.test(subscriptionId)
        && Object.hasOwn(BILLING_PLANS, mapping.planKey)
        && isRazorpayPlanId(mapping.planId)) {
        let providerStatus = mapping.status;
        let validUntil = Number(mapping.currentEnd) || 0;
        let paidThrough = ['active', 'cancelled', 'completed'].includes(providerStatus)
          && validUntil > Date.now();
        let providerPlanMatches = true;
        if (!paidThrough) {
          const subscription = await razorpayRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
          providerStatus = subscription.status;
          validUntil = Number(subscription.current_end) * 1000;
          paidThrough = ['active', 'cancelled', 'completed'].includes(providerStatus)
            && Number.isFinite(validUntil)
            && validUntil > Date.now();
          providerPlanMatches = subscription.id === subscriptionId && subscription.plan_id === mapping.planId;
        }
        if (paidThrough && providerPlanMatches) {
          const nextEntitlement = {
            ...data,
            planId: 'pro',
            billingPlan: mapping.planKey,
            currency: mapping.currency || 'INR',
            status: 'active',
            source: 'server-verified',
            validUntil,
            subscriptionId,
            cancelAtCycleEnd: providerStatus !== 'active'
              || data.cancelAtCycleEnd === true
              || mapping.cancelAtCycleEnd === true,
            updatedAt: Date.now()
          };
          await db.runTransaction(async transaction => {
            transaction.set(entitlementRef, nextEntitlement);
            transaction.set(subscriptionDocument(db, subscriptionId), {
              status: providerStatus,
              currentEnd: validUntil,
              updatedAt: Date.now()
            }, { merge: true });
            transaction.set(userCheckoutDocument(db, request.user.uid), {
              subscriptionId,
              planKey: mapping.planKey,
              currency: mapping.currency || 'INR',
              status: providerStatus,
              currentEnd: validUntil,
              updatedAt: Date.now()
            }, { merge: true });
          });
          data = nextEntitlement;
        }
      }
    }
    const entitlement = publicEntitlement(data);
    if (!entitlement.subscriptionId && entitlement.billingPlan !== 'voucher') {
      const checkoutSnapshot = await userCheckoutDocument(db, request.user.uid).get();
      const checkoutSubscriptionId = typeof checkoutSnapshot.data()?.subscriptionId === 'string'
        ? checkoutSnapshot.data().subscriptionId.trim()
        : '';
      if (checkoutSubscriptionId) entitlement.subscriptionId = checkoutSubscriptionId;
    }
    response.json({ entitlement });
  } catch (error) {
    console.error('Could not load billing entitlement.', error);
    response.status(error.status >= 500 ? 502 : 500).json({
      error: error.status >= 500
        ? 'Could not confirm your subscription with Razorpay. Please retry shortly.'
        : 'Could not load your plan status.'
    });
  }
});

app.post('/api/billing/vouchers/redeem', requireEntitlementConfig, requireFirebaseUser, async (request, response) => {
  const code = typeof request.body?.code === 'string' ? request.body.code.trim().toUpperCase() : '';
  if (!/^[A-Z0-9][A-Z0-9-]{5,39}$/.test(code)) {
    response.status(400).json({ error: 'Enter a valid voucher code.' });
    return;
  }
  const vouchers = configuredVouchers();
  try {
    const { db } = await getFirebaseAdmin();
    let voucher = (vouchers || []).find(item => item.code === code);
    if (!voucher) {
      const generatedSnapshot = await db.doc(`adminVouchers/${voucherDocumentId(code)}`).get();
      if (generatedSnapshot.exists && generatedSnapshot.data()?.code === code) {
        const generated = generatedSnapshot.data();
        voucher = {
          code,
          durationDays: Number(generated.durationDays),
          maxRedemptions: Number(generated.maxRedemptions),
          assignedUid: generated.assignedUid || '',
          expiresAt: generated.createdAt ? Number(generated.createdAt) + 24 * 60 * 60 * 1000 : (generated.expiresAt || null)
        };
      }
    }
    if (!voucher || !Number.isInteger(voucher.durationDays) || voucher.durationDays < 1 || voucher.durationDays > 3650
      || !Number.isInteger(voucher.maxRedemptions) || voucher.maxRedemptions < 1
      || (voucher.expiresAt && Number(voucher.expiresAt) <= Date.now())) {
      response.status(404).json({ error: 'That voucher code is invalid or unavailable.' });
      return;
    }
    if (voucher.assignedUid && voucher.assignedUid !== request.user.uid) {
      response.status(403).json({ error: 'This voucher is not valid for your account.' });
      return;
    }
    const voucherId = voucherDocumentId(code);
    const voucherRef = db.doc(`billingVouchers/${voucherId}`);
    const adminVoucherRef = db.doc(`adminVouchers/${voucherId}`);
    const userVoucherRef = db.doc(`users/${request.user.uid}/vouchers/${voucherId}`);
    const entitlementRef = userEntitlementDocument(db, request.user.uid);
    const now = Date.now();
    let queued = false;
    await db.runTransaction(async transaction => {
      const [voucherSnapshot, adminVoucherSnapshot, userVoucherSnapshot, entitlementSnapshot] = await Promise.all([
        transaction.get(voucherRef),
        transaction.get(adminVoucherRef),
        transaction.get(userVoucherRef),
        transaction.get(entitlementRef)
      ]);
      if (userVoucherSnapshot.exists) {
        const error = new Error('This account has already redeemed that voucher.');
        error.status = 409;
        throw error;
      }
      const currentEntitlement = entitlementSnapshot.data() || {};
      const currentValidUntil = Number(currentEntitlement.validUntil) || 0;
      const hasActiveAccess = currentValidUntil > now;
      queued = hasActiveAccess;
      const durationMs = voucher.durationDays * 24 * 60 * 60 * 1000;
      const redeemedCount = Number(voucherSnapshot.data()?.redeemedCount) || 0;
      if (redeemedCount >= voucher.maxRedemptions) {
        const error = new Error('That voucher has reached its redemption limit.');
        error.status = 409;
        throw error;
      }
      const pendingVouchers = Array.isArray(currentEntitlement.pendingVouchers)
        ? currentEntitlement.pendingVouchers
        : [];
      const newVoucher = { voucherId, durationDays: voucher.durationDays };
      const nextPendingVouchers = hasActiveAccess
        ? schedulePendingVouchers([...pendingVouchers, newVoucher], currentValidUntil)
        : [];
      const activationQueue = hasActiveAccess ? nextPendingVouchers : [...pendingVouchers, newVoucher];
      const priorVoucherDuration = pendingVouchers.reduce(
        (total, item) => total + item.durationDays * 24 * 60 * 60 * 1000,
        0
      );
      const validFrom = hasActiveAccess
        ? currentValidUntil + priorVoucherDuration
        : now + priorVoucherDuration;
      const validUntil = validFrom + durationMs;
      transaction.set(voucherRef, {
        redeemedCount: redeemedCount + 1,
        updatedAt: now
      }, { merge: true });
      if (adminVoucherSnapshot.exists) {
        transaction.set(adminVoucherRef, {
          redeemedCount: redeemedCount + 1,
          redeemedAt: now,
          redeemedByUid: request.user.uid,
          updatedAt: now
        }, { merge: true });
      }
      transaction.create(userVoucherRef, { redeemedAt: now });
      transaction.set(db.doc(`billingAccessHistory/voucher_${voucherId}_${voucherDocumentId(request.user.uid)}`), {
        uid: request.user.uid,
        subscriptionId: null,
        planKey: 'voucher',
        validFrom,
        validUntil,
        paymentId: null,
        paymentMode: 'voucher',
        amount: 0,
        currency: null,
        status: queued ? 'scheduled' : 'active',
        source: 'voucher',
        voucherId,
        createdAt: now
      });
      if (hasActiveAccess) {
        transaction.set(entitlementRef, {
          pendingVouchers: nextPendingVouchers,
          updatedAt: now
        }, { merge: true });
      } else {
        transaction.set(entitlementRef, {
          planId: 'pro',
          billingPlan: 'voucher',
          status: 'active',
          source: 'server-verified',
          validUntil,
          subscriptionId: null,
          cancelAtCycleEnd: false,
          voucherId,
          pendingVouchers: [],
          updatedAt: now
        });
      }
    });
    const updatedEntitlement = (await entitlementRef.get()).data();
    response.json({
      entitlement: publicEntitlement(updatedEntitlement),
      queued
    });
    await recordBillingActivity(db, request.user.uid, {
      type: 'voucher', status: 'success', title: 'Pro voucher redeemed',
      detail: `Voucher redeemed for ${voucher.durationDays} days.`, planKey: 'voucher'
    });
  } catch (error) {
    if (error.status === 409) {
      response.status(409).json({ error: error.message });
      return;
    }
    console.error('Could not redeem Pro voucher.', error);
    response.status(500).json({ error: 'Could not redeem this voucher. Please try again.' });
  }
});

app.get('/api/admin/dashboard', requireFirebaseUser, requireAdmin, async (request, response) => {
  try {
    const { auth, db } = await getFirebaseAdmin();
    const now = Date.now();
    const monthStart = new Date(now);
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const timestampOf = value => {
      const timestamp = typeof value === 'number' ? value : Date.parse(value);
      return Number.isFinite(timestamp) ? timestamp : 0;
    };
    const users = [];
    const seen = new Set();
    if (typeof auth.listUsers === 'function') {
      let pageToken;
      do {
        const page = await auth.listUsers(1000, pageToken);
        for (const record of page.users || []) {
          users.push({ uid: record.uid, email: record.email || '', name: record.displayName || '', photoURL: record.photoURL || '', createdAt: record.metadata?.creationTime || null });
          seen.add(record.uid);
        }
        pageToken = page.pageToken;
      } while (pageToken);
    }
    if (typeof db.collection === 'function' && typeof db.collection('users').get === 'function') {
      const usersSnapshot = await db.collection('users').get();
      for (const document of usersSnapshot.docs || []) {
        const uid = document.id;
        if (!seen.has(uid)) {
          users.push({ uid, email: document.data()?.email || '', name: document.data()?.name || '', createdAt: document.data()?.createdAt || null });
          seen.add(uid);
        }
      }
    }
    let paymentDocuments = [];
    if (typeof db.collection === 'function' && typeof db.collection('billingPayments').get === 'function') {
      const paymentsSnapshot = await db.collection('billingPayments').get();
      paymentDocuments = (paymentsSnapshot.docs || []).map(document => ({ id: document.id, ...(document.data() || {}) }));
    }
    const enriched = await Promise.all(users.map(async user => {
      const snapshot = await db.doc(`users/${user.uid}/billing/entitlement`).get();
      const entitlement = snapshot.exists ? snapshot.data() : null;
      const active = entitlement?.planId === 'pro' && Number(entitlement?.validUntil) > now && entitlement?.status === 'active';
      const payments = paymentDocuments.filter(payment => payment.uid === user.uid && ['captured', 'success'].includes(String(payment.status)));
      const paidAmountByCurrency = payments.reduce((amounts, payment) => {
        const currency = payment.currency || 'INR';
        amounts[currency] = (amounts[currency] || 0) + (Number(payment.amount) || 0);
        return amounts;
      }, {});
      return {
        ...user,
        isPro: active,
        plan: active ? entitlement.billingPlan || 'pro' : 'free',
        activationSource: entitlement?.source || null,
        validUntil: entitlement?.validUntil || null,
        paidAmount: paidAmountByCurrency.INR || 0,
        paidAmountByCurrency,
        paymentCount: payments.length
      };
    }));
    const proCount = enriched.filter(user => user.isPro).length;
    const paidPayments = paymentDocuments
      .filter(payment => ['captured', 'success'].includes(String(payment.status)))
      .sort((a, b) => timestampOf(b.createdAt) - timestampOf(a.createdAt));
    const userByUid = new Map(enriched.map(user => [user.uid, user]));
    const activePro = enriched.filter(user => user.isPro);
    const earningsByCurrency = paidPayments.reduce((totals, payment) => {
      const currency = payment.currency || 'INR';
      totals[currency] = (totals[currency] || 0) + (Number(payment.amount) || 0);
      return totals;
    }, {});
    const monthPayments = paidPayments.filter(payment => timestampOf(payment.createdAt) >= monthStart.getTime());
    const earningsThisMonthByCurrency = monthPayments.reduce((totals, payment) => {
      const currency = payment.currency || 'INR';
      totals[currency] = (totals[currency] || 0) + (Number(payment.amount) || 0);
      return totals;
    }, {});
    const earningsThisMonth = paidPayments.reduce((total, payment) => (
      timestampOf(payment.createdAt) >= monthStart.getTime()
        ? total + (Number(payment.amount) || 0)
        : total
    ), 0);
    const recentPayments = paidPayments.slice(0, 8).map(payment => {
      const user = userByUid.get(payment.uid);
      return {
        id: payment.id,
        uid: payment.uid || '',
        name: user?.name || '',
        email: user?.email || '',
        plan: payment.planKey || '',
        status: payment.status,
        amount: Number(payment.amount) || 0,
        currency: payment.currency || 'INR',
        createdAt: payment.createdAt || null
      };
    });
    const voucherSnapshot = typeof db.collection === 'function' && typeof db.collection('adminVouchers').get === 'function'
      ? await db.collection('adminVouchers').get() : { docs: [] };
    const vouchers = (voucherSnapshot.docs || []).map(document => {
      const voucher = { id: document.id, ...(document.data() || {}) };
      if (voucher.createdAt) voucher.expiresAt = Number(voucher.createdAt) + 24 * 60 * 60 * 1000;
      else if (!voucher.expiresAt) voucher.expiresAt = null;
      return voucher;
    });
    const totals = {
      users: enriched.length,
      pro: proCount,
      regular: enriched.length - proCount,
      newUsers30Days: enriched.filter(user => {
        const createdAt = timestampOf(user.createdAt);
        return createdAt > 0 && createdAt >= now - 30 * 24 * 60 * 60 * 1000;
      }).length,
      conversionRate: enriched.length ? Math.round((proCount / enriched.length) * 1000) / 10 : 0,
      monthlyPro: activePro.filter(user => user.plan === 'monthly').length,
      yearlyPro: activePro.filter(user => user.plan === 'yearly').length,
      earnings: earningsByCurrency.INR || 0,
      earningsThisMonth: earningsThisMonthByCurrency.INR || 0,
      earningsByCurrency,
      earningsThisMonthByCurrency,
      paymentsThisMonth: monthPayments.length,
      paymentCount: paidPayments.length
    };
    response.json({
      users: enriched.sort((a, b) => timestampOf(b.createdAt) - timestampOf(a.createdAt)),
      totals,
      recentPayments,
      vouchers,
      adminEmail: request.user.email || ''
    });
  } catch (error) {
    console.error('Admin dashboard failed.', error);
    response.status(500).json({ error: 'Unable to load admin data.' });
  }
});

app.get('/api/admin/users/:uid', requireFirebaseUser, requireAdmin, async (request, response) => {
  try {
    const { auth, db } = await getFirebaseAdmin();
    const uid = request.params.uid;
    let authRecord = null;
    try { authRecord = await auth.getUser(uid); } catch {}
    const [entitlementSnapshot, paymentsSnapshot, activitySnapshot, accessHistorySnapshot] = await Promise.all([
      db.doc(`users/${uid}/billing/entitlement`).get(),
      typeof db.collection === 'function' ? db.collection('billingPayments').get().catch(() => ({ docs: [] })) : Promise.resolve({ docs: [] }),
      typeof db.collection === 'function' ? db.collection(`users/${uid}/billingActivity`).get().catch(() => ({ docs: [] })) : Promise.resolve({ docs: [] }),
      typeof db.collection === 'function' ? db.collection('billingAccessHistory').get().catch(() => ({ docs: [] })) : Promise.resolve({ docs: [] })
    ]);
    const entitlement = entitlementSnapshot.exists ? entitlementSnapshot.data() : null;
    const payments = (paymentsSnapshot.docs || []).map(document => ({ id: document.id, ...(document.data() || {}) })).filter(payment => payment.uid === uid);
    const activity = (activitySnapshot.docs || []).map(document => ({ id: document.id, ...(document.data() || {}) })).sort((a, b) => Number(b.occurredAt || b.createdAt || 0) - Number(a.occurredAt || a.createdAt || 0));
    const accessHistory = (accessHistorySnapshot.docs || [])
      .map(document => ({ id: document.id, ...(document.data() || {}) }))
      .filter(record => record.uid === uid)
      .sort((left, right) => Number(right.createdAt) - Number(left.createdAt));
    let voucher = null;
    if (entitlement?.voucherId) {
      const voucherSnapshot = await db.doc(`adminVouchers/${entitlement.voucherId}`).get();
      if (voucherSnapshot.exists) voucher = voucherSnapshot.data();
      if (!voucher && typeof db.collection === 'function') {
        const vouchers = await db.collection('adminVouchers').get();
        voucher = (vouchers.docs || []).map(document => document.data()).find(item => item.code && voucherDocumentId(item.code) === entitlement.voucherId) || null;
      }
    }
    const paidAmountByCurrency = payments
      .filter(payment => ['captured', 'success'].includes(String(payment.status)))
      .reduce((amounts, payment) => {
        const currency = payment.currency || 'INR';
        amounts[currency] = (amounts[currency] || 0) + (Number(payment.amount) || 0);
        return amounts;
      }, {});
    const paidAmount = paidAmountByCurrency.INR || 0;
    response.json({
      uid, email: authRecord?.email || '', name: authRecord?.displayName || '', photoURL: authRecord?.photoURL || '', createdAt: authRecord?.metadata?.creationTime || null,
      entitlement, voucher, payments, accessHistory, activity, paidAmount, paidAmountByCurrency
    });
  } catch (error) {
    console.error('Admin user detail failed.', error);
    response.status(500).json({ error: 'Unable to load user details.' });
  }
});

app.post('/api/admin/users/:uid/pro', requireFirebaseUser, requireAdmin, async (request, response) => {
  const { uid } = request.params;
  const plan = request.body?.plan === 'yearly' ? 'yearly' : 'monthly';
  const durationDays = plan === 'yearly' ? 365 : 30;
  const amountInRupees = Number(request.body?.amount);
  const amount = Number.isFinite(amountInRupees) && amountInRupees > 0 ? Math.round(amountInRupees * 100) : 0;
  const transactionId = typeof request.body?.transactionId === 'string' ? request.body.transactionId.trim() : '';
  if (amount > 0 && !transactionId) {
    response.status(400).json({ error: 'Enter a transaction ID for a paid Pro activation.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const grantedAt = Date.now();
    const validUntil = grantedAt + durationDays * 86400000;
    await db.doc(`users/${uid}/billing/entitlement`).set({
      planId: 'pro', billingPlan: plan, status: 'active', source: 'admin', validUntil,
      subscriptionId: null, cancelAtCycleEnd: false, updatedAt: grantedAt
    }, { merge: true });
    const paid = amount > 0;
    const paymentId = paid ? transactionId : `FREE-${randomUUID().slice(0, 8).toUpperCase()}`;
    await db.doc(`billingPayments/${paymentId}`).set({
      uid, providerPaymentId: paymentId, planKey: plan, status: paid ? 'success' : 'free', amount,
      currency: 'INR', paymentMode: paid ? 'manual' : 'admin',
      source: 'admin', createdAt: grantedAt, grantedBy: request.user.uid
    }, { merge: true });
    await db.doc(`billingAccessHistory/admin_${randomUUID()}`).set({
      uid,
      subscriptionId: null,
      planKey: plan,
      validFrom: grantedAt,
      validUntil,
      paymentId: paid ? paymentId : null,
      paymentMode: paid ? 'manual' : 'admin',
      amount,
      currency: 'INR',
      status: 'active',
      source: 'admin',
      createdAt: grantedAt,
      grantedBy: request.user.uid
    });
    await db.doc(`users/${uid}/billingActivity/${randomUUID()}`).set({
      type: 'admin_pro_granted', plan, amount, status: paid ? 'success' : 'free', createdAt: grantedAt, occurredAt: grantedAt,
      transactionId: paymentId, title: paid ? 'Paid Pro access granted by admin' : 'Free Pro access granted by admin',
      detail: paid ? `${paymentId} · ₹${(amount / 100).toLocaleString('en-IN')}` : 'Free activation · no payment collected',
      message: `Pro access granted by administrator for ${plan === 'yearly' ? '1 year' : '1 month'}.`
    });
    response.json({ uid, validUntil, plan, amount, transactionId: paymentId });
  } catch (error) {
    response.status(500).json({ error: 'Unable to grant Pro access.' });
  }
});

app.post('/api/admin/users/:uid/cancel-pro', requireFirebaseUser, requireAdmin, async (request, response) => {
  const reason = typeof request.body?.reason === 'string' ? request.body.reason.trim() : '';
  if (!reason) {
    response.status(400).json({ error: 'Enter a reason for cancelling Pro access.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const uid = request.params.uid;
    const entitlementRef = db.doc(`users/${uid}/billing/entitlement`);
    const entitlementSnapshot = await entitlementRef.get();
    const entitlement = entitlementSnapshot.data() || {};
    await entitlementRef.set({
      planId: 'free', billingPlan: 'free', status: 'inactive', source: 'admin', validUntil: null,
      subscriptionId: null, cancelAtCycleEnd: false, updatedAt: Date.now()
    }, { merge: true });
    const cancelledAt = Date.now();
    await db.doc(`users/${uid}/billingActivity/${randomUUID()}`).set({
      type: 'pro_cancelled', status: 'cancelled', title: 'Pro access cancelled by admin',
      detail: reason, reason, planKey: entitlement.billingPlan || 'pro',
      previousPlan: entitlement.billingPlan || 'pro', previousSource: entitlement.source || null,
      previousValidUntil: entitlement.validUntil || null, actorType: 'admin', actorUid: request.user.uid,
      cancelledBy: request.user.uid, cancelledByEmail: request.user.email || null,
      createdAt: cancelledAt, occurredAt: cancelledAt
    });
    response.json({ uid, isPro: false, reason, cancelledAt });
  } catch (error) {
    response.status(500).json({ error: 'Unable to cancel Pro access.' });
  }
});

app.post('/api/admin/vouchers', requireFirebaseUser, requireAdmin, async (request, response) => {
  const plan = request.body?.plan === 'yearly' ? 'yearly' : 'monthly';
  const assignedUid = typeof request.body?.uid === 'string' ? request.body.uid.trim() : '';
  const durationDays = plan === 'yearly' ? 365 : 30;
  const code = `${plan === 'yearly' ? 'YEAR' : 'MONTH'}-${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
  try {
    const { db } = await getFirebaseAdmin();
    const id = voucherDocumentId(code);
    const createdAt = Date.now();
    await db.doc(`adminVouchers/${id}`).set({ code, plan, durationDays, maxRedemptions: 1, assignedUid, redeemedCount: 0, createdAt, expiresAt: createdAt + 24 * 60 * 60 * 1000, createdBy: request.user.uid });
    response.status(201).json({ id, code, plan, durationDays, assignedUid });
  } catch (error) {
    response.status(500).json({ error: 'Unable to generate voucher.' });
  }
});

app.delete('/api/admin/vouchers/:id', requireFirebaseUser, requireAdmin, async (request, response) => {
  try {
    const { db } = await getFirebaseAdmin();
    const ref = db.doc(`adminVouchers/${request.params.id}`);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      response.status(404).json({ error: 'Voucher not found.' });
      return;
    }
    const voucher = snapshot.data();
    if (Number(voucher.redeemedCount) > 0) {
      response.status(409).json({ error: 'Completed vouchers cannot be deleted.' });
      return;
    }
    if (Date.now() - Number(voucher.createdAt || 0) < 2 * 60 * 60 * 1000) {
      response.status(409).json({ error: 'A voucher can be deleted only after 2 hours.' });
      return;
    }
    await db.runTransaction(async transaction => {
      transaction.delete(ref);
    });
    response.json({ deleted: true });
  } catch (error) {
    console.error('Admin voucher deletion failed.', error);
    response.status(500).json({ error: 'Unable to delete voucher.' });
  }
});

app.post('/api/billing/subscriptions', requireBillingConfig, requireFirebaseUser, async (request, response) => {
  const planKey = request.body?.planKey;
  const currency = request.body?.currency || 'INR';
  const expectedAmount = request.body?.expectedAmount;
  if (currency !== 'INR') {
    response.status(400).json({ error: 'Only INR subscriptions are supported.' });
    return;
  }
  const basePlan = billingPlan(planKey, currency);
  if (!basePlan) {
    response.status(400).json({ error: 'Choose a valid monthly or yearly plan.' });
    return;
  }
  if (!Number.isSafeInteger(expectedAmount) || expectedAmount <= 0) {
    response.status(400).json({ error: 'Refresh the Plans page to confirm the current price before checkout.' });
    return;
  }

  try {
    const { db } = await getFirebaseAdmin();
    const pricingSnapshot = await db.doc('appConfig/pricing').get();
    const pricing = normalizePricingConfig(pricingSnapshot.exists ? pricingSnapshot.data() : {});
    if (!providerPlanReferenceExists(planKey, currency, pricing)) {
      response.status(503).json({ error: `Razorpay ${currency} subscriptions are not configured on this server yet.` });
      return;
    }
    const plan = pricedBillingPlan(planKey, currency, pricing);
    if (expectedAmount !== plan.amount) {
      response.status(409).json({ error: 'The price changed since this page loaded. Refresh the Plans page and review the current price before checkout.' });
      return;
    }
    const providerPlan = await verifiedProviderPlan(planKey, currency, pricing);
    const checkoutRef = userCheckoutDocument(db, request.user.uid);
    const requestId = randomUUID();
    const checkout = await db.runTransaction(async transaction => {
      const [entitlementSnapshot, checkoutSnapshot] = await Promise.all([
        transaction.get(userEntitlementDocument(db, request.user.uid)),
        transaction.get(checkoutRef)
      ]);
      if (publicEntitlement(entitlementSnapshot.data()).status === 'active') {
        const error = new Error('This account already has active Pro access.');
        error.status = 409;
        throw error;
      }
      if (checkoutSnapshot.exists) {
        const current = checkoutSnapshot.data();
        const subscriptionEnded = current.status === 'expired'
          || current.status === 'completed'
          || (current.status === 'cancelled' && !Number(current.currentEnd))
          || (Number(current.currentEnd) > 0 && Number(current.currentEnd) <= Date.now());
        if (subscriptionEnded) {
          transaction.set(checkoutRef, {
            requestId,
            planKey,
            currency,
            status: 'creating',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            subscriptionId: null,
            currentEnd: 0
          });
          return { requestId, reused: false };
        }
        if (current.planKey === planKey && current.subscriptionId) {
          if ((current.currency || 'INR') === currency) return { subscriptionId: current.subscriptionId, reused: true };
        }
        if (current.status === 'creating' && Date.now() - Number(current.createdAt) > 5 * 60 * 1000) {
          transaction.set(checkoutRef, {
            requestId,
            planKey,
            currency,
            status: 'creating',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            subscriptionId: null
          });
          return { requestId, reused: false };
        }
        const error = new Error('This account already has a pending subscription checkout. Finish or wait for it to expire before choosing another plan.');
        error.status = 409;
        throw error;
      }
      transaction.create(checkoutRef, {
        requestId,
        planKey,
        currency,
        status: 'creating',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      return { requestId, reused: false };
    });
    if (checkout.reused) {
      const reusedProviderSubscription = await razorpayRequest(
        `/subscriptions/${encodeURIComponent(checkout.subscriptionId)}`
      );
      if (reusedProviderSubscription.status !== 'created') {
        if (['cancelled', 'completed', 'expired'].includes(reusedProviderSubscription.status)) {
          await db.runTransaction(async transaction => {
            const currentCheckout = await transaction.get(checkoutRef);
            if (!currentCheckout.exists
              || currentCheckout.data()?.subscriptionId !== checkout.subscriptionId) {
              const error = new Error('The saved checkout changed. Refresh the Plans page and retry.');
              error.status = 409;
              throw error;
            }
            transaction.set(checkoutRef, {
              requestId,
              planKey,
              currency,
              status: 'creating',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              subscriptionId: null,
              currentEnd: 0
            });
          });
        } else {
          const error = new Error(
            `The existing Razorpay subscription is ${reusedProviderSubscription.status || 'not ready'} and cannot be checked out again.`
          );
          error.status = 409;
          throw error;
        }
      } else if (reusedProviderSubscription.plan_id !== providerPlan.id) {
        const error = new Error('The saved subscription does not match the current plan. Refresh the Plans page and retry.');
        error.status = 409;
        throw error;
      } else {
        const reusedSubscription = await subscriptionDocument(db, checkout.subscriptionId).get();
        const reusedRecord = reusedSubscription.data() || {};
        const reusedAmount = Number(reusedRecord.amount);
        response.json({
          subscriptionId: checkout.subscriptionId,
          keyId: process.env.RAZORPAY_KEY_ID,
          plan: {
            ...plan,
            amount: Number.isSafeInteger(reusedAmount) && reusedAmount > 0 ? reusedAmount : plan.amount
          },
          reused: true
        });
        return;
      }
    }

    const created = await razorpayRequest('/subscriptions', {
      method: 'POST',
      body: {
        plan_id: providerPlan.id,
        total_count: plan.totalCount,
        quantity: 1,
        customer_notify: 1,
        notes: { plan_key: planKey, currency }
      }
    });
    await db.runTransaction(async transaction => {
      transaction.create(subscriptionDocument(db, created.id), {
        uid: request.user.uid,
        planKey,
        currency,
        planId: providerPlan.id,
        amount: plan.amount,
        status: created.status || 'created',
        currentEnd: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      transaction.set(checkoutRef, {
        subscriptionId: created.id,
        planId: providerPlan.id,
        amount: plan.amount,
        status: created.status || 'created',
        updatedAt: Date.now()
      }, { merge: true });
    });
    await recordBillingActivity(db, request.user.uid, {
      type: 'subscription', status: 'pending', title: `${plan.label} checkout started`,
      detail: 'Razorpay subscription checkout was created.', planKey,
      currency, providerSubscriptionId: created.id,
      amount: plan.amount
    });
    response.status(201).json({
      subscriptionId: created.id,
      keyId: process.env.RAZORPAY_KEY_ID,
      plan
    });
  } catch (error) {
    console.error('Could not create Razorpay subscription.', error);
    const razorpayAuthRejected = error.status === 401;
    const status = razorpayAuthRejected ? 503 : error.status === 409 ? 409 : error.status === 400 ? 400 : error.status === 503 ? 503 : 502;
    const message = razorpayAuthRejected
      ? 'Razorpay rejected the API credentials. Verify that RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are a matching Test Mode pair in .env, then restart the local server.'
      : error.status === 409
        ? error.message
        : error.providerDetail
          ? `Razorpay rejected the configured ${currency} ${planKey} subscription: ${error.providerDetail}`
          : error.status === 400
            ? 'The configured payment plan could not be accepted.'
            : error.status === 503 && error.message
              ? error.message
              : 'Could not start checkout. Please retry or contact support.';
    response.status(status).json({ error: message });
  }
});

app.post('/api/billing/verify', requireBillingConfig, requireFirebaseUser, async (request, response) => {
  const { razorpayPaymentId, razorpaySubscriptionId, razorpaySignature } = request.body || {};
  if (typeof razorpayPaymentId !== 'string' || !/^pay_[A-Za-z0-9]+$/.test(razorpayPaymentId)
    || typeof razorpaySubscriptionId !== 'string' || !/^sub_[A-Za-z0-9]+$/.test(razorpaySubscriptionId)
    || typeof razorpaySignature !== 'string' || !/^[a-f0-9]{64}$/i.test(razorpaySignature)) {
    response.status(400).json({ error: 'Payment verification details are incomplete.' });
    return;
  }

  try {
    const { db } = await getFirebaseAdmin();
    const mappingRef = subscriptionDocument(db, razorpaySubscriptionId);
    const mappingSnapshot = await mappingRef.get();
    if (!mappingSnapshot.exists || mappingSnapshot.data().uid !== request.user.uid) {
      response.status(403).json({ error: 'This payment does not belong to the signed-in account.' });
      return;
    }

    const message = `${razorpaySubscriptionId}|${razorpayPaymentId}`;
    if (!validRazorpaySignature(message, razorpaySignature, process.env.RAZORPAY_KEY_SECRET)) {
      response.status(400).json({ error: 'Payment signature verification failed.' });
      return;
    }

    const mapping = mappingSnapshot.data();
    const currency = mapping.currency || 'INR';
    const basePlan = billingPlan(mapping.planKey, currency);
    const storedAmount = Number(mapping.amount);
    const expectedAmount = Number.isSafeInteger(storedAmount) && storedAmount > 0
      ? storedAmount
      : basePlan?.amount;
    if (!basePlan || !expectedAmount || typeof mapping.planId !== 'string') {
      response.status(400).json({ error: 'The subscription currency could not be verified against its server plan.' });
      return;
    }
    const expectedPlan = { ...basePlan, amount: expectedAmount };
    const [subscription, payment, providerPlan] = await Promise.all([
      razorpayRequest(`/subscriptions/${encodeURIComponent(razorpaySubscriptionId)}`),
      razorpayRequest(`/payments/${encodeURIComponent(razorpayPaymentId)}`),
      razorpayRequest(`/plans/${encodeURIComponent(mapping.planId)}`)
    ]);
    if (subscription.plan_id !== mapping.planId
      || !planMatchesRazorpay(providerPlan, expectedPlan)
      || payment.subscription_id !== razorpaySubscriptionId
      || payment.amount !== expectedAmount
      || payment.currency !== currency
      || !['captured', 'authorized'].includes(payment.status)) {
      response.status(400).json({ error: 'The payment is not verified as belonging to this plan and currency.' });
      return;
    }

    const entitlement = entitlementFromSubscription(subscription, mapping.planKey);
    if (payment.status === 'captured' && entitlement?.status === 'active') {
      entitlement.currency = currency;
      await db.runTransaction(async transaction => {
        transaction.set(mappingRef, {
          status: subscription.status,
          currentEnd: entitlement.validUntil,
          updatedAt: Date.now()
        }, { merge: true });
        transaction.set(userCheckoutDocument(db, request.user.uid), {
          subscriptionId: razorpaySubscriptionId,
          status: subscription.status,
          currentEnd: entitlement.validUntil,
          updatedAt: Date.now()
        }, { merge: true });
        transaction.set(userEntitlementDocument(db, request.user.uid), {
          ...entitlement,
          currency,
          subscriptionId: razorpaySubscriptionId,
          cancelAtCycleEnd: false
        });
        transaction.set(db.doc(`billingAccessHistory/${razorpayPaymentId}`), {
          uid: request.user.uid,
          subscriptionId: razorpaySubscriptionId,
          planKey: mapping.planKey,
          validFrom: Number(payment.created_at) > 0 ? Number(payment.created_at) * 1000 : Date.now(),
          validUntil: entitlement.validUntil,
          paymentId: razorpayPaymentId,
          paymentMode: payment.method || subscription.payment_method || 'unknown',
          amount: expectedAmount,
          currency,
          status: 'active',
          source: 'razorpay',
          createdAt: Number(payment.created_at) > 0 ? Number(payment.created_at) * 1000 : Date.now()
        }, { merge: true });
      });
      await db.doc(`billingPayments/${razorpayPaymentId}`).set({
        uid: request.user.uid, providerPaymentId: razorpayPaymentId, subscriptionId: razorpaySubscriptionId,
        planKey: mapping.planKey, status: 'captured', amount: expectedAmount,
        currency, paymentMode: payment.method || subscription.payment_method || 'unknown',
        createdAt: Number(payment.created_at) > 0 ? Number(payment.created_at) * 1000 : Date.now()
      }, { merge: true });
      await recordBillingActivity(db, request.user.uid, {
        type: 'payment', status: 'success', title: 'Subscription payment verified',
        detail: `${mapping.planKey === 'yearly' ? 'Yearly' : 'Monthly'} Pro access is active.`,
        planKey: mapping.planKey, providerSubscriptionId: razorpaySubscriptionId,
        currency, amount: expectedAmount
      });
      response.json({ verified: true, entitlement });
      return;
    }
    response.json({
      verified: true,
      pending: true,
      message: 'Payment was verified. Pro access will become available after Razorpay confirms subscription activation.'
    });
  } catch (error) {
    console.error('Could not verify Razorpay checkout.', error);
    response.status(502).json({ error: 'Could not verify payment status. Your payment will be reconciled by the Razorpay webhook.' });
  }
});

app.post('/api/billing/change-plan', requireBillingConfig, requireFirebaseUser, async (request, response) => {
  if (request.body?.planKey !== 'yearly') {
    response.status(400).json({ error: 'Choose the yearly plan to schedule a plan switch.' });
    return;
  }

  try {
    const { db } = await getFirebaseAdmin();
    const entitlementRef = userEntitlementDocument(db, request.user.uid);
    const entitlementSnapshot = await entitlementRef.get();
    const entitlement = publicEntitlement(entitlementSnapshot.data());
    if (entitlement.status !== 'active' || entitlement.billingPlan !== 'monthly' || !entitlement.subscriptionId) {
      response.status(409).json({ error: 'Only an active monthly subscriber can schedule a switch to yearly.' });
      return;
    }
    if (entitlement.cancelAtCycleEnd) {
      response.status(409).json({ error: 'This monthly subscription is already scheduled to end. It cannot be switched to yearly.' });
      return;
    }
    if (entitlement.scheduledPlan) {
      response.status(409).json({ error: 'A plan change is already scheduled for this subscription.' });
      return;
    }

    const subscriptionId = entitlement.subscriptionId;
    const mappingRef = subscriptionDocument(db, subscriptionId);
    const mappingSnapshot = await mappingRef.get();
    const mapping = mappingSnapshot.data() || {};
    if (!mappingSnapshot.exists || mapping.uid !== request.user.uid || mapping.planKey !== 'monthly') {
      response.status(403).json({ error: 'This subscription could not be matched to the signed-in account.' });
      return;
    }

    const currency = mapping.currency || 'INR';
    if (currency !== 'INR') {
      response.status(409).json({ error: 'Plan changes are available only for INR subscriptions. Your current subscription remains unchanged.' });
      return;
    }
    const pricingSnapshot = await db.doc('appConfig/pricing').get();
    const pricing = normalizePricingConfig(pricingSnapshot.exists ? pricingSnapshot.data() : {});
    const yearlyBillingPlan = pricedBillingPlan('yearly', currency, pricing);
    if (!providerPlanId('yearly', currency, pricing)) {
      response.status(503).json({ error: `Razorpay ${currency} yearly subscriptions are not configured on this server yet.` });
      return;
    }
    const [subscription, yearlyPlan] = await Promise.all([
      razorpayRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`),
      verifiedProviderPlan('yearly', currency, pricing)
    ]);
    const currentEnd = Number(subscription.current_end) * 1000;
    if (subscription.status !== 'active' || subscription.plan_id !== mapping.planId
      || !Number.isFinite(currentEnd) || currentEnd <= Date.now()) {
      response.status(409).json({ error: 'Razorpay does not show an active monthly billing period for this subscription.' });
      return;
    }
    if (['upi', 'emandate'].includes(String(subscription.payment_method || '').toLowerCase())) {
      response.status(409).json({ error: 'Razorpay does not support plan changes for this payment method. You can choose yearly after the monthly plan ends.' });
      return;
    }
    if (subscription.has_scheduled_changes) {
      response.status(409).json({ error: 'This subscription already has a change scheduled in Razorpay.' });
      return;
    }

    const requestId = randomUUID();
    await db.runTransaction(async transaction => {
      const [currentMapping, currentEntitlement] = await Promise.all([
        transaction.get(mappingRef),
        transaction.get(entitlementRef)
      ]);
      const currentMap = currentMapping.data() || {};
      const currentPlan = publicEntitlement(currentEntitlement.data());
      if (!currentMapping.exists || currentMap.uid !== request.user.uid
        || currentMap.planKey !== 'monthly' || currentPlan.subscriptionId !== subscriptionId
        || currentPlan.status !== 'active' || currentPlan.scheduledPlan || currentPlan.cancelAtCycleEnd) {
        const error = new Error('The subscription changed while the plan switch was being scheduled. Refresh and check its status.');
        error.status = 409;
        throw error;
      }
      transaction.set(mappingRef, {
        pendingPlanKey: 'yearly',
        pendingPlanId: yearlyPlan.id,
        pendingPlanAmount: yearlyBillingPlan.amount,
        pendingCurrency: currency,
        pendingPlanStatus: 'scheduling',
        planChangeRequestId: requestId,
        scheduledAt: currentEnd,
        updatedAt: Date.now()
      }, { merge: true });
      transaction.set(entitlementRef, {
        scheduledPlan: 'yearly',
        scheduledAt: currentEnd,
        planChangeStatus: 'scheduling'
      }, { merge: true });
      transaction.set(userCheckoutDocument(db, request.user.uid), {
        subscriptionId,
        planKey: 'monthly',
        scheduledPlan: 'yearly',
        scheduledAt: currentEnd,
        planChangeStatus: 'scheduling',
        updatedAt: Date.now()
      }, { merge: true });
    });

    let razorpayScheduled = false;
    try {
      const updated = await razorpayRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        method: 'PATCH',
        body: {
          plan_id: yearlyPlan.id,
          remaining_count: BILLING_PLANS.yearly.totalCount,
          schedule_change_at: 'cycle_end',
          customer_notify: 1
        }
      });
      if (updated.has_scheduled_changes !== true) {
        throw new Error('Razorpay did not confirm the scheduled plan change.');
      }
      razorpayScheduled = true;
      await db.runTransaction(async transaction => {
        const [currentMapping, currentEntitlement] = await Promise.all([
          transaction.get(mappingRef),
          transaction.get(entitlementRef)
        ]);
        if (currentMapping.data()?.planChangeRequestId !== requestId) return;
        transaction.set(mappingRef, { pendingPlanStatus: 'scheduled', updatedAt: Date.now() }, { merge: true });
        transaction.set(entitlementRef, { planChangeStatus: 'scheduled' }, { merge: true });
        transaction.set(userCheckoutDocument(db, request.user.uid), { planChangeStatus: 'scheduled', updatedAt: Date.now() }, { merge: true });
      });
    } catch (error) {
      if (!razorpayScheduled) {
        await db.runTransaction(async transaction => {
          const [currentMapping, currentEntitlement] = await Promise.all([
            transaction.get(mappingRef),
            transaction.get(entitlementRef)
          ]);
          if (currentMapping.data()?.planChangeRequestId !== requestId) return;
          transaction.set(mappingRef, {
            pendingPlanKey: null,
            pendingPlanId: null,
            pendingPlanAmount: null,
            pendingPlanStatus: null,
            planChangeRequestId: null,
            scheduledAt: null,
            updatedAt: Date.now()
          }, { merge: true });
          transaction.set(entitlementRef, { scheduledPlan: null, scheduledAt: null, planChangeStatus: null }, { merge: true });
          transaction.set(userCheckoutDocument(db, request.user.uid), {
            scheduledPlan: null,
            scheduledAt: null,
            planChangeStatus: null,
            updatedAt: Date.now()
          }, { merge: true });
        });
      }
      throw error;
    }
    await recordBillingActivity(db, request.user.uid, {
      type: 'subscription', status: 'success', title: 'Yearly plan switch scheduled',
      detail: 'Your subscription will move to yearly billing at the end of the current monthly period.',
      planKey: 'yearly', providerSubscriptionId: subscriptionId
    });
    response.json({ scheduled: true, scheduledPlan: 'yearly', scheduledAt: currentEnd });
  } catch (error) {
    const yearlySwitchRequiresCancellation = error.status === 400
      && /only offers can be updated for subscriptions when payment mode is domestic card/i
        .test(error.providerDetail || error.message || '');
    if (yearlySwitchRequiresCancellation) {
      console.warn('Razorpay does not support changing a domestic-card subscription plan.');
      response.status(409).json({
        code: 'YEARLY_SWITCH_REQUIRES_CANCELLATION',
        error: 'Razorpay does not allow changing an active domestic-card subscription from monthly to yearly. Your current plan is unchanged. You can stop monthly renewal at period end, then start a yearly plan after your access expires.'
      });
      return;
    }
    console.error('Could not schedule the yearly plan change.', error);
    response.status(error.status === 409 ? 409 : error.status === 400 ? 400 : 502).json({
      error: error.status === 409
        ? error.message
        : error.status === 400
          ? 'Razorpay could not schedule this plan change. The monthly subscription has not been replaced.'
          : 'Could not schedule the yearly plan. Refresh and check the subscription status before retrying.'
    });
  }
});

app.post('/api/billing/cancel', requireSubscriptionManagementConfig, requireFirebaseUser, async (request, response) => {
  const reason = typeof request.body?.reason === 'string' ? request.body.reason.trim() : '';
  let subscriptionId = typeof request.body?.subscriptionId === 'string' ? request.body.subscriptionId.trim() : '';

  try {
    const { db } = await getFirebaseAdmin();
    if (!subscriptionId) {
      const checkoutSnapshot = await userCheckoutDocument(db, request.user.uid).get();
      subscriptionId = typeof checkoutSnapshot.data()?.subscriptionId === 'string'
        ? checkoutSnapshot.data().subscriptionId.trim()
        : '';
    }
    if (!subscriptionId || !/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) {
      response.status(400).json({ error: 'A valid subscription ID is required.' });
      return;
    }
    const ref = subscriptionDocument(db, subscriptionId);
    const snapshot = await ref.get();
    if (!snapshot.exists || snapshot.data().uid !== request.user.uid) {
      response.status(404).json({ error: 'No subscription was found for this account.' });
      return;
    }
    if (snapshot.data().pendingPlanStatus === 'scheduling') {
      response.status(409).json({ error: 'A plan switch is being scheduled. Wait a moment and try again.' });
      return;
    }
    const result = await razorpayRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
      method: 'POST',
      body: { cancel_at_cycle_end: true }
    });
    await db.runTransaction(async transaction => {
      const entitlementRef = userEntitlementDocument(db, request.user.uid);
      const currentEntitlement = await transaction.get(entitlementRef);
      const currentValidUntil = Number(currentEntitlement.data()?.validUntil)
        || Number(snapshot.data().currentEnd)
        || 0;
      transaction.set(ref, {
        status: result.status || 'cancelled',
        cancelAtCycleEnd: true,
        pendingPlanKey: null,
        pendingPlanId: null,
        scheduledAt: null,
        updatedAt: Date.now()
      }, { merge: true });
      transaction.set(entitlementRef, {
        planId: 'pro',
        billingPlan: snapshot.data().planKey,
        status: 'active',
        source: 'server-verified',
        validUntil: currentValidUntil,
        subscriptionId,
        cancelAtCycleEnd: true,
        scheduledPlan: null,
        scheduledAt: null,
        planChangeStatus: null
      }, { merge: true });
      transaction.set(userCheckoutDocument(db, request.user.uid), {
        subscriptionId,
        status: result.status || 'active',
        currentEnd: currentValidUntil,
        cancelAtCycleEnd: true,
        scheduledPlan: null,
        scheduledAt: null,
        planChangeStatus: null,
        updatedAt: Date.now()
      }, { merge: true });
    });
    const cancellationDetail = reason
      ? `Future renewals have been stopped. ${reason}`
      : 'Future renewals have been stopped. Access remains available through the paid period.';
    await recordBillingActivity(db, request.user.uid, {
      type: 'subscription', status: 'cancelled', title: 'Subscription cancelled by user',
      detail: cancellationDetail,
      reason,
      planKey: snapshot.data().planKey, providerSubscriptionId: subscriptionId,
      actorType: 'user', actorUid: request.user.uid
    });
    response.json({ cancelled: true, status: result.status || 'cancelled' });
  } catch (error) {
    console.error('Could not cancel Razorpay subscription.', error);
    response.status(502).json({ error: 'Could not schedule cancellation. Please retry or contact support.' });
  }
});

app.get('/', (_request, response) => {
  response.redirect(302, '/home.html');
});

app.get('/home.html', (_request, response) => {
  response.sendFile(path.join(distDir, 'home.html'));
});

app.use(express.static(distDir));
app.use((_request, response) => {
  response.status(404).json({ error: 'Not found' });
});

export { app };

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  app.listen(port, '0.0.0.0', () => {
    console.log(`ResumeOut.com backend listening on port ${port}`);
  });
}
