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
  billingPeriodEnd,
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
import {
  REFERRAL_CONFIG,
  calculateReferralSummary,
  encodeReferralCursor,
  generateReferralCode,
  maskReferralIdentity,
  parseReferralCursor,
  referralPageSize,
  referralRewardDays,
  referralsEnabled,
  validReferralCode
} from './referrals.js';

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
const VOUCHER_MAX_REDEMPTIONS = 1;
const referralAttributionAttempts = new Map();
let firebaseAdmin;

app.disable('x-powered-by');

app.use((request, response, next) => {
  const hostname = String(request.hostname || '').toLowerCase();
  const isApiRequest = request.path === '/api' || request.path.startsWith('/api/');
  if (hostname === 'buildmyportfolio.onrender.com' && !isApiRequest) {
    return response.redirect(301, `https://resumeout.vercel.app${request.originalUrl || '/'}`);
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

function forumAuthorCompany(value) {
  return validForumText(value, 1, 100) || '';
}

function accountProfileText(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.toLowerCase() === 'undefined' ? '' : text;
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
    authorCompany: forumAuthorCompany(data.authorCompany),
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
    createdAt: Number.isFinite(data.createdAt) ? data.createdAt : 0,
    updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : null
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

async function loadForumContent(db, kind, cursor, userUid = null, postFilters = {}) {
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
    if (kind !== 'posts') query = query.startAfter(cursorSnapshot);
  }
  const documents = [];
  let hasMore = false;
  let snapshot;
  if (kind === 'posts') {
    let scanAfter = cursorPath ? await db.doc(cursorPath).get() : null;
    while (documents.length < 26) {
      const scanQuery = scanAfter ? query.startAfter(scanAfter) : query;
      snapshot = await scanQuery.limit(25).get();
      const candidates = snapshot.docs.filter(document => {
        const data = document.data();
        if (userUid && data.isDeleted) return false;
        if (!forumPostInput(data)) return false;
        if (postFilters.status === 'active' && data.isDeleted) return false;
        if (postFilters.status === 'deleted' && !data.isDeleted) return false;
        if (postFilters.type !== 'all' && postFilters.type && data.type !== postFilters.type) return false;
        if (postFilters.search) {
          const searchable = `${data.title || ''} ${data.content || ''} ${data.authorName || ''} ${data.authorUid || ''}`.toLocaleLowerCase();
          if (!searchable.includes(postFilters.search)) return false;
        }
        return true;
      });
      documents.push(...candidates.slice(0, 26 - documents.length));
      if (documents.length >= 26) {
        hasMore = true;
        break;
      }
      if (snapshot.docs.length < 25) break;
      scanAfter = snapshot.docs.at(-1);
    }
    if (documents.length === 26) documents.pop();
  } else {
    snapshot = await query.limit(25).get();
    documents.push(...snapshot.docs);
    hasMore = snapshot.docs.length === 25;
  }
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
        authorCompany: forumAuthorCompany(data.authorCompany),
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
  const nextCursorDocument = kind === 'posts' ? documents.at(-1) : snapshot.docs.at(-1);
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
  const basePlan = billingPlan(planKey, currency);
  const configuredPrice = Number(pricingPlanEntry(pricing, planKey, currency)?.currentPrice);
  const envPlanMatchesPrice = isRazorpayPlanId(envValue)
    && (!Number.isFinite(configuredPrice) || Math.round(configuredPrice * 100) === basePlan?.amount);
  if (envPlanMatchesPrice) return envValue;

  const hasSavedCurrencyPlans = pricing?.providerPlanIds
    && Object.hasOwn(pricing.providerPlanIds, currency);
  const planId = pricing?.providerPlanIds?.[currency]?.[planKey]
    || (hasSavedCurrencyPlans ? '' : envValue);
  return isRazorpayPlanId(planId) ? planId : null;
}

function providerPlanIdCandidates(planKey, currency, pricing) {
  const envKey = billingPlanEnvKey(planKey, currency);
  const envPlanId = envKey ? (process.env[envKey] || '').trim() : '';
  const savedPlanId = pricing?.providerPlanIds?.[currency]?.[planKey];
  return [...new Set([
    providerPlanId(planKey, currency, pricing),
    savedPlanId,
    envPlanId
  ].filter(isRazorpayPlanId))];
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
  const candidates = providerPlanIdCandidates(planKey, currency, pricing);
  if (!candidates.length) {
    const subscriptionId = providerSubscriptionId(planKey, currency);
    if (!subscriptionId) {
      throw new Error(`The Razorpay ${currency} ${planKey} plan is not configured.`);
    }
    const subscription = await razorpayRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
    const resolvedPlanId = subscription?.plan_id;
    if (!isRazorpayPlanId(resolvedPlanId)) {
      const error = new Error(`The configured Razorpay ${currency} ${planKey} subscription does not reference a valid plan.`);
      error.status = 503;
      throw error;
    }
    candidates.push(resolvedPlanId);
  }

  let lastError;
  for (const candidate of candidates) {
    let plan;
    try {
      plan = await razorpayRequest(`/plans/${encodeURIComponent(candidate)}`);
    } catch (error) {
      if (error?.status !== 404) throw error;
      lastError = error;
      continue;
    }
    if (planMatchesRazorpay(plan, expected)) return plan;

    lastError = new Error(`The Razorpay ${currency} ${planKey} plan does not match the configured price and billing interval.`);
    lastError.status = 503;
  }

  if (lastError) throw lastError;
  throw new Error(`The Razorpay ${currency} ${planKey} plan could not be verified.`);
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

function referralCookieId(request) {
  const cookies = String(request.get('cookie') || '').split(';');
  const cookie = cookies.map(value => value.trim()).find(value => value.startsWith('resumeout_referral='));
  const id = cookie?.slice('resumeout_referral='.length) || '';
  return /^[A-Za-z0-9_-]{20,80}$/.test(id) ? id : null;
}

function referralHistoryIndexUnavailable(error) {
  return error?.code === 'failed-precondition'
    || /requires an index/i.test(String(error?.message || ''));
}

function sortReferralDocumentsForPage(documents, cursor) {
  return documents
    .filter(document => {
      if (!cursor) return true;
      const createdAt = Number(document.data()?.createdAt) || 0;
      return createdAt < cursor.createdAt
        || createdAt === cursor.createdAt && document.id < cursor.id;
    })
    .sort((left, right) => {
      const createdAtDifference = (Number(right.data()?.createdAt) || 0)
        - (Number(left.data()?.createdAt) || 0);
      if (createdAtDifference) return createdAtDifference;
      if (right.id > left.id) return 1;
      if (right.id < left.id) return -1;
      return 0;
    });
}

function referralAttributionRateLimited(clientAddress, now = Date.now()) {
  const key = String(clientAddress || 'unknown');
  const record = referralAttributionAttempts.get(key);
  if (!record || record.resetAt <= now) {
    referralAttributionAttempts.set(key, { count: 1, resetAt: now + 60 * 60 * 1000 });
  } else if (record.count >= 30) {
    return true;
  } else {
    record.count += 1;
  }
  if (referralAttributionAttempts.size > 5000) {
    for (const [address, attempt] of referralAttributionAttempts) {
      if (attempt.resetAt <= now) referralAttributionAttempts.delete(address);
    }
  }
  return false;
}

function referralCookieOptions() {
  return [
    'Path=/',
    `Max-Age=${REFERRAL_CONFIG.attributionWindowDays * 24 * 60 * 60}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(process.env.VERCEL === '1' || process.env.NODE_ENV === 'production' ? ['Secure'] : [])
  ].join('; ');
}

function publicSiteOrigin() {
  const configuredOrigin = (process.env.PUBLIC_SITE_URL || 'https://resumeout.com').trim();
  const origin = new URL(configuredOrigin);
  if (origin.username || origin.password
    || !['https:', 'http:'].includes(origin.protocol)
    || origin.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(origin.hostname)) {
    throw new Error('PUBLIC_SITE_URL must be an HTTPS origin (HTTP is allowed only for localhost).');
  }
  return origin.origin;
}

function referralRewardRecord({
  rewardId, beneficiaryUid, referralId, rewardType, days, now, startsAt,
  planKey = null, paymentId = null, subscriptionId = null, reason = null,
  originalRewardId = null, idempotencyKey
}) {
  return {
    beneficiaryUid,
    referralId,
    rewardSource: rewardType === 'manual' ? 'admin_manual' : 'referral',
    rewardType,
    durationDays: days,
    status: startsAt > now ? 'scheduled' : 'active',
    createdAt: now,
    startsAt,
    activatedAt: startsAt <= now ? now : null,
    expiresAt: startsAt + days * 86_400_000,
    idempotencyKey,
    relatedPaymentId: paymentId,
    relatedSubscriptionId: subscriptionId,
    planKey,
    reason,
    originalRewardId,
    configurationVersion: REFERRAL_CONFIG.version,
    revokedAt: null
  };
}

async function revokeReferralConversion(db, {
  referralId, reason, eventReference, providerState, relatedPaymentId = null, relatedSubscriptionId = null
}) {
  const referralRef = db.doc(`referrals/${referralId}`);
  const originalRewardRef = db.doc(`referralRewards/${referralId}_conversion`);
  const reversalId = `${referralId}_reversal_${eventReference.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100)}`;
  const reversalRef = db.doc(`referralRewards/${reversalId}`);
  const auditRef = db.doc(`referralRewardEvents/${reversalId}`);
  const now = Date.now();
  return db.runTransaction(async transaction => {
    const [referralSnapshot, rewardSnapshot, reversalSnapshot] = await Promise.all([
      transaction.get(referralRef),
      transaction.get(originalRewardRef),
      transaction.get(reversalRef)
    ]);
    if (!referralSnapshot.exists || !rewardSnapshot.exists || reversalSnapshot.exists) return false;
    const referral = referralSnapshot.data() || {};
    const reward = rewardSnapshot.data() || {};
    if (referral.firstQualifyingPaymentId !== relatedPaymentId && relatedPaymentId
      || referral.firstQualifyingSubscriptionId !== relatedSubscriptionId && relatedSubscriptionId) return false;
    if (reward.rewardType !== 'conversion' || reward.status === 'revoked'
      || referral.paidConversionRewardStatus !== 'issued') return false;
    const summaryRef = db.doc(`referralUserSummaries/${reward.beneficiaryUid}`);
    const [allRewardsSnapshot, entitlementSnapshot, summarySnapshot] = await Promise.all([
      transaction.get(db.collection('referralRewards').where('beneficiaryUid', '==', reward.beneficiaryUid)),
      transaction.get(userEntitlementDocument(db, reward.beneficiaryUid)),
      transaction.get(summaryRef)
    ]);
    const rewardRecords = (allRewardsSnapshot.docs || []).map(document => ({
      id: document.id,
      ...(document.data() || {})
    }));
    const previouslyRevoked = new Set(rewardRecords
      .filter(item => item.rewardType === 'reversal')
      .map(item => item.originalRewardId)
      .filter(Boolean));
    previouslyRevoked.add(`${referralId}_conversion`);
    const remainingRewardEnd = rewardRecords
      .filter(item => item.rewardType !== 'reversal' && !previouslyRevoked.has(item.id))
      .reduce((latest, item) => Math.max(latest, Number(item.expiresAt) || 0), 0);
    const paidUntil = Number(entitlementSnapshot.data()?.validUntil) || 0;
    transaction.create(reversalRef, {
      beneficiaryUid: reward.beneficiaryUid,
      referralId,
      rewardSource: 'referral',
      rewardType: 'reversal',
      originalRewardType: 'conversion',
      durationDays: Number(reward.durationDays) || 0,
      status: 'revoked',
      createdAt: now,
      reason,
      originalRewardId: `${referralId}_conversion`,
      relatedPaymentId: relatedPaymentId || referral.firstQualifyingPaymentId || null,
      relatedSubscriptionId: relatedSubscriptionId || referral.firstQualifyingSubscriptionId || null,
      providerState,
      providerEventReference: eventReference,
      idempotencyKey: `reversal:${referralId}:${eventReference}`,
      configurationVersion: REFERRAL_CONFIG.version
    });
    transaction.set(summaryRef, {
      rewardStackUntil: Math.max(paidUntil, remainingRewardEnd),
      updatedAt: now
    }, { merge: true });
    transaction.set(referralRef, {
      status: 'revoked',
      paidConversionRewardStatus: 'revoked',
      revokedAt: now,
      revocationReason: reason,
      updatedAt: now
    }, { merge: true });
    transaction.create(auditRef, {
      type: 'conversion-revoked',
      referralId,
      originalRewardId: `${referralId}_conversion`,
      reversalId,
      reason,
      relatedPaymentId: relatedPaymentId || referral.firstQualifyingPaymentId || null,
      relatedSubscriptionId: relatedSubscriptionId || referral.firstQualifyingSubscriptionId || null,
      providerState,
      providerEventReference: eventReference,
      occurredAt: now
    });
    return true;
  });
}

async function linkedSubscriptionId(db, uid, entitlement) {
  let subscriptionId = entitlement?.subscriptionId;
  if (typeof subscriptionId !== 'string' || !/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) {
    const checkoutSnapshot = await userCheckoutDocument(db, uid).get();
    subscriptionId = checkoutSnapshot.data()?.subscriptionId;
  }
  return typeof subscriptionId === 'string' && /^sub_[A-Za-z0-9]+$/.test(subscriptionId)
    ? subscriptionId
    : null;
}

function activatePendingVouchers(entitlement, now = Date.now()) {
  if (entitlement?.adminRevoked === true) return null;
  if (entitlement?.lifetime === true) return null;
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
    lifetime: false,
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

function entitlementValidUntil(data) {
  const value = data?.validUntil;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.toMillis === 'function') {
    const timestamp = Number(value.toMillis());
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
  if (value && Number.isFinite(Number(value.seconds))) {
    return Number(value.seconds) * 1000 + (Number(value.nanoseconds) || 0) / 1e6;
  }
  return 0;
}

function hasActiveProEntitlement(data, now = Date.now()) {
  return data?.adminRevoked !== true
    && data?.planId === 'pro'
    && (data?.lifetime === true || entitlementValidUntil(data) > now);
}

function adminRevocationApplies(uid, entitlement, subscription) {
  if (entitlement?.adminRevoked === true) return true;
  if (subscription?.uid !== uid || subscription.adminRevoked !== true) return false;
  const hasRestoredNonSubscriptionGrant = entitlement?.planId === 'pro'
    && entitlement.adminRevoked !== true
    && (entitlement.source === 'admin' || entitlement.billingPlan === 'voucher');
  return !hasRestoredNonSubscriptionGrant;
}

async function adminEntitlementWithVoucherMetadata(db, uid, entitlement) {
  if (entitlement?.billingPlan !== 'voucher') return entitlement;
  let voucher = null;
  if (entitlement.voucherId) {
    const voucherSnapshot = await db.doc(`adminVouchers/${entitlement.voucherId}`).get();
    voucher = voucherSnapshot.exists ? { id: entitlement.voucherId, ...(voucherSnapshot.data() || {}) } : null;
  }
  if ((!voucher || voucher.redeemedByUid && voucher.redeemedByUid !== uid)
    && typeof db.collection === 'function') {
    const vouchers = await db.collection('adminVouchers').get();
    const records = (vouchers.docs || []).map(document => ({
      id: document.id,
      ...(document.data() || {})
    }));
    voucher = records.find(item => item.redeemedByUid === uid
      && (!entitlement.voucherId || item.id === entitlement.voucherId
        || item.code && voucherDocumentId(item.code) === entitlement.voucherId))
      || (entitlement.voucherId
        ? records.find(item => item.code && voucherDocumentId(item.code) === entitlement.voucherId)
        : null)
      || null;
  }
  if (!voucher) return entitlement;
  if (voucher.redeemedByUid && voucher.redeemedByUid !== uid) return entitlement;

  const lifetime = entitlement.lifetime === true || voucher.lifetime === true;
  const redeemedAt = Number(voucher.redeemedAt) || 0;
  const revokedAt = Number(entitlement.adminRevokedAt) || 0;
  const redemptionRestoresAccess = entitlement.adminRevoked === true
    && redeemedAt > 0
    && redeemedAt > revokedAt;
  const durationDays = Number(voucher.durationDays);
  const recoveredValidUntil = !lifetime && redeemedAt > 0 && Number.isFinite(durationDays) && durationDays > 0
    ? redeemedAt + durationDays * 24 * 60 * 60 * 1000
    : 0;
  return {
    ...entitlement,
    planId: 'pro',
    ...(redemptionRestoresAccess ? { adminRevoked: false, adminRevokedAt: null } : {}),
    lifetime,
    validUntil: lifetime ? null : entitlementValidUntil(entitlement) || recoveredValidUntil || null
  };
}

function publicEntitlement(data) {
  const validUntil = entitlementValidUntil(data);
  const lifetime = data?.lifetime === true;
  const pendingVouchers = Array.isArray(data?.pendingVouchers) ? data.pendingVouchers : [];
  const status = hasActiveProEntitlement(data)
    ? 'active'
    : 'inactive';
  return {
    planId: data?.planId || 'free',
    billingPlan: data?.billingPlan || null,
    currency: data?.currency || 'INR',
    status,
    source: 'server-verified',
    validUntil: lifetime ? null : validUntil,
    lifetime,
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

async function referralPromotionalAccess(db, uid, now = Date.now()) {
  if (!referralsEnabled()) {
    return { activeRewards: [], unexpiredRewards: [], promotionalValidUntil: 0 };
  }
  const rewardSnapshot = await db.collection('referralRewards')
    .where('beneficiaryUid', '==', uid)
    .get();
  const rewardRecords = (rewardSnapshot.docs || []).map(document => ({
    id: document.id,
    ...(document.data() || {})
  }));
  const revokedRewardIds = new Set(rewardRecords
    .filter(reward => reward.rewardType === 'reversal')
    .map(reward => reward.originalRewardId)
    .filter(Boolean));
  const unexpiredRewards = rewardRecords
    .filter(reward => reward.rewardType !== 'reversal'
      && !revokedRewardIds.has(reward.id)
      && reward.status !== 'revoked'
      && Number.isFinite(Number(reward.startsAt))
      && Number.isFinite(Number(reward.expiresAt))
      && Number(reward.expiresAt) > now
      && Number(reward.expiresAt) > Number(reward.startsAt));
  return {
    activeRewards: unexpiredRewards.filter(reward => Number(reward.startsAt) <= now),
    unexpiredRewards,
    promotionalValidUntil: unexpiredRewards
      .reduce((latest, reward) => Math.max(latest, Number(reward.expiresAt)), 0)
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

function isRazorpayCapturedPayment(payment) {
  return payment?.status === 'captured'
    && typeof payment.id === 'string'
    && /^pay_[A-Za-z0-9]+$/.test(payment.id)
    && payment.providerPaymentId === payment.id
    && typeof payment.subscriptionId === 'string'
    && /^sub_[A-Za-z0-9]+$/.test(payment.subscriptionId)
    && Number.isSafeInteger(payment.amount)
    && payment.amount > 0
    && (payment.currency === undefined || /^[A-Z]{3}$/.test(payment.currency));
}

async function reconcileSubscriptionInvoices(db, uid, subscriptionId, mapping) {
  const pageSize = 100;
  for (let skip = 0; skip < 1200; skip += pageSize) {
    const invoiceCollection = await razorpayRequest(
      `/invoices?subscription_id=${encodeURIComponent(subscriptionId)}&count=${pageSize}&skip=${skip}`
    );
    if (!Array.isArray(invoiceCollection?.items)) {
      throw new Error('Razorpay returned an invalid subscription invoice list.');
    }

    const paidInvoices = invoiceCollection.items.filter(invoice => (
      invoice?.subscription_id === subscriptionId
      && invoice.status === 'paid'
      && typeof invoice.payment_id === 'string'
      && /^pay_[A-Za-z0-9]+$/.test(invoice.payment_id)
      && Number.isSafeInteger(invoice.amount_paid)
      && invoice.amount_paid > 0
    ));
    await Promise.all(paidInvoices.map(async invoice => {
      const createdAt = Number(invoice.paid_at || invoice.created_at) > 0
        ? Number(invoice.paid_at || invoice.created_at) * 1000
        : Date.now();
      const validUntil = Number(invoice.billing_end) > 0
        ? Number(invoice.billing_end) * 1000
        : Number(mapping.currentEnd) || null;
      const currency = typeof invoice.currency === 'string' ? invoice.currency : mapping.currency || 'INR';
      const payment = {
        uid,
        providerPaymentId: invoice.payment_id,
        subscriptionId,
        planKey: mapping.planKey,
        status: 'captured',
        amount: invoice.amount_paid,
        currency,
        paymentMode: 'unknown',
        source: 'razorpay',
        createdAt
      };
      await Promise.all([
        db.doc(`billingPayments/${invoice.payment_id}`).set(payment, { merge: true }),
        db.doc(`billingAccessHistory/${invoice.payment_id}`).set({
          ...payment,
          validFrom: createdAt,
          validUntil,
          paymentId: invoice.payment_id,
          status: validUntil > Date.now() ? 'active' : 'paid'
        }, { merge: true })
      ]);
    }));

    if (invoiceCollection.items.length < pageSize) return;
  }
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
app.use('/api/shared-resumes', express.json({ limit: '900kb' }));
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
      response.json({
        mobileNumber: '',
        photoDataUrl: '',
        highestEducation: '',
        company: '',
        designation: ''
      });
      return;
    }
    const savedProfile = snapshot.data();
    const { mobileNumber, photoDataUrl = '' } = savedProfile;
    const highestEducation = accountProfileText(savedProfile.highestEducation);
    const company = accountProfileText(savedProfile.company);
    const designation = accountProfileText(savedProfile.designation);
    if (typeof mobileNumber !== 'string' || typeof photoDataUrl !== 'string'
      || typeof highestEducation !== 'string' || highestEducation.length > 100
      || typeof company !== 'string' || company.length > 100
      || typeof designation !== 'string' || designation.length > 100
      || photoDataUrl.length > 140000
      || (photoDataUrl && !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(photoDataUrl))) {
      response.status(500).json({ error: 'Your saved account details are invalid. Contact support for help.' });
      return;
    }
    response.json({ mobileNumber, photoDataUrl, highestEducation, company, designation });
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
  const highestEducation = request.body?.highestEducation === undefined
    ? undefined
    : typeof request.body.highestEducation === 'string' ? accountProfileText(request.body.highestEducation) : null;
  const company = request.body?.company === undefined
    ? undefined
    : typeof request.body.company === 'string' ? accountProfileText(request.body.company) : null;
  const designation = request.body?.designation === undefined
    ? undefined
    : typeof request.body.designation === 'string' ? accountProfileText(request.body.designation) : null;
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
  if ([highestEducation, company, designation].some(value => value !== undefined && (value === null || value.length > 100))) {
    response.status(400).json({ error: 'Education, company, and designation must each be 100 characters or fewer.' });
    return;
  }
  try {
    const { auth, db } = await getFirebaseAdmin();
    const profileReference = db.doc(`users/${request.user.uid}/profile/account`);
    const existingProfile = await profileReference.get();
    const existingFields = existingProfile.exists ? existingProfile.data() : {};
    const savedHighestEducation = highestEducation ?? accountProfileText(existingFields.highestEducation);
    const savedCompany = company ?? accountProfileText(existingFields.company);
    const savedDesignation = designation ?? accountProfileText(existingFields.designation);
    await Promise.all([
      auth.updateUser(request.user.uid, { displayName }),
      profileReference.set({
        mobileNumber,
        photoDataUrl,
        highestEducation: savedHighestEducation,
        company: savedCompany,
        designation: savedDesignation,
        updatedAt: new Date()
      }, { merge: true })
    ]);
    response.json({
      displayName,
      mobileNumber,
      photoDataUrl,
      highestEducation: savedHighestEducation,
      company: savedCompany,
      designation: savedDesignation
    });
  } catch (error) {
    console.error('Could not save the account profile.', error);
    response.status(500).json({ error: 'Could not save your account details. Please try again.' });
  }
});

app.use('/api/shared-resumes', (_request, response, next) => {
  response.set('Cache-Control', 'no-store');
  next();
});

app.post('/api/shared-resumes', requireFirebaseUser, async (request, response) => {
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
  const sourceResumeId = typeof request.body?.sourceResumeId === 'string' ? request.body.sourceResumeId : '';
  const state = request.body?.state;
  if (!name || name.length > 120 || sourceResumeId.length > 1500
    || !state || typeof state !== 'object' || Array.isArray(state)) {
    response.status(400).json({ error: 'The resume name or data is invalid and cannot be shared.' });
    return;
  }
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > 800 * 1024) {
    response.status(413).json({ error: 'This resume is too large to share. Remove large images or content, then try again.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const collection = db.collection('sharedResumes');
    const existing = await collection.where('ownerUid', '==', request.user.uid).limit(50).get();
    if (existing.size >= 50) {
      response.status(409).json({ error: 'You have reached the limit of 50 active share links. Revoke a link before creating another.' });
      return;
    }
    const reference = collection.doc();
    await reference.set({
      ownerUid: request.user.uid,
      sourceResumeId,
      name,
      state,
      active: true,
      createdAt: new Date()
    });
    response.status(201).json({ id: reference.id });
  } catch (error) {
    console.error('Could not create a shared resume.', error);
    response.status(500).json({ error: 'Could not create a share link. Please try again.' });
  }
});

app.get('/api/shared-resumes', requireFirebaseUser, async (request, response) => {
  try {
    const { db } = await getFirebaseAdmin();
    const result = await db.collection('sharedResumes')
      .where('ownerUid', '==', request.user.uid)
      .limit(50)
      .get();
    const shares = result.docs.map(document => {
      const data = document.data();
      if (data.ownerUid !== request.user.uid || typeof data.name !== 'string'
        || typeof data.active !== 'boolean') {
        throw new Error('A stored resume share has invalid data.');
      }
      const createdAt = data.createdAt instanceof Date
        ? data.createdAt.getTime()
        : data.createdAt?.toMillis?.() ?? 0;
      return {
        id: document.id,
        name: data.name,
        sourceResumeId: typeof data.sourceResumeId === 'string' ? data.sourceResumeId : '',
        active: data.active,
        createdAt
      };
    }).sort((left, right) => right.createdAt - left.createdAt);
    response.json({ shares });
  } catch (error) {
    console.error('Could not list shared resumes.', error);
    response.status(500).json({ error: 'Could not load your share links. Please try again.' });
  }
});

app.get('/api/shared-resumes/:shareId', async (request, response) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(request.params.shareId)) {
    response.status(400).json({ error: 'This resume share link is invalid.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const snapshot = await db.collection('sharedResumes').doc(request.params.shareId).get();
    if (!snapshot.exists || snapshot.data().active !== true) {
      response.status(404).json({ error: 'This resume share link is unavailable. Ask the owner for a new link.' });
      return;
    }
    const { name, state } = snapshot.data();
    if (typeof name !== 'string' || !state || typeof state !== 'object' || Array.isArray(state)) {
      response.status(500).json({ error: 'This shared resume is invalid and cannot be opened.' });
      return;
    }
    response.json({ name, state });
  } catch (error) {
    console.error('Could not open a shared resume.', error);
    response.status(500).json({ error: 'Could not open this shared resume. Please try again.' });
  }
});

app.delete('/api/shared-resumes/:shareId', requireFirebaseUser, async (request, response) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(request.params.shareId)) {
    response.status(400).json({ error: 'This resume share link is invalid.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const reference = db.collection('sharedResumes').doc(request.params.shareId);
    const snapshot = await reference.get();
    if (!snapshot.exists) {
      response.status(404).json({ error: 'This resume share link is already unavailable.' });
      return;
    }
    if (snapshot.data().ownerUid !== request.user.uid) {
      response.status(403).json({ error: 'You can only revoke share links that you created.' });
      return;
    }
    await reference.delete();
    response.status(204).end();
  } catch (error) {
    console.error('Could not revoke a shared resume.', error);
    response.status(500).json({ error: 'Could not revoke this share link. Please try again.' });
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
  const search = typeof request.query.search === 'string' ? request.query.search.trim().toLocaleLowerCase() : '';
  const type = typeof request.query.type === 'string' ? request.query.type : 'all';
  const status = typeof request.query.status === 'string' ? request.query.status : 'all';
  if (search.length > 120 || !['all', 'review', 'discussion'].includes(type) || !['all', 'active', 'deleted'].includes(status)) {
    response.status(400).json({ error: 'The community post filters are invalid.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const page = await loadForumContent(db, kind, cursor, null, { search, type, status });
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
    const feedPosts = await Promise.all(visiblePosts.map(async item => {
      const count = await collection.doc(item.document.id).collection('comments').count().get();
      return { ...item.post, commentCount: count.data().count };
    }));
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
        const commentCount = await db.collection('forumPosts').doc(postId).collection('comments').count().get();
        post.commentCount = commentCount.data().count;
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
      authorCompany: forumAuthorCompany((await db.doc(`users/${request.user.uid}/profile/account`).get()).data()?.company),
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
        authorCompany: record.authorCompany,
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
        authorCompany: forumAuthorCompany(current.authorCompany),
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
    if (request.query.countOnly === '1') {
      const count = await collection.count().get();
      response.json({ totalCount: count.data().count });
      return;
    }
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
    const countSnapshot = await collection.count().get();
    response.json({
      comments: snapshot.docs.map(document => publicForumComment(document, request.user?.uid)).filter(Boolean),
      nextCursor: snapshot.docs.length === 100 ? snapshot.docs.at(-1).id : null,
      totalCount: countSnapshot.data().count
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

app.patch('/api/forum/posts/:postId/comments/:commentId', requireFirebaseUser, async (request, response) => {
  const { postId, commentId } = request.params;
  const content = forumCommentInput(request.body);
  if (!postId || postId.length > 150 || !commentId || commentId.length > 150 || !content) {
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
    const reference = postReference.collection('comments').doc(commentId);
    const snapshot = await reference.get();
    if (!forumSnapshotExists(snapshot)) {
      response.status(404).json({ error: 'This comment no longer exists.' });
      return;
    }
    const previous = snapshot.data();
    if (previous.authorUid !== request.user.uid) {
      response.status(403).json({ error: 'You can only edit your own comments.' });
      return;
    }
    const updatedAt = Date.now();
    const comment = { ...previous, content, updatedAt };
    const batch = db.batch();
    batch.set(reference, comment);
    appendForumActivityWrites(batch, db, {
      eventType: 'comment_edited',
      userUid: request.user.uid,
      userName: forumAuthorName(request.user),
      actorUid: request.user.uid,
      actorName: forumAuthorName(request.user),
      postId,
      postTitle: postSnapshot.data().title,
      commentId,
      reason: null,
      before: { content: forumCommentInput(previous) },
      after: { content },
      occurredAt: updatedAt
    });
    await batch.commit();
    response.json({
      comment: {
        id: commentId,
        content,
        authorName: forumAuthorName({ name: previous.authorName }),
        isOwner: true,
        createdAt: Number.isFinite(previous.createdAt) ? previous.createdAt : 0,
        updatedAt
      }
    });
  } catch (error) {
    console.error('Could not edit community comment.', error);
    response.status(500).json({ error: 'Your comment could not be updated. Please try again.' });
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

app.get('/api/referrals/config', (_request, response) => {
  response.set('Cache-Control', 'no-store');
  response.json({ enabled: referralsEnabled(), attributionWindowDays: REFERRAL_CONFIG.attributionWindowDays });
});

app.post('/api/referrals/attribution', async (request, response) => {
  response.set('Cache-Control', 'no-store');
  if (!referralsEnabled()) {
    response.status(404).json({ error: 'Referral rewards are not available.' });
    return;
  }
  if (referralAttributionRateLimited(request.ip)) {
    response.set('Retry-After', '3600').status(429).json({ error: 'Referral links are temporarily unavailable from this network. Please try again later.' });
    return;
  }
  const referralCode = typeof request.body?.code === 'string' ? request.body.code.trim().toUpperCase() : '';
  if (!validReferralCode(referralCode)) {
    response.status(400).json({ error: 'Enter a valid referral link.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const existingId = referralCookieId(request);
    if (existingId) {
      const existing = await db.doc(`referralAttributions/${existingId}`).get();
      if (existing.exists && Number(existing.data()?.expiresAt) > Date.now()) {
        response.json({ recorded: true, firstTouch: true });
        return;
      }
    }
    const codeSnapshot = await db.doc(`referralCodes/${referralCode}`).get();
    const code = codeSnapshot.data();
    if (!codeSnapshot.exists || code?.active !== true) {
      response.status(404).json({ error: 'That referral link is invalid or inactive.' });
      return;
    }
    const now = Date.now();
    const attributionId = randomUUID();
    await db.doc(`referralAttributions/${attributionId}`).create({
      referralCode,
      referrerUid: code.referrerUid,
      createdAt: now,
      expiresAt: now + REFERRAL_CONFIG.attributionWindowDays * 86_400_000,
      status: 'pending'
    });
    response.set('Set-Cookie', `resumeout_referral=${attributionId}; ${referralCookieOptions()}`);
    response.json({ recorded: true, firstTouch: true });
  } catch (error) {
    console.error('Could not record referral attribution.', error);
    response.status(500).json({ error: 'Could not save this referral. Please retry.' });
  }
});

app.get('/api/referrals/claim-status', requireFirebaseUser, async (request, response) => {
  response.set('Cache-Control', 'no-store');
  if (!referralsEnabled()) {
    response.status(404).json({ error: 'Referral rewards are not available.' });
    return;
  }
  try {
    const { auth, db } = await getFirebaseAdmin();
    const [firebaseUser, mappingSnapshot] = await Promise.all([
      auth.getUser(request.user.uid),
      db.doc(`referralByUser/${request.user.uid}`).get()
    ]);
    if (mappingSnapshot.exists) {
      response.json({ eligible: false, claimed: true, reason: 'already-used' });
      return;
    }
    const createdAt = Date.parse(firebaseUser.metadata?.creationTime || '');
    const now = Date.now();
    const expiresAt = createdAt + REFERRAL_CONFIG.attributionWindowDays * 86_400_000;
    if (!Number.isFinite(createdAt) || createdAt > now || now > expiresAt) {
      response.json({ eligible: false, claimed: false, reason: 'window-expired' });
      return;
    }
    response.json({ eligible: true, claimed: false, expiresAt });
  } catch (error) {
    console.error('Could not check referral-code eligibility.', error);
    response.status(500).json({ error: 'Could not check referral-code eligibility.' });
  }
});

app.post('/api/referrals/register', requireFirebaseUser, async (request, response) => {
  response.set('Cache-Control', 'no-store');
  if (!referralsEnabled()) {
    response.status(404).json({ error: 'Referral rewards are not available.' });
    return;
  }
  const manualClaim = Object.prototype.hasOwnProperty.call(request.body || {}, 'code');
  const submittedCode = typeof request.body?.code === 'string' ? request.body.code.trim().toUpperCase() : '';
  try {
    const { auth, db } = await getFirebaseAdmin();
    const firebaseUser = await auth.getUser(request.user.uid);
    const createdAt = Date.parse(firebaseUser.metadata?.creationTime || '');
    const now = Date.now();
    const mappingRef = db.doc(`referralByUser/${request.user.uid}`);
    const existingMapping = await mappingRef.get();
    if (existingMapping.exists) {
      if (manualClaim) {
        response.status(409).json({ error: 'A referral code has already been used by this account.' });
        return;
      }
      response.set('Set-Cookie', `resumeout_referral=; ${referralCookieOptions().replace(/Max-Age=\d+/, 'Max-Age=0')}`);
      response.json({ registered: false, alreadyRegistered: true });
      return;
    }
    let attributionId = referralCookieId(request);
    if (manualClaim) {
      if (!validReferralCode(submittedCode)) {
        response.status(400).json({ error: 'Enter a valid referral code.' });
        return;
      }
      const expiresAt = createdAt + REFERRAL_CONFIG.attributionWindowDays * 86_400_000;
      if (!Number.isFinite(createdAt) || createdAt > now || now > expiresAt) {
        response.status(403).json({ error: 'Referral codes can only be used within 30 days of creating your account.' });
        return;
      }
      const codeSnapshot = await db.doc(`referralCodes/${submittedCode}`).get();
      const code = codeSnapshot.data();
      if (!codeSnapshot.exists || code?.active !== true) {
        response.status(404).json({ error: 'That referral code is invalid or inactive.' });
        return;
      }
      if (code.referrerUid === request.user.uid) {
        response.status(400).json({ error: 'You cannot use your own referral code.' });
        return;
      }
      attributionId = `manual-${Buffer.from(request.user.uid).toString('base64url')}`;
      await db.doc(`referralAttributions/${attributionId}`).set({
        referralCode: submittedCode,
        referrerUid: code.referrerUid,
        createdAt,
        expiresAt,
        status: 'pending',
        source: 'manual_code',
        submittedAt: now
      });
    }
    if (!attributionId) {
      response.json({ registered: false, reason: 'no-attribution' });
      return;
    }
    const attributionRef = db.doc(`referralAttributions/${attributionId}`);
    const attributionSnapshot = await attributionRef.get();
    const attribution = attributionSnapshot.data() || {};
    if (!attributionSnapshot.exists || attribution.status !== 'pending'
      || Number(attribution.expiresAt) < now
      || !Number.isFinite(createdAt)
      || createdAt < Math.floor(Number(attribution.createdAt) / 1000) * 1000
      || createdAt > Number(attribution.expiresAt)) {
      response.set('Set-Cookie', `resumeout_referral=; ${referralCookieOptions().replace(/Max-Age=\d+/, 'Max-Age=0')}`);
      response.json({ registered: false, reason: 'not-eligible' });
      return;
    }
    if (request.user.uid === attribution.referrerUid) {
      await attributionRef.set({ status: 'rejected', rejectionReason: 'self-referral', reviewedAt: now }, { merge: true });
      response.set('Set-Cookie', `resumeout_referral=; ${referralCookieOptions().replace(/Max-Age=\d+/, 'Max-Age=0')}`);
      response.json({ registered: false, reason: 'self-referral' });
      return;
    }

    const referralId = randomUUID();
    const referralRef = db.doc(`referrals/${referralId}`);
    const referrerEntitlementRef = userEntitlementDocument(db, attribution.referrerUid);
    const referredEntitlementRef = userEntitlementDocument(db, request.user.uid);
    const referrerSummaryRef = db.doc(`referralUserSummaries/${attribution.referrerUid}`);
    const referredSummaryRef = db.doc(`referralUserSummaries/${request.user.uid}`);
    const codeRef = db.doc(`referralCodes/${attribution.referralCode}`);
    let alreadyRegistered = false;
    let pendingReview = false;
    await db.runTransaction(async transaction => {
      const [existingMapping, codeSnapshot, currentAttribution, referrerEntitlement, referredEntitlement, referrerSummary, referredSummary] = await Promise.all([
        transaction.get(mappingRef),
        transaction.get(codeRef),
        transaction.get(attributionRef),
        transaction.get(referrerEntitlementRef),
        transaction.get(referredEntitlementRef),
        transaction.get(referrerSummaryRef),
        transaction.get(referredSummaryRef)
      ]);
      if (existingMapping.exists) {
        alreadyRegistered = true;
        return;
      }
      if (!currentAttribution.exists || currentAttribution.data()?.status !== 'pending'
        || Number(currentAttribution.data()?.expiresAt) < now
        || currentAttribution.data()?.referralCode !== attribution.referralCode
        || !codeSnapshot.exists || codeSnapshot.data()?.active !== true
        || codeSnapshot.data()?.referrerUid !== attribution.referrerUid) {
        const error = new Error('This referral is no longer eligible.');
        error.code = 'REFERRAL_INELIGIBLE';
        throw error;
      }
      const referral = {
        referrerUid: attribution.referrerUid,
        referredUid: request.user.uid,
        referralCode: attribution.referralCode,
        referredIdentity: maskReferralIdentity(firebaseUser.email),
        status: Number(codeSnapshot.data()?.registrationCount) >= REFERRAL_CONFIG.registrationReviewThreshold - 1
          ? 'pending_review'
          : 'registered',
        createdAt: now,
        registeredAt: now,
        attributionCreatedAt: Number(currentAttribution.data()?.createdAt) || now,
        attributionExpiresAt: Number(currentAttribution.data()?.expiresAt) || now,
        registrationRewardStatus: Number(codeSnapshot.data()?.registrationCount) >= REFERRAL_CONFIG.registrationReviewThreshold - 1
          ? 'pending_review'
          : 'issued',
        firstQualifyingPaymentId: null,
        firstQualifyingSubscriptionId: null,
        firstQualifyingPlanKey: null,
        paidConversionRewardStatus: 'not_eligible',
        paidConversionRewardDays: 0,
        riskFlags: Number(codeSnapshot.data()?.registrationCount) >= REFERRAL_CONFIG.registrationReviewThreshold - 1
          ? ['high-volume-code']
          : [],
        updatedAt: now
      };
      const needsReview = referral.status === 'pending_review';
      pendingReview = needsReview;
      const rewardDefinitions = [
        {
          uid: attribution.referrerUid,
          type: 'registration',
          role: 'referrer',
          entitlement: referrerEntitlement.data() || {},
          summary: referrerSummary.data() || {}
        },
        {
          uid: request.user.uid,
          type: 'registration',
          role: 'referred',
          entitlement: referredEntitlement.data() || {},
          summary: referredSummary.data() || {}
        }
      ];
      const rewards = needsReview ? [] : rewardDefinitions.map(item => {
        const startsAt = Math.max(
          now,
          Number(item.entitlement.validUntil) || 0,
          Number(item.summary.rewardStackUntil) || 0
        );
        const rewardId = `${referralId}_registration_${item.role}`;
        return {
          ref: db.doc(`referralRewards/${rewardId}`),
          uid: item.uid,
          summaryRef: item.role === 'referrer' ? referrerSummaryRef : referredSummaryRef,
          summary: item.summary,
          data: referralRewardRecord({
            rewardId,
            beneficiaryUid: item.uid,
            referralId,
            rewardType: 'registration',
            days: REFERRAL_CONFIG.registrationRewardDays,
            now,
            startsAt,
            idempotencyKey: `registration:${referralId}:${item.role}`
          })
        };
      });
      transaction.create(referralRef, referral);
      transaction.create(mappingRef, { referralId, createdAt: now });
      transaction.set(attributionRef, { status: 'attributed', referredUid: request.user.uid, referralId, registeredAt: now }, { merge: true });
      transaction.set(codeRef, {
        registrationCount: (Number(codeSnapshot.data()?.registrationCount) || 0) + 1,
        updatedAt: now
      }, { merge: true });
      for (const reward of rewards) {
        transaction.create(reward.ref, reward.data);
        transaction.set(reward.summaryRef, {
          rewardStackUntil: reward.data.expiresAt,
          registrationRewardDays: (Number(reward.summary.registrationRewardDays) || 0) + REFERRAL_CONFIG.registrationRewardDays,
          updatedAt: now
        }, { merge: true });
      }
    });
    response.set('Set-Cookie', `resumeout_referral=; ${referralCookieOptions().replace(/Max-Age=\d+/, 'Max-Age=0')}`);
    if (manualClaim && alreadyRegistered) {
      response.status(409).json({ error: 'A referral code has already been used by this account.' });
      return;
    }
    response.json(manualClaim
      ? { registered: !alreadyRegistered, alreadyRegistered, pendingReview }
      : { registered: !alreadyRegistered, alreadyRegistered });
  } catch (error) {
    if (error?.code === 'REFERRAL_INELIGIBLE') {
      response.status(409).json({ error: 'This referral is no longer eligible.' });
      return;
    }
    console.error('Could not process referral registration.', error);
    response.status(500).json({ error: 'Could not verify referral eligibility.' });
  }
});

app.get('/api/referrals/me', requireFirebaseUser, async (request, response) => {
  response.set('Cache-Control', 'no-store');
  if (!referralsEnabled()) {
    response.status(404).json({ error: 'Referral rewards are not available.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const userRef = db.doc(`referralUserCodes/${request.user.uid}`);
    let code;
    await db.runTransaction(async transaction => {
      const mapping = await transaction.get(userRef);
      if (mapping.exists) {
        code = mapping.data()?.code;
        return;
      }
      let candidate;
      let codeRef;
      let existing;
      do {
        candidate = generateReferralCode();
        codeRef = db.doc(`referralCodes/${candidate}`);
        existing = await transaction.get(codeRef);
      } while (existing.exists);
      const now = Date.now();
      transaction.create(codeRef, { referrerUid: request.user.uid, active: true, createdAt: now, updatedAt: now, codeVersion: 1 });
      transaction.create(userRef, { code: candidate, createdAt: now });
      code = candidate;
    });
    let summary = null;
    let referralCount = 0;
    let rewardCount = 0;
    let summaryError;
    try {
      const [referralSnapshot, rewardSnapshot] = await Promise.all([
        db.collection('referrals').where('referrerUid', '==', request.user.uid).get(),
        db.collection('referralRewards').where('beneficiaryUid', '==', request.user.uid).get()
      ]);
      const referrals = (referralSnapshot.docs || []).map(document => ({ id: document.id, ...document.data() }));
      const rewards = (rewardSnapshot.docs || []).map(document => ({ id: document.id, ...document.data() }));
      summary = calculateReferralSummary(referrals, rewards);
      referralCount = referrals.length;
      rewardCount = rewards.length;
    } catch (error) {
      console.error('Could not load referral summary.', error);
      summaryError = 'Your referral code is ready, but reward statistics could not be loaded.';
    }
    response.json({
      code,
      url: `${publicSiteOrigin()}/home.html?ref=${encodeURIComponent(code)}`,
      summary,
      referrals: referralCount,
      rewards: rewardCount,
      summaryError
    });
  } catch (error) {
    console.error('Could not load referral information.', error);
    response.status(500).json({ error: 'Could not load your referral information.' });
  }
});

async function loadReferralPage(collection, field, uid, request, response) {
  response.set('Cache-Control', 'no-store');
  if (!referralsEnabled()) {
    response.status(404).json({ error: 'Referral rewards are not available.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const size = referralPageSize(request.query.limit);
    const cursor = parseReferralCursor(request.query.cursor);
    const userQuery = db.collection(collection).where(field, '==', uid);
    let documents;
    let rewardDocuments = null;
    if (collection === 'referralRewards') {
      const snapshot = await userQuery.get();
      rewardDocuments = snapshot.docs || [];
      documents = sortReferralDocumentsForPage(rewardDocuments, cursor)
        .slice(0, size + 1);
    } else {
      try {
        let query = userQuery
          .orderBy('createdAt', 'desc')
          .orderBy('__name__', 'desc')
          .limit(size + 1);
        if (cursor) query = query.startAfter(cursor.createdAt, cursor.id);
        const snapshot = await query.get();
        documents = snapshot.docs || [];
      } catch (error) {
        if (!referralHistoryIndexUnavailable(error)) throw error;
        const snapshot = await userQuery.get();
        documents = sortReferralDocumentsForPage(snapshot.docs || [], cursor)
          .slice(0, size + 1);
        console.warn(`Using the fallback reader for ${collection}; its Firestore history index is unavailable.`);
      }
    }
    const hasMore = documents.length > size;
    const page = documents.slice(0, size);
    const reversalByRewardId = new Map();
    if (collection === 'referralRewards') {
      for (const rewardDocument of rewardDocuments || []) {
        const rewardData = rewardDocument.data() || {};
        if (rewardData.rewardType === 'reversal' && rewardData.originalRewardId) {
          reversalByRewardId.set(rewardData.originalRewardId, { id: rewardDocument.id, ...rewardData });
        }
      }
    }
    const items = page.map(document => {
      const data = document.data() || {};
      if (collection === 'referrals') {
        return {
          id: document.id,
          referredIdentity: data.referredIdentity || 'ResumeOut member',
          status: data.status,
          registrationStatus: data.registrationRewardStatus === 'issued' ? 'Registered' : data.status,
          createdAt: data.createdAt,
          registeredAt: data.registeredAt,
          qualifyingPlanType: data.firstQualifyingPlanKey,
          verifiedPaymentStatus: data.firstQualifyingPaymentId ? 'verified' : 'not-paid',
          conversionRewardDays: data.paidConversionRewardDays || 0,
          currentStatus: data.paidConversionRewardStatus || data.status
        };
      }
      const reversal = reversalByRewardId.get(document.id);
      const now = Date.now();
      return {
        id: document.id,
        rewardType: data.rewardType,
        rewardSource: data.rewardSource,
        description: data.rewardType === 'reversal'
          ? `Reward reversal: ${data.reason || 'verified provider event'}`
          : `${data.durationDays} promotional Pro days · ${data.rewardType}`,
        durationDays: data.durationDays,
        status: reversal
          ? 'revoked'
          : Number(data.expiresAt) <= now
            ? 'expired'
            : Number(data.startsAt) > now
              ? 'scheduled'
              : 'active',
        createdAt: data.createdAt,
        startsAt: data.startsAt,
        activatedAt: data.activatedAt,
        expiresAt: data.expiresAt,
        originalRewardId: data.originalRewardId || null,
        reversalReason: reversal?.reason || data.reason || null,
        reversalReference: reversal?.id || null
      };
    });
    response.json({ items, nextCursor: hasMore && page.length ? encodeReferralCursor(page.at(-1)) : null });
  } catch (error) {
    console.error(`Could not load referral ${collection}.`, error);
    response.status(500).json({
      error: collection === 'referrals'
        ? 'Could not load referral history.'
        : 'Could not load reward history.'
    });
  }
}

app.get('/api/referrals/history', requireFirebaseUser, (request, response) => (
  loadReferralPage('referrals', 'referrerUid', request.user.uid, request, response)
));

app.get('/api/referrals/rewards', requireFirebaseUser, (request, response) => (
  loadReferralPage('referralRewards', 'beneficiaryUid', request.user.uid, request, response)
));

app.get('/api/admin/referrals/summary', requireFirebaseUser, requireAdmin, async (_request, response) => {
  response.set('Cache-Control', 'no-store');
  if (!referralsEnabled()) {
    response.status(404).json({ error: 'Referral rewards are not available.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const [codes, referrals, rewards] = await Promise.all([
      db.collection('referralCodes').get(),
      db.collection('referrals').get(),
      db.collection('referralRewards').get()
    ]);
    const referralRows = (referrals.docs || []).map(document => document.data() || {});
    const rewardRows = (rewards.docs || []).map(document => document.data() || {});
    const successful = referralRows.filter(item => ['registered', 'payment_pending', 'converted', 'revoked'].includes(item.status));
    const monthly = successful.filter(item => item.firstQualifyingPlanKey === 'monthly' && item.firstQualifyingPaymentId).length;
    const yearly = successful.filter(item => item.firstQualifyingPlanKey === 'yearly' && item.firstQualifyingPaymentId).length;
    const issued = (type) => rewardRows.filter(item => item.rewardType === type).reduce((sum, item) => sum + (Number(item.durationDays) || 0), 0);
    const reversals = rewardRows.filter(item => item.rewardType === 'reversal').reduce((sum, item) => sum + (Number(item.durationDays) || 0), 0);
    response.json({
      metrics: {
        activeCodes: (codes.docs || []).filter(document => document.data()?.active === true).length,
        attributedRegistrations: successful.length,
        monthlyConversions: monthly,
        yearlyConversions: yearly,
        conversionRate: successful.length ? (monthly + yearly) / successful.length : 0,
        registrationRewardDaysIssued: issued('registration'),
        conversionRewardDaysIssued: issued('conversion'),
        daysRevoked: reversals,
        pendingReview: referralRows.filter(item => item.status === 'pending_review').length
      }
    });
  } catch (error) {
    console.error('Could not load admin referral metrics.', error);
    response.status(500).json({ error: 'Could not load referral metrics.' });
  }
});

app.get('/api/admin/referrals', requireFirebaseUser, requireAdmin, async (request, response) => {
  response.set('Cache-Control', 'no-store');
  if (!referralsEnabled()) {
    response.status(404).json({ error: 'Referral rewards are not available.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const limit = referralPageSize(request.query.limit);
    const cursor = parseReferralCursor(request.query.cursor);
    const snapshot = await db.collection('referrals').orderBy('createdAt', 'desc').limit(5000).get();
    let documents = (snapshot.docs || []).filter(document => {
      const data = document.data() || {};
      return (!request.query.status || request.query.status === 'all' || data.status === request.query.status)
        && (!request.query.search || `${data.referredIdentity || ''} ${data.referralCode || ''} ${document.id}`.toLowerCase().includes(String(request.query.search).toLowerCase()));
    });
    if (cursor) {
      const cursorIndex = documents.findIndex(document => document.id === cursor.id);
      documents = cursorIndex >= 0 ? documents.slice(cursorIndex + 1) : [];
    }
    const hasMore = documents.length > limit;
    documents = documents.slice(0, limit);
    const items = await Promise.all(documents.map(async document => {
      const data = document.data() || {};
      const code = data.referralCode
        ? await db.doc(`referralCodes/${data.referralCode}`).get()
        : null;
      return { id: document.id, ...data, codeActive: code?.data()?.active === true };
    }));
    response.json({
      items,
      nextCursor: hasMore && documents.length ? encodeReferralCursor(documents.at(-1)) : null
    });
  } catch (error) {
    console.error('Could not search admin referrals.', error);
    response.status(500).json({ error: 'Could not search referrals.' });
  }
});

app.get('/api/admin/referral-details/:referralId', requireFirebaseUser, requireAdmin, async (request, response) => {
  response.set('Cache-Control', 'no-store');
  if (!referralsEnabled()) {
    response.status(404).json({ error: 'Referral rewards are not available.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const referralRef = db.doc(`referrals/${request.params.referralId}`);
    const referral = await referralRef.get();
    if (!referral.exists) {
      response.status(404).json({ error: 'Referral not found.' });
      return;
    }
    const data = referral.data() || {};
    const [rewards, adminAudit, rewardEvents] = await Promise.all([
      db.collection('referralRewards').where('referralId', '==', request.params.referralId).get(),
      db.collection('referralAdminAudit').where('targetRecord', '==', request.params.referralId).get(),
      db.collection('referralRewardEvents').where('referralId', '==', request.params.referralId).get()
    ]);
    response.json({
      referral: { id: referral.id, ...data },
      rewards: (rewards.docs || []).map(document => ({ id: document.id, ...document.data() })),
      auditHistory: [
        ...(adminAudit.docs || []).map(document => ({ id: document.id, ...(document.data() || {}) })),
        ...(rewardEvents.docs || []).map(document => ({ id: document.id, ...(document.data() || {}) }))
      ].sort((left, right) => Number(left.timestamp || left.occurredAt) - Number(right.timestamp || right.occurredAt))
    });
  } catch (error) {
    console.error('Could not load admin referral details.', error);
    response.status(500).json({ error: 'Could not load referral details.' });
  }
});

app.post('/api/admin/referrals/:referralId/action', requireFirebaseUser, requireAdmin, async (request, response) => {
  response.set('Cache-Control', 'no-store');
  if (!referralsEnabled()) {
    response.status(404).json({ error: 'Referral rewards are not available.' });
    return;
  }
  const action = request.body?.action;
  const reason = typeof request.body?.reason === 'string' ? request.body.reason.trim().slice(0, 500) : '';
  if (!reason || !['approve', 'reject', 'reverse-conversion'].includes(action)) {
    response.status(400).json({ error: 'Choose a supported action and provide a reason.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const referralRef = db.doc(`referrals/${request.params.referralId}`);
    const auditRef = db.collection('referralAdminAudit').doc();
    const now = Date.now();
    await db.runTransaction(async transaction => {
      const referralSnapshot = await transaction.get(referralRef);
      if (!referralSnapshot.exists) {
        const missing = new Error('Referral not found.');
        missing.status = 404;
        throw missing;
      }
      const before = referralSnapshot.data() || {};
      if (action === 'approve' && before.status !== 'pending_review') {
        const invalid = new Error('Only referrals pending review can be approved.');
        invalid.status = 409;
        throw invalid;
      }
      if (action === 'reject' && before.status !== 'pending_review') {
        const invalid = new Error('Only referrals pending review can be rejected.');
        invalid.status = 409;
        throw invalid;
      }
      let after = { ...before, updatedAt: now, reviewedBy: request.user.uid, reviewReason: reason };
      if (action === 'approve') after.status = 'registered';
      if (action === 'reject') {
        after.status = 'rejected';
        after.registrationRewardStatus = 'rejected';
      }
      let registrationRewards = [];
      if (action === 'approve' && before.registrationRewardStatus === 'pending_review') {
        const referrerEntitlementRef = userEntitlementDocument(db, before.referrerUid);
        const referredEntitlementRef = userEntitlementDocument(db, before.referredUid);
        const referrerSummaryRef = db.doc(`referralUserSummaries/${before.referrerUid}`);
        const referredSummaryRef = db.doc(`referralUserSummaries/${before.referredUid}`);
        const [referrerEntitlement, referredEntitlement, referrerSummary, referredSummary] = await Promise.all([
          transaction.get(referrerEntitlementRef),
          transaction.get(referredEntitlementRef),
          transaction.get(referrerSummaryRef),
          transaction.get(referredSummaryRef)
        ]);
        registrationRewards = [
          {
            uid: before.referrerUid,
            role: 'referrer',
            entitlement: referrerEntitlement.data() || {},
            summaryRef: referrerSummaryRef,
            summary: referrerSummary.data() || {}
          },
          {
            uid: before.referredUid,
            role: 'referred',
            entitlement: referredEntitlement.data() || {},
            summaryRef: referredSummaryRef,
            summary: referredSummary.data() || {}
          }
        ].map(item => {
          const startsAt = Math.max(
            now,
            Number(item.entitlement.validUntil) || 0,
            Number(item.summary.rewardStackUntil) || 0
          );
          const rewardId = `${request.params.referralId}_registration_${item.role}`;
          return {
            ref: db.doc(`referralRewards/${rewardId}`),
            summaryRef: item.summaryRef,
            summary: item.summary,
            data: referralRewardRecord({
              rewardId,
              beneficiaryUid: item.uid,
              referralId: request.params.referralId,
              rewardType: 'registration',
              days: REFERRAL_CONFIG.registrationRewardDays,
              now,
              startsAt,
              idempotencyKey: `registration:${request.params.referralId}:${item.role}`
            })
          };
        });
        after.registrationRewardStatus = 'issued';
      }
      let reversal = null;
      if (action === 'reverse-conversion') {
        if (before.paidConversionRewardStatus !== 'issued' || !before.firstQualifyingPaymentId) {
          const invalid = new Error('There is no active paid-conversion reward to reverse.');
          invalid.status = 409;
          throw invalid;
        }
        const rewardRef = db.doc(`referralRewards/${request.params.referralId}_conversion`);
        const reversalRef = db.doc(`referralRewards/${request.params.referralId}_manual_reversal`);
        const [rewardSnapshot, reversalSnapshot] = await Promise.all([
          transaction.get(rewardRef),
          transaction.get(reversalRef)
        ]);
        if (!rewardSnapshot.exists || reversalSnapshot.exists || rewardSnapshot.data()?.status === 'revoked') {
          const invalid = new Error('The conversion reward is already unavailable.');
          invalid.status = 409;
          throw invalid;
        }
        const original = rewardSnapshot.data() || {};
        reversal = {
          ref: db.doc(`referralRewards/${request.params.referralId}_manual_reversal`),
          beneficiaryUid: original.beneficiaryUid,
          reward: original
        };
        after = {
          ...after,
          status: 'revoked',
          paidConversionRewardStatus: 'revoked',
          revokedAt: now,
          revocationReason: reason
        };
      }
      transaction.set(referralRef, after, { merge: true });
      for (const reward of registrationRewards) {
        transaction.create(reward.ref, reward.data);
        transaction.set(reward.summaryRef, {
          rewardStackUntil: reward.data.expiresAt,
          registrationRewardDays: (Number(reward.summary.registrationRewardDays) || 0) + REFERRAL_CONFIG.registrationRewardDays,
          updatedAt: now
        }, { merge: true });
      }
      if (reversal) {
        transaction.create(reversal.ref, {
          beneficiaryUid: reversal.beneficiaryUid,
          referralId: request.params.referralId,
          rewardSource: 'admin_manual',
          rewardType: 'reversal',
          originalRewardType: 'conversion',
          durationDays: reversal.reward.durationDays,
          status: 'revoked',
          createdAt: now,
          reason,
          originalRewardId: `${request.params.referralId}_conversion`,
          relatedPaymentId: before.firstQualifyingPaymentId,
          relatedSubscriptionId: before.firstQualifyingSubscriptionId,
          idempotencyKey: `admin-reversal:${request.params.referralId}`,
          configurationVersion: REFERRAL_CONFIG.version
        });
      }
      transaction.create(auditRef, {
        adminUid: request.user.uid,
        timestamp: now,
        action,
        targetRecord: request.params.referralId,
        reason,
        before,
        after
      });
    });
    response.json({ updated: true });
  } catch (error) {
    if (error?.status) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    console.error('Could not apply admin referral action.', error);
    response.status(500).json({ error: 'Could not update this referral.' });
  }
});

app.post('/api/admin/referrals/:referralId/adjustment', requireFirebaseUser, requireAdmin, async (request, response) => {
  response.set('Cache-Control', 'no-store');
  if (!referralsEnabled()) {
    response.status(404).json({ error: 'Referral rewards are not available.' });
    return;
  }
  const reason = typeof request.body?.reason === 'string' ? request.body.reason.trim().slice(0, 500) : '';
  const days = Number(request.body?.days);
  if (!reason || !Number.isInteger(days) || days < 1 || days > 3650) {
    response.status(400).json({ error: 'Provide a reason and a promotional adjustment of 1–3650 days.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const referralRef = db.doc(`referrals/${request.params.referralId}`);
    const adjustmentId = randomUUID();
    const auditRef = db.collection('referralAdminAudit').doc();
    const now = Date.now();
    await db.runTransaction(async transaction => {
      const referralSnapshot = await transaction.get(referralRef);
      if (!referralSnapshot.exists) {
        const missing = new Error('Referral not found.');
        missing.status = 404;
        throw missing;
      }
      const referral = referralSnapshot.data() || {};
      const beneficiaryUid = typeof request.body?.beneficiaryUid === 'string'
        && [referral.referrerUid, referral.referredUid].includes(request.body.beneficiaryUid)
        ? request.body.beneficiaryUid
        : referral.referrerUid;
      const summaryRef = db.doc(`referralUserSummaries/${beneficiaryUid}`);
      const entitlementRef = userEntitlementDocument(db, beneficiaryUid);
      const [summarySnapshot, entitlementSnapshot] = await Promise.all([
        transaction.get(summaryRef),
        transaction.get(entitlementRef)
      ]);
      const summary = summarySnapshot.data() || {};
      const entitlement = entitlementSnapshot.data() || {};
      const startsAt = Math.max(now, Number(entitlement.validUntil) || 0, Number(summary.rewardStackUntil) || 0);
      const rewardRef = db.doc(`referralRewards/${request.params.referralId}_manual_${adjustmentId}`);
      const reward = referralRewardRecord({
        rewardId: rewardRef.id,
        beneficiaryUid,
        referralId: request.params.referralId,
        rewardType: 'manual',
        days,
        now,
        startsAt,
        reason,
        idempotencyKey: `admin-adjustment:${adjustmentId}`
      });
      transaction.create(rewardRef, reward);
      transaction.set(summaryRef, {
        rewardStackUntil: reward.expiresAt,
        manualRewardDays: (Number(summary.manualRewardDays) || 0) + days,
        updatedAt: now
      }, { merge: true });
      transaction.create(auditRef, {
        adminUid: request.user.uid,
        timestamp: now,
        action: 'manual-promotional-adjustment',
        targetRecord: request.params.referralId,
        reason,
        beneficiaryUid,
        days,
        after: reward
      });
    });
    response.json({ updated: true });
  } catch (error) {
    response.status(error?.status || 500).json({ error: error?.status ? error.message : 'Could not issue the promotional adjustment.' });
  }
});

app.post('/api/admin/referrals/codes/:code/action', requireFirebaseUser, requireAdmin, async (request, response) => {
  response.set('Cache-Control', 'no-store');
  if (!referralsEnabled()) {
    response.status(404).json({ error: 'Referral rewards are not available.' });
    return;
  }
  const reason = typeof request.body?.reason === 'string' ? request.body.reason.trim().slice(0, 500) : '';
  if (!reason || typeof request.body?.active !== 'boolean') {
    response.status(400).json({ error: 'Provide the enabled state and a reason.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const codeRef = db.doc(`referralCodes/${request.params.code}`);
    const auditRef = db.collection('referralAdminAudit').doc();
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(codeRef);
      if (!snapshot.exists) {
        const missing = new Error('Referral code not found.');
        missing.status = 404;
        throw missing;
      }
      const before = snapshot.data() || {};
      const now = Date.now();
      const after = { ...before, active: request.body.active, updatedAt: now, codeVersion: (before.codeVersion || 1) + 1 };
      transaction.set(codeRef, after);
      transaction.create(auditRef, {
        adminUid: request.user.uid, timestamp: now, action: request.body.active ? 'enable-code' : 'disable-code',
        targetRecord: request.params.code, reason, before, after
      });
    });
    response.json({ updated: true });
  } catch (error) {
    response.status(error?.status || 500).json({ error: error?.status ? error.message : 'Could not update referral code.' });
  }
});

app.get('/api/admin/referrals/export.csv', requireFirebaseUser, requireAdmin, async (request, response) => {
  response.set('Cache-Control', 'no-store');
  if (!referralsEnabled()) {
    response.status(404).json({ error: 'Referral rewards are not available.' });
    return;
  }
  try {
    const { db } = await getFirebaseAdmin();
    const snapshot = await db.collection('referrals').orderBy('createdAt', 'desc').limit(5000).get();
    const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const rows = ['referral_id,masked_identity,status,created_at,plan,payment_id,reward_status,reward_days'];
    const documents = (snapshot.docs || []).filter(document => {
      const data = document.data() || {};
      return (!request.query.status || request.query.status === 'all' || data.status === request.query.status)
        && (!request.query.search || `${data.referredIdentity || ''} ${data.referralCode || ''} ${document.id}`.toLowerCase().includes(String(request.query.search).toLowerCase()));
    });
    for (const document of documents) {
      const data = document.data() || {};
      rows.push([
        document.id, data.referredIdentity, data.status, data.createdAt, data.firstQualifyingPlanKey,
        data.firstQualifyingPaymentId, data.paidConversionRewardStatus, data.paidConversionRewardDays
      ].map(quote).join(','));
    }
    response.type('text/csv').set('Content-Disposition', 'attachment; filename="referrals.csv"').send(rows.join('\r\n'));
  } catch (error) {
    console.error('Could not export referrals.', error);
    response.status(500).json({ error: 'Could not export referral data.' });
  }
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
    const referralReversalEvent = ['payment.refunded', 'payment.dispute.lost'].includes(event.event);
    if (referralReversalEvent && referralsEnabled()) {
      const eventPaymentId = typeof payment?.id === 'string' && /^pay_[A-Za-z0-9]+$/.test(payment.id)
        ? payment.id
        : typeof event.payload?.dispute?.entity?.payment_id === 'string'
          && /^pay_[A-Za-z0-9]+$/.test(event.payload.dispute.entity.payment_id)
          ? event.payload.dispute.entity.payment_id
          : null;
      if (typeof eventId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(eventId) || !eventPaymentId) {
        response.status(200).json({ received: true });
        return;
      }
      try {
        const { db } = await getFirebaseAdmin();
        const eventRef = db.collection('billingWebhookEvents').doc(eventId);
        const existingEvent = await eventRef.get();
        if (existingEvent.exists) {
          response.json({ received: true });
          return;
        }
        let providerState;
        if (event.event === 'payment.refunded') {
          const providerPayment = await razorpayRequest(`/payments/${encodeURIComponent(eventPaymentId)}`);
          if (providerPayment.id !== eventPaymentId || providerPayment.status !== 'refunded') {
            response.status(200).json({ received: true });
            return;
          }
          providerState = { type: 'payment', id: providerPayment.id, status: providerPayment.status };
        } else {
          const dispute = event.payload?.dispute?.entity;
          const disputeId = typeof dispute?.id === 'string' && /^disp_[A-Za-z0-9]+$/.test(dispute.id) ? dispute.id : '';
          if (!disputeId) {
            response.status(200).json({ received: true });
            return;
          }
          const verifiedDispute = await razorpayRequest(`/disputes/${encodeURIComponent(disputeId)}`);
          if (verifiedDispute.id !== disputeId
            || verifiedDispute.payment_id !== eventPaymentId
            || verifiedDispute.status !== 'lost') {
            response.status(200).json({ received: true });
            return;
          }
          providerState = { type: 'dispute', id: disputeId, status: verifiedDispute.status };
        }
        const referrals = await db.collection('referrals')
          .where('firstQualifyingPaymentId', '==', eventPaymentId)
          .get();
        for (const referral of referrals.docs || []) {
          await revokeReferralConversion(db, {
            referralId: referral.id,
            reason: event.event === 'payment.refunded' ? 'verified-refund' : 'verified-chargeback',
            eventReference: eventId,
            providerState,
            relatedPaymentId: eventPaymentId,
            relatedSubscriptionId: referral.data()?.firstQualifyingSubscriptionId || null
          });
        }
        const reversalMarkerRef = db.doc(`referralPaymentReversals/${eventPaymentId}`);
        const receivedAt = Date.now();
        await db.runTransaction(async transaction => {
          const [eventSnapshot, markerSnapshot] = await Promise.all([
            transaction.get(eventRef),
            transaction.get(reversalMarkerRef)
          ]);
          if (eventSnapshot.exists) return;
          if (!markerSnapshot.exists) {
            transaction.create(reversalMarkerRef, {
              paymentId: eventPaymentId,
              event: event.event,
              providerState,
              providerEventReference: eventId,
              confirmedAt: receivedAt
            });
          }
          transaction.create(eventRef, {
            event: event.event,
            paymentId: eventPaymentId,
            providerState,
            receivedAt
          });
        });
        response.json({ received: true });
      } catch (error) {
        console.error('Could not process Razorpay referral reversal event.', error);
        response.status(500).json({ error: 'Webhook processing failed.' });
      }
      return;
    }
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
      const subscriptionRef = subscriptionDocument(db, subscriptionId);
      const eventPaymentId = typeof payment?.id === 'string' && /^pay_[A-Za-z0-9]+$/.test(payment.id)
        ? payment.id
        : null;
      let verifiedCapturedPayment = false;
      if (referralsEnabled()
        && event.event === 'subscription.charged'
        && payment?.status === 'captured'
        && eventPaymentId
        && payment.subscription_id === subscriptionId) {
        const [providerPayment, providerSubscription] = await Promise.all([
          razorpayRequest(`/payments/${encodeURIComponent(eventPaymentId)}`),
          razorpayRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`)
        ]);
        const providerSubscriptionEnd = Number(providerSubscription.current_end) * 1000;
        const expectedProviderPlanId = mapping.pendingPlanId || mapping.planId;
        verifiedCapturedPayment = providerPayment.id === eventPaymentId
          && providerPayment.status === 'captured'
          && providerPayment.subscription_id === subscriptionId
          && providerPayment.amount === payment.amount
          && providerPayment.currency === payment.currency
          && providerSubscription.id === subscriptionId
          && providerSubscription.status === 'active'
          && providerSubscription.plan_id === subscription?.plan_id
          && providerSubscription.plan_id === expectedProviderPlanId
          && Number.isFinite(providerSubscriptionEnd)
          && providerSubscriptionEnd > Date.now();
      }
      let verifiedImmediateCancellation = null;
      if (referralsEnabled() && ['subscription.cancelled', 'subscription.completed', 'subscription.expired'].includes(event.event)) {
        try {
          const providerSubscription = await razorpayRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
          const providerEnd = Number(providerSubscription.current_end) * 1000;
          if (providerSubscription.id === subscriptionId
            && ['cancelled', 'completed', 'expired'].includes(providerSubscription.status)
            && Number.isFinite(providerEnd)
            && providerEnd <= Date.now()) {
            verifiedImmediateCancellation = {
              providerState: { type: 'subscription', id: subscriptionId, status: providerSubscription.status },
              eventReference: eventId
            };
          }
        } catch (error) {
          console.error('Could not verify provider state for referral cancellation handling.', error);
        }
      }
      await db.runTransaction(async transaction => {
        const duplicate = await transaction.get(eventRef);
        if (duplicate.exists) return;

        const [currentEntitlement, currentCheckout, currentSubscription] = await Promise.all([
          transaction.get(entitlementRef),
          transaction.get(checkoutRef),
          transaction.get(subscriptionRef)
        ]);
        const currentMapping = currentSubscription.data() || mapping;
        const entitlementData = currentEntitlement.data() || {};
        const revokedBeforeThisSubscription = entitlementData.adminRevoked === true
          && (!Number(entitlementData.adminRevokedAt)
            || Number(currentMapping.createdAt) <= Number(entitlementData.adminRevokedAt));
        const subscriptionRevoked = currentMapping.adminRevoked === true || revokedBeforeThisSubscription;
        const deferredStartPending = Number(currentMapping.scheduledStartAt) > Date.now();
        const validUntil = Number(subscription?.current_end) * 1000
          || (deferredStartPending ? 0 : Number(entitlementData.validUntil))
          || 0;
        const isPaidThrough = validUntil > Date.now();
        const activated = !deferredStartPending
          && ['subscription.activated', 'subscription.charged'].includes(event.event);
        const pendingPlanMatches = subscription?.plan_id === currentMapping.pendingPlanId;
        const currentPlanMatches = subscription?.plan_id === currentMapping.planId;
        const providerPlanKey = pendingPlanMatches
          ? currentMapping.pendingPlanKey
          : currentPlanMatches
            ? currentMapping.planKey
            : planKeyForRazorpayPlanId(subscription?.plan_id);
        const providerCurrency = pendingPlanMatches
          ? currentMapping.pendingCurrency
          : currentPlanMatches
            ? currentMapping.currency || 'INR'
            : currencyForRazorpayPlanId(subscription?.plan_id);
        const planChangeApplied = event.event === 'subscription.charged'
          && providerPlanKey
          && (pendingPlanMatches || providerPlanKey !== currentMapping.planKey || providerCurrency !== (currentMapping.currency || 'INR'));
        const planChangeCancelled = ['subscription.cancelled', 'subscription.completed', 'subscription.expired'].includes(event.event)
          && !isPaidThrough;
        const billingPlanKey = planChangeApplied ? providerPlanKey : currentMapping.planKey;
        const billingCurrency = planChangeApplied ? providerCurrency : currentMapping.currency || providerCurrency || 'INR';
        const scheduledPlan = planChangeApplied || planChangeCancelled ? null : currentMapping.pendingPlanKey || null;
        const scheduledAt = scheduledPlan ? Number(currentMapping.scheduledAt) || null : null;
        let conversionReward = null;
        const conversionDays = event.event === 'subscription.charged'
          && verifiedCapturedPayment
          && payment?.status === 'captured'
          && eventPaymentId
          && payment.subscription_id === subscriptionId
          && Number.isSafeInteger(payment.amount)
          && payment.amount > 0
          && isPaidThrough
          ? referralRewardDays(billingPlanKey)
          : 0;
        if (conversionDays > 0 && currentMapping.uid) {
          const [referralMatches, paymentReversal] = await Promise.all([
            transaction.get(db.collection('referrals').where('referredUid', '==', currentMapping.uid)),
            transaction.get(db.doc(`referralPaymentReversals/${eventPaymentId}`))
          ]);
          const eligibleReferral = (referralMatches.docs || []).find(document => {
            const data = document.data() || {};
            return data.status !== 'rejected'
              && !data.firstQualifyingPaymentId
              && ['registered', 'payment_pending'].includes(data.status);
          });
          if (eligibleReferral && !paymentReversal.exists) {
            const referralData = eligibleReferral.data() || {};
            const referrerSummaryRef = db.doc(`referralUserSummaries/${referralData.referrerUid}`);
            const referrerEntitlementRef = userEntitlementDocument(db, referralData.referrerUid);
            const [summarySnapshot, entitlementSnapshot] = await Promise.all([
              transaction.get(referrerSummaryRef),
              transaction.get(referrerEntitlementRef)
            ]);
            const now = Date.now();
            const startsAt = Math.max(
              now,
              Number(entitlementSnapshot.data()?.validUntil) || 0,
              Number(summarySnapshot.data()?.rewardStackUntil) || 0
            );
            const rewardId = `${eligibleReferral.id}_conversion`;
            conversionReward = {
              referralRef: eligibleReferral.ref,
              referralData,
              summaryRef: referrerSummaryRef,
              summary: summarySnapshot.data() || {},
              rewardRef: db.doc(`referralRewards/${rewardId}`),
              reward: referralRewardRecord({
                rewardId,
                beneficiaryUid: referralData.referrerUid,
                referralId: eligibleReferral.id,
                rewardType: 'conversion',
                days: conversionDays,
                now,
                startsAt,
                planKey: billingPlanKey,
                paymentId: eventPaymentId,
                subscriptionId,
                idempotencyKey: `conversion:${eligibleReferral.id}:${eventPaymentId}`
              })
            };
          }
        }
        const entitlement = deferredStartPending
          ? null
          : subscriptionRevoked
          ? {
              planId: 'free',
              billingPlan: 'free',
              status: 'inactive',
              source: 'server-verified',
              lifetime: false,
              validUntil: 0
            }
          : activated
          ? entitlementFromSubscription(subscription, billingPlanKey)
          : isPaidThrough
            ? {
                planId: 'pro',
                billingPlan: billingPlanKey,
                status: 'active',
                source: 'server-verified',
                lifetime: false,
                validUntil
              }
            : {
                planId: 'free',
                billingPlan: currentMapping.planKey,
                status: 'inactive',
                source: 'server-verified',
                lifetime: false,
                validUntil: 0
              };
        if (entitlement && !subscriptionRevoked) {
          entitlement.billingPlan = billingPlanKey;
          entitlement.currency = billingCurrency;
          entitlement.scheduledPlan = scheduledPlan;
          entitlement.scheduledAt = scheduledAt;
          entitlement.subscriptionId = subscriptionId;
          entitlement.cancelAtCycleEnd = event.event === 'subscription.cancelled'
            ||             entitlementData.cancelAtCycleEnd === true
            || currentMapping.cancelAtCycleEnd === true;
        } else if (entitlement) {
          entitlement.planId = 'free';
          entitlement.billingPlan = 'free';
          entitlement.status = 'inactive';
          entitlement.source = 'server-verified';
          entitlement.lifetime = false;
          entitlement.validUntil = 0;
          entitlement.adminRevoked = true;
          entitlement.adminRevokedAt = entitlementData.adminRevokedAt || Date.now();
          entitlement.subscriptionId = null;
          entitlement.cancelAtCycleEnd = false;
          entitlement.scheduledPlan = null;
          entitlement.scheduledAt = null;
          entitlement.pendingVouchers = [];
        }

        transaction.create(eventRef, { event: event.event, subscriptionId, receivedAt: Date.now() });
        if (conversionReward) {
          transaction.create(conversionReward.rewardRef, conversionReward.reward);
          transaction.set(conversionReward.referralRef, {
            status: 'converted',
            firstQualifyingPaymentId: eventPaymentId,
            firstQualifyingSubscriptionId: subscriptionId,
            firstQualifyingPlanKey: billingPlanKey,
            paidConversionRewardStatus: 'issued',
            paidConversionRewardDays: conversionDays,
            paidAt: Number(payment.created_at) > 0 ? Number(payment.created_at) * 1000 : Date.now(),
            rewardedAt: Date.now(),
            updatedAt: Date.now()
          }, { merge: true });
          transaction.set(conversionReward.summaryRef, {
            rewardStackUntil: conversionReward.reward.expiresAt,
            conversionRewardDays: (Number(conversionReward.summary.conversionRewardDays) || 0) + conversionDays,
            updatedAt: Date.now()
          }, { merge: true });
        }
        if (payment?.status === 'captured'
          && eventPaymentId
          && payment.subscription_id === subscriptionId
          && Number.isSafeInteger(payment.amount) && payment.amount > 0) {
          const paymentCreatedAt = Number(payment.created_at) > 0
            ? Number(payment.created_at) * 1000
            : Date.now();
          transaction.set(db.doc(`billingPayments/${payment.id}`), {
            uid: currentMapping.uid,
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
            uid: currentMapping.uid,
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
          status: subscriptionRevoked ? 'cancelled' : subscription?.status || event.event.replace('subscription.', ''),
          currentEnd: subscriptionRevoked ? 0 : validUntil,
          ...(subscriptionRevoked ? { adminRevoked: true } : {}),
          ...(planChangeApplied ? {
            planKey: billingPlanKey,
            currency: billingCurrency,
            planId: subscription.plan_id,
            amount: Number.isSafeInteger(currentMapping.pendingPlanAmount)
              ? currentMapping.pendingPlanAmount
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
        const nextEntitlement = deferredStartPending
          ? entitlementData
          : {
              ...(entitlement || {
                planId: 'free',
                billingPlan: currentMapping.planKey,
                status: 'inactive',
                source: 'server-verified',
                validUntil: 0
              }),
              pendingVouchers: subscriptionRevoked
                ? []
                : schedulePendingVouchers(
                    Array.isArray(currentEntitlement.data()?.pendingVouchers)
                      ? currentEntitlement.data().pendingVouchers
                      : [],
                    Number(entitlement?.validUntil) || 0
                  )
            };
        if (subscriptionRevoked && !deferredStartPending) {
          nextEntitlement.adminRevoked = true;
          nextEntitlement.adminRevokedAt = entitlementData.adminRevokedAt || Date.now();
          nextEntitlement.planId = 'free';
          nextEntitlement.billingPlan = 'free';
          nextEntitlement.status = 'inactive';
          nextEntitlement.validUntil = 0;
          nextEntitlement.subscriptionId = null;
          nextEntitlement.cancelAtCycleEnd = false;
          nextEntitlement.scheduledPlan = null;
          nextEntitlement.scheduledAt = null;
        } else if (!deferredStartPending) {
          nextEntitlement.adminRevoked = false;
        }
        transaction.set(entitlementRef, activatePendingVouchers(nextEntitlement) || nextEntitlement);
        if (currentCheckout.data()?.subscriptionId === subscriptionId) {
          if (['subscription.completed', 'subscription.expired'].includes(event.event) && !isPaidThrough) {
            transaction.delete(checkoutRef);
          } else {
            transaction.set(checkoutRef, {
              status: subscriptionRevoked ? 'cancelled' : event.event.replace('subscription.', ''),
              currentEnd: subscriptionRevoked ? 0 : validUntil,
              cancelAtCycleEnd: subscriptionRevoked ? false : currentCheckout.data()?.cancelAtCycleEnd || false,
              planKey: billingPlanKey,
              currency: billingCurrency,
              scheduledPlan: subscriptionRevoked ? null : scheduledPlan,
              scheduledAt: subscriptionRevoked ? null : scheduledAt,
              planChangeStatus: scheduledPlan ? currentMapping.pendingPlanStatus || 'scheduled' : null,
              updatedAt: Date.now()
            }, { merge: true });
          }
        }
      });
      if (verifiedImmediateCancellation) {
        const referrals = await db.collection('referrals')
          .where('firstQualifyingSubscriptionId', '==', subscriptionId)
          .get();
        for (const referral of referrals.docs || []) {
          await revokeReferralConversion(db, {
            referralId: referral.id,
            reason: 'verified-immediate-cancellation',
            eventReference: verifiedImmediateCancellation.eventReference,
            providerState: verifiedImmediateCancellation.providerState,
            relatedPaymentId: referral.data()?.firstQualifyingPaymentId || null,
            relatedSubscriptionId: subscriptionId
          });
        }
      }
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
    if (data.lifetime !== true && Array.isArray(data.pendingVouchers) && Number(data.validUntil) <= Date.now()) {
      await db.runTransaction(async transaction => {
        const currentSnapshot = await transaction.get(entitlementRef);
        const current = currentSnapshot.data() || {};
        data = activatePendingVouchers(current) || current;
        if (data !== current) transaction.set(entitlementRef, data);
      });
    }
    if (data.billingPlan !== 'voucher'
      && !(data.source === 'admin' && publicEntitlement(data).status === 'active')) {
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
      const mappingRevoked = mapping.adminRevoked === true
        || data.adminRevoked === true
          && (!Number(mapping.createdAt) || Number(mapping.createdAt) <= Number(data.adminRevokedAt));
      if (mappingSnapshot?.exists
        && mapping.uid === request.user.uid
        && mappingRevoked) {
        data = {
          ...data,
          planId: 'free',
          billingPlan: 'free',
          status: 'inactive',
          source: 'server-verified',
          lifetime: false,
          validUntil: null,
          subscriptionId: null,
          adminRevoked: true,
          adminRevokedAt: Number(mapping.adminRevokedAt) || Number(data.adminRevokedAt) || Date.now(),
          cancelAtCycleEnd: false,
          scheduledPlan: null,
          scheduledAt: null,
          pendingVouchers: []
        };
        await entitlementRef.set(data, { merge: true });
        await userCheckoutDocument(db, request.user.uid).set({
          subscriptionId,
          status: 'cancelled',
          currentEnd: 0,
          cancelAtCycleEnd: false,
          updatedAt: Date.now()
        }, { merge: true });
        if (mapping.adminRevoked !== true) {
          await subscriptionDocument(db, subscriptionId).set({
            adminRevoked: true,
            adminRevokedAt: data.adminRevokedAt || Date.now(),
            status: 'cancelled',
            currentEnd: 0,
            updatedAt: Date.now()
          }, { merge: true });
        }
      } else if (data.adminRevoked === true
        && (!mappingSnapshot?.exists || mapping.uid !== request.user.uid)) {
        data = {
          ...data,
          planId: 'free',
          billingPlan: 'free',
          status: 'inactive',
          source: 'server-verified',
          validUntil: null,
          subscriptionId: null,
          cancelAtCycleEnd: false,
          scheduledPlan: null,
          scheduledAt: null,
          pendingVouchers: []
        };
        await entitlementRef.set(data, { merge: true });
      }
      if (mappingSnapshot?.exists
        && mapping.uid === request.user.uid
        && !mappingRevoked
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
            lifetime: false,
            validUntil,
            subscriptionId,
            adminRevoked: false,
            cancelAtCycleEnd: providerStatus !== 'active'
              || data.cancelAtCycleEnd === true
              || mapping.cancelAtCycleEnd === true,
            updatedAt: Date.now()
          };
          await db.runTransaction(async transaction => {
            const [currentEntitlement, currentSubscription] = await Promise.all([
              transaction.get(entitlementRef),
              transaction.get(subscriptionDocument(db, subscriptionId))
            ]);
            const currentMapping = currentSubscription.data() || {};
            const currentData = currentEntitlement.data() || {};
            const currentRevocationApplies = currentData.adminRevoked === true
              && (!Number(currentMapping.createdAt)
                || Number(currentMapping.createdAt) <= Number(currentData.adminRevokedAt));
            if (currentMapping.uid !== request.user.uid
              || currentMapping.adminRevoked === true
              || currentRevocationApplies) {
              const revokedEntitlement = {
                ...(currentEntitlement.data() || {}),
                planId: 'free',
                billingPlan: 'free',
                status: 'inactive',
                source: 'server-verified',
                lifetime: false,
                validUntil: null,
                subscriptionId: null,
                adminRevoked: true,
                adminRevokedAt: Number(currentMapping.adminRevokedAt)
                  || Number(currentData.adminRevokedAt)
                  || Date.now(),
                cancelAtCycleEnd: false,
                scheduledPlan: null,
                scheduledAt: null,
                pendingVouchers: [],
                updatedAt: Date.now()
              };
              transaction.set(entitlementRef, revokedEntitlement);
              transaction.set(userCheckoutDocument(db, request.user.uid), {
                subscriptionId,
                status: 'cancelled',
                currentEnd: 0,
                cancelAtCycleEnd: false,
                updatedAt: Date.now()
              }, { merge: true });
              data = revokedEntitlement;
              return;
            }
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
            data = nextEntitlement;
          });
        } else if (data.adminRevoked === true) {
          data = {
            ...data,
            planId: 'free',
            billingPlan: 'free',
            status: 'inactive',
            source: 'server-verified',
            lifetime: false,
            validUntil: null,
            subscriptionId: null,
            cancelAtCycleEnd: false,
            scheduledPlan: null,
            scheduledAt: null,
            pendingVouchers: []
          };
          await entitlementRef.set(data, { merge: true });
        }
      } else if (data.adminRevoked === true) {
        data = {
          ...data,
          planId: 'free',
          billingPlan: 'free',
          status: 'inactive',
          source: 'server-verified',
          lifetime: false,
          validUntil: null,
          subscriptionId: null,
          cancelAtCycleEnd: false,
          scheduledPlan: null,
          scheduledAt: null,
          pendingVouchers: []
        };
        await entitlementRef.set(data, { merge: true });
      }
    }
    const entitlement = publicEntitlement(data);
    const now = Date.now();
    const checkoutSnapshot = await userCheckoutDocument(db, request.user.uid).get();
    const checkoutData = checkoutSnapshot.data() || {};
    if (!entitlement.subscriptionId && entitlement.billingPlan !== 'voucher') {
      const checkoutSubscriptionId = typeof checkoutData.subscriptionId === 'string'
        ? checkoutData.subscriptionId.trim()
        : '';
      if (checkoutSubscriptionId) entitlement.subscriptionId = checkoutSubscriptionId;
    }
    const scheduledStartAt = Number(checkoutData.scheduledStartAt) || 0;
    if (scheduledStartAt > now
      && !['cancelled', 'completed', 'expired'].includes(checkoutData.status)) {
      entitlement.pendingSubscriptionStartAt = scheduledStartAt;
      entitlement.pendingSubscriptionPrepaidStartsAt = Number(checkoutData.prepaidAccessStartsAt) || null;
      entitlement.pendingSubscriptionStatus = checkoutData.status || 'created';
      entitlement.pendingSubscriptionPlan = checkoutData.planKey || null;
    }
    const referralAccess = await referralPromotionalAccess(db, request.user.uid, now);
    if (referralAccess.promotionalValidUntil > 0) {
      const existingValidUntil = entitlement.lifetime ? 0 : Number(entitlement.validUntil) || 0;
      entitlement.promotionalValidUntil = referralAccess.promotionalValidUntil;
      entitlement.promotionalRewardCount = referralAccess.unexpiredRewards.length;
      const proIsCurrentlyActive = entitlement.planId === 'pro'
        && entitlement.status === 'active'
        && (entitlement.lifetime || existingValidUntil > now);
      if (referralAccess.activeRewards.length || proIsCurrentlyActive) {
        entitlement.planId = 'pro';
        entitlement.status = 'active';
        entitlement.validUntil = entitlement.lifetime
          ? null
          : Math.max(existingValidUntil, referralAccess.promotionalValidUntil);
      }
    }
    const activeStoredPro = hasActiveProEntitlement(data, now);
    const activePaidSubscription = activeStoredPro
      && (['monthly', 'yearly'].includes(data.billingPlan) || Boolean(data.subscriptionId));
    entitlement.canScheduleSubscriptionAfterPromotional = !activePaidSubscription
      && data.lifetime !== true
      && (activeStoredPro && data.billingPlan === 'voucher'
        || referralAccess.activeRewards.length > 0
          && data.source !== 'admin'
          && data.billingPlan !== 'admin');
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
          lifetime: generated.lifetime === true,
          assignedUid: generated.assignedUid || '',
          expiresAt: generated.createdAt ? Number(generated.createdAt) + 24 * 60 * 60 * 1000 : (generated.expiresAt || null)
        };
      }
    }
    const lifetime = voucher?.lifetime === true;
    if (!voucher || (!lifetime && (!Number.isInteger(voucher.durationDays) || voucher.durationDays < 1 || voucher.durationDays > 3650))
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
      if (hasActiveProEntitlement(currentEntitlement, now)) {
        const error = new Error('You cannot redeem a voucher while your account has active Pro access.');
        error.status = 409;
        throw error;
      }
      const pendingVouchers = Array.isArray(currentEntitlement.pendingVouchers)
        ? currentEntitlement.pendingVouchers
        : [];
      if (pendingVouchers.length) {
        const error = new Error('Redeem this voucher after your scheduled voucher access has ended.');
        error.status = 409;
        throw error;
      }
      queued = false;
      const redeemedCount = Math.max(
        Number(voucherSnapshot.data()?.redeemedCount) || 0,
        Number(adminVoucherSnapshot.data()?.redeemedCount) || 0
      );
      if (redeemedCount >= VOUCHER_MAX_REDEMPTIONS) {
        const error = new Error('That voucher has reached its redemption limit.');
        error.status = 409;
        throw error;
      }
      const validFrom = now;
      const validUntil = lifetime ? null : validFrom + voucher.durationDays * 24 * 60 * 60 * 1000;
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
        status: 'active',
        source: 'voucher',
        voucherId,
        lifetime,
        createdAt: now
      });
      transaction.set(entitlementRef, {
        planId: 'pro',
        billingPlan: 'voucher',
        status: 'active',
        source: 'server-verified',
        adminRevoked: false,
        adminRevokedAt: null,
        lifetime,
        validUntil,
        subscriptionId: null,
        cancelAtCycleEnd: false,
        voucherId,
        pendingVouchers: [],
        updatedAt: now
      });
    });
    const updatedEntitlement = (await entitlementRef.get()).data();
    response.json({
      entitlement: publicEntitlement(updatedEntitlement),
      queued
    });
    await recordBillingActivity(db, request.user.uid, {
      type: 'voucher', status: 'success', title: 'Pro voucher redeemed',
      detail: lifetime ? 'Voucher redeemed for lifetime Pro access.' : `Voucher redeemed for ${voucher.durationDays} days.`,
      planKey: 'voucher'
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
          users.push({ uid: record.uid, email: record.email || '', name: record.displayName || '', photoURL: record.photoURL || '', createdAt: record.metadata?.creationTime || null, disabled: record.disabled === true });
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
    let referralRewardDocuments = [];
    if (referralsEnabled()
      && typeof db.collection === 'function'
      && typeof db.collection('referralRewards').get === 'function') {
      const referralRewardsSnapshot = await db.collection('referralRewards').get();
      referralRewardDocuments = (referralRewardsSnapshot.docs || []).map(document => ({
        id: document.id,
        ...(document.data() || {})
      }));
    }
    const reversedReferralRewardIds = new Set(referralRewardDocuments
      .filter(reward => reward.rewardType === 'reversal')
      .map(reward => reward.originalRewardId)
      .filter(Boolean));
    const referralRewardsByUser = new Map();
    for (const reward of referralRewardDocuments) {
      const startsAt = Number(reward.startsAt);
      const expiresAt = Number(reward.expiresAt);
      if (reward.rewardSource !== 'referral'
        || reward.rewardType === 'reversal'
        || !['active', 'scheduled'].includes(reward.status)
        || reversedReferralRewardIds.has(reward.id)
        || !Number.isFinite(startsAt)
        || !Number.isFinite(expiresAt)
        || expiresAt <= now
        || expiresAt <= startsAt) continue;
      const userRewards = referralRewardsByUser.get(reward.beneficiaryUid) || [];
      userRewards.push(reward);
      referralRewardsByUser.set(reward.beneficiaryUid, userRewards);
    }
    const enriched = await Promise.all(users.map(async user => {
      const snapshot = await db.doc(`users/${user.uid}/billing/entitlement`).get();
      const entitlement = snapshot.exists
        ? await adminEntitlementWithVoucherMetadata(db, user.uid, snapshot.data())
        : null;
      const subscriptionId = await linkedSubscriptionId(db, user.uid, entitlement);
      const mappingSnapshot = subscriptionId
        ? await subscriptionDocument(db, subscriptionId).get()
        : null;
      const adminRevoked = adminRevocationApplies(user.uid, entitlement, mappingSnapshot?.data());
      const currentEntitlementActive = hasActiveProEntitlement(entitlement, now);
      const referralRewards = referralRewardsByUser.get(user.uid) || [];
      const activeReferralRewards = referralRewards.filter(reward => Number(reward.startsAt) <= now);
      const activeReferralReward = activeReferralRewards.length > 0;
      const active = !adminRevoked && (currentEntitlementActive || activeReferralReward);
      const referralExpiry = referralRewards.reduce((latest, reward) => (
        Math.max(latest, Number(reward.expiresAt) || 0)
      ), 0);
      const effectiveValidUntil = Math.max(
        entitlementValidUntil(entitlement) || 0,
        currentEntitlementActive || activeReferralReward ? referralExpiry : 0
      );
      const activePaymentPlan = currentEntitlementActive
        && ['monthly', 'yearly'].includes(entitlement?.billingPlan)
        && entitlement?.source !== 'admin';
      const hasAdminGrant = entitlement?.source === 'admin';
      const hasVoucherGrant = entitlement?.billingPlan === 'voucher';
      const activationSource = activePaymentPlan
        ? 'payment'
        : hasAdminGrant
          ? 'admin'
          : hasVoucherGrant
            ? 'voucher'
            : activeReferralReward && active
              ? 'referral'
              : active
                ? 'payment'
                : null;
      const payments = paymentDocuments.filter(payment => payment.uid === user.uid && isRazorpayCapturedPayment(payment));
      const paidAmountByCurrency = payments.reduce((amounts, payment) => {
        const currency = payment.currency || 'INR';
        amounts[currency] = (amounts[currency] || 0) + (Number(payment.amount) || 0);
        return amounts;
      }, {});
      return {
        ...user,
        isPro: active,
        disabled: user.disabled === true,
        plan: active
          ? (activeReferralReward ? 'pro' : entitlement.planId || 'pro')
          : 'free',
        billingPlan: active
          ? activeReferralReward && !currentEntitlementActive
            ? 'referral'
            : entitlement.billingPlan || (activeReferralReward ? 'referral' : null)
          : null,
        activationSource,
        validUntil: entitlement?.lifetime === true
          ? null
          : effectiveValidUntil || null,
        lifetime: entitlement?.lifetime === true,
        subscriptionId: active && ['monthly', 'yearly'].includes(entitlement?.billingPlan)
          ? subscriptionId
          : null,
        cancelAtCycleEnd: entitlement?.cancelAtCycleEnd === true,
        paidAmount: paidAmountByCurrency.INR || 0,
        paidAmountByCurrency,
        paymentCount: payments.length
      };
    }));
    const proCount = enriched.filter(user => user.isPro).length;
    const paidPayments = paymentDocuments
      .filter(isRazorpayCapturedPayment)
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
    const pendingCancellationSnapshot = await db.collection(subscriptionCollection)
      .where('providerCancellationPending', '==', true)
      .get();
    const pendingSubscriptionCancellations = (pendingCancellationSnapshot.docs || []).map(document => {
      const mapping = document.data() || {};
      const user = userByUid.get(mapping.uid);
      return {
        subscriptionId: document.id,
        uid: mapping.uid || '',
        email: user?.email || '',
        name: user?.name || '',
        status: mapping.status || 'unknown'
      };
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
      monthlyPro: activePro.filter(user => user.billingPlan === 'monthly').length,
      yearlyPro: activePro.filter(user => user.billingPlan === 'yearly').length,
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
      pendingSubscriptionCancellations,
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
    const storedEntitlement = entitlementSnapshot.exists
      ? await adminEntitlementWithVoucherMetadata(db, uid, entitlementSnapshot.data())
      : null;
    const subscriptionId = await linkedSubscriptionId(db, uid, storedEntitlement);
    const subscriptionSnapshot = subscriptionId
      ? await subscriptionDocument(db, subscriptionId).get()
      : null;
    const isAdminRevoked = adminRevocationApplies(uid, storedEntitlement, subscriptionSnapshot?.data());
    const activePro = !isAdminRevoked && hasActiveProEntitlement(storedEntitlement);
    const entitlement = isAdminRevoked
      ? {
          ...storedEntitlement,
          planId: 'free',
          billingPlan: 'free',
          status: 'inactive',
          lifetime: false,
          validUntil: null,
          subscriptionId: null,
          cancelAtCycleEnd: false,
          scheduledPlan: null,
          scheduledAt: null
        }
      : storedEntitlement
        ? {
            ...storedEntitlement,
            status: activePro ? 'active' : 'inactive',
            validUntil: storedEntitlement.lifetime === true
              ? null
              : entitlementValidUntil(storedEntitlement) || null
          }
        : {};
    let payments = (paymentsSnapshot.docs || []).map(document => ({ id: document.id, ...(document.data() || {}) })).filter(payment => payment.uid === uid);
    const activity = (activitySnapshot.docs || []).map(document => ({ id: document.id, ...(document.data() || {}) })).sort((a, b) => Number(b.occurredAt || b.createdAt || 0) - Number(a.occurredAt || a.createdAt || 0));
    let accessHistory = (accessHistorySnapshot.docs || [])
      .map(document => ({ id: document.id, ...(document.data() || {}) }))
      .filter(record => record.uid === uid)
      .sort((left, right) => Number(right.createdAt) - Number(left.createdAt));
    if (entitlement?.subscriptionId && /^sub_[A-Za-z0-9]+$/.test(entitlement.subscriptionId)) {
      const mappingSnapshot = await subscriptionDocument(db, entitlement.subscriptionId).get();
      if (mappingSnapshot.exists && mappingSnapshot.data()?.uid === uid) {
        await reconcileSubscriptionInvoices(db, uid, entitlement.subscriptionId, mappingSnapshot.data());
        const [updatedPayments, updatedAccessHistory] = await Promise.all([
          db.collection('billingPayments').get(),
          db.collection('billingAccessHistory').get()
        ]);
        payments = (updatedPayments.docs || [])
          .map(document => ({ id: document.id, ...(document.data() || {}) }))
          .filter(payment => payment.uid === uid);
        accessHistory = (updatedAccessHistory.docs || [])
          .map(document => ({ id: document.id, ...(document.data() || {}) }))
          .filter(record => record.uid === uid)
          .sort((left, right) => Number(right.createdAt) - Number(left.createdAt));
      }
    }
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
      .filter(payment => isRazorpayCapturedPayment(payment))
      .reduce((amounts, payment) => {
        const currency = payment.currency || 'INR';
        amounts[currency] = (amounts[currency] || 0) + (Number(payment.amount) || 0);
        return amounts;
      }, {});
    const paidAmount = paidAmountByCurrency.INR || 0;
    response.json({
      uid, email: authRecord?.email || '', name: authRecord?.displayName || '', photoURL: authRecord?.photoURL || '', createdAt: authRecord?.metadata?.creationTime || null,
      disabled: authRecord?.disabled === true,
      isPro: activePro,
      subscriptionId: activePro
        && ['monthly', 'yearly'].includes(entitlement.billingPlan)
        ? subscriptionId
        : null,
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
      planId: 'pro', billingPlan: plan, status: 'active', source: 'admin', lifetime: false, validUntil,
      subscriptionId: null, adminRevoked: false, cancelAtCycleEnd: false, updatedAt: grantedAt
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
  const timing = request.body?.timing === 'period-end' ? 'period-end' : 'immediate';
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
    const subscriptionId = await linkedSubscriptionId(db, uid, entitlement);
    if (timing === 'period-end'
      && (!subscriptionId
        || entitlementValidUntil(entitlement) <= Date.now()
        || entitlement.planId !== 'pro'
        || entitlement.status !== 'active'
        || !['monthly', 'yearly'].includes(entitlement.billingPlan))) {
      response.status(400).json({ error: 'This account has no active paid subscription to cancel at period end.' });
      return;
    }
    let providerResult = null;
    let subscriptionRef = null;
    let subscriptionsToRevoke = [];
    if (subscriptionId) {
      subscriptionRef = subscriptionDocument(db, subscriptionId);
      const mapping = await subscriptionRef.get();
      if (mapping.exists && mapping.data()?.uid !== uid) {
        response.status(409).json({ error: 'The subscription is not linked to this account.' });
        return;
      }
      if (timing === 'period-end' && mapping.exists && mapping.data()?.pendingPlanStatus === 'scheduling') {
        response.status(409).json({ error: 'A plan change is being scheduled. Try again after it completes.' });
        return;
      }
      if (timing === 'period-end') {
        providerResult = await razorpayRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
          method: 'POST',
          body: { cancel_at_cycle_end: true }
        });
      }
    }
    if (timing === 'immediate') {
      const userSubscriptionSnapshot = await db.collection(subscriptionCollection)
        .where('uid', '==', uid)
        .get();
      subscriptionsToRevoke = (userSubscriptionSnapshot.docs || [])
        .filter(document => document.data()?.uid === uid)
        .map(document => ({
          id: document.id,
          ref: subscriptionDocument(db, document.id),
          mapping: document.data() || {}
        }));
      if (subscriptionId && !subscriptionsToRevoke.some(item => item.id === subscriptionId)) {
        subscriptionsToRevoke.push({
          id: subscriptionId,
          ref: subscriptionRef,
          mapping: {}
        });
      }
    }
    const cancelledAt = Date.now();
    const validUntil = entitlementValidUntil(entitlement);
    const periodEndCancellation = timing === 'period-end';
    const entitlementUpdate = periodEndCancellation
      ? {
          planId: 'pro', status: 'active', source: 'server-verified', lifetime: false,
          validUntil, cancelAtCycleEnd: true, updatedAt: cancelledAt
        }
      : {
          planId: 'free', billingPlan: 'free', status: 'inactive', source: 'admin', lifetime: false, validUntil: null,
          subscriptionId: null, adminRevoked: true, adminRevokedAt: cancelledAt,
          cancelAtCycleEnd: false, scheduledPlan: null, scheduledAt: null,
          planChangeStatus: null, pendingVouchers: [], updatedAt: cancelledAt
        };
    await db.runTransaction(async transaction => {
      transaction.set(entitlementRef, entitlementUpdate, { merge: true });
      if (periodEndCancellation && subscriptionRef) {
        transaction.set(subscriptionRef, {
          uid,
          status: providerResult?.status || 'active',
          cancelAtCycleEnd: true,
          currentEnd: validUntil,
          updatedAt: cancelledAt
        }, { merge: true });
      }
      if (!periodEndCancellation) {
        for (const subscription of subscriptionsToRevoke) {
          transaction.set(subscription.ref, {
            uid,
            status: 'cancelled',
            cancelAtCycleEnd: false,
            adminRevoked: true,
            adminRevokedAt: cancelledAt,
            currentEnd: 0,
            pendingPlanKey: null,
            pendingPlanId: null,
            pendingPlanAmount: null,
            pendingPlanStatus: null,
            planChangeRequestId: null,
            scheduledAt: null,
            updatedAt: cancelledAt
          }, { merge: true });
        }
        transaction.set(userCheckoutDocument(db, uid), {
          subscriptionId: subscriptionId || null,
          status: 'cancelled',
          currentEnd: 0,
          cancelAtCycleEnd: false,
          scheduledPlan: null,
          scheduledAt: null,
          updatedAt: cancelledAt
        }, { merge: true });
      }
    });
    const providerCancellationErrors = [];
    if (!periodEndCancellation) {
      for (const subscription of subscriptionsToRevoke) {
        if (['cancelled', 'completed', 'expired'].includes(String(subscription.mapping.status))) continue;
        try {
          providerResult = await razorpayRequest(`/subscriptions/${encodeURIComponent(subscription.id)}/cancel`, {
            method: 'POST',
            body: { cancel_at_cycle_end: false }
          });
          await subscription.ref.set({
            status: providerResult?.status || 'cancelled',
            providerCancellationPending: false,
            updatedAt: Date.now()
          }, { merge: true });
        } catch (error) {
          providerCancellationErrors.push(subscription.id);
          await subscription.ref.set({
            providerCancellationPending: true,
            providerCancellationError: String(error.message || 'Razorpay cancellation failed').slice(0, 500),
            updatedAt: Date.now()
          }, { merge: true });
        }
      }
    }
    await db.doc(`users/${uid}/billingActivity/${randomUUID()}`).set({
      type: periodEndCancellation ? 'subscription_cancel_scheduled' : 'pro_cancelled',
      status: periodEndCancellation ? 'scheduled' : 'cancelled',
      title: periodEndCancellation ? 'Subscription cancellation scheduled by admin' : 'Pro access cancelled by admin',
      detail: reason, reason, planKey: entitlement.billingPlan || 'pro',
      previousPlan: entitlement.billingPlan || 'pro', previousSource: entitlement.source || null,
      previousValidUntil: entitlement.validUntil || null, actorType: 'admin', actorUid: request.user.uid,
      cancelledBy: request.user.uid, cancelledByEmail: request.user.email || null,
      cancellationTiming: timing,
      accessThrough: periodEndCancellation ? validUntil : cancelledAt,
      createdAt: cancelledAt, occurredAt: cancelledAt
    });
    response.json({
      uid,
      isPro: periodEndCancellation && validUntil > Date.now(),
      timing,
      validUntil: periodEndCancellation ? validUntil : null,
      reason,
      cancelledAt,
      providerCancellationPending: providerCancellationErrors.length > 0
    });
    if (providerCancellationErrors.length) {
      response.status(502).json({
        error: 'Pro access was revoked immediately, but Razorpay could not cancel every linked subscription. Retry cancellation or contact support.',
        revoked: true,
        providerCancellationPending: providerCancellationErrors.length
      });
      return;
    }
  } catch (error) {
    console.error('Admin subscription cancellation failed.', error);
    response.status(error.status === 503 ? 503 : 502).json({ error: 'Unable to cancel the subscription. No Pro changes were applied; retry or contact support.' });
  }
});

async function adminTarget(uid, request, response) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid) || uid === request.user.uid) {
    response.status(400).json({ error: 'This account cannot be changed by this action.' });
    return null;
  }
  const { auth } = await getFirebaseAdmin();
  const target = await auth.getUser(uid);
  if (isAdminUser({ email: target.email })) {
    response.status(403).json({ error: 'Administrator accounts cannot be banned or deleted here.' });
    return null;
  }
  return { auth, target };
}

async function deleteAccountQueryDocuments(db, query, recursive = false) {
  const snapshot = await query.get();
  const documents = snapshot.docs || [];
  for (let index = 0; index < documents.length; index += 25) {
    await Promise.all(documents.slice(index, index + 25).map(document => (
      recursive
        ? db.recursiveDelete(document.ref)
        : document.ref.delete()
    )));
  }
}

async function deleteAccountFirestoreData(db, uid, subscriptionIds) {
  if (typeof db.recursiveDelete !== 'function') {
    throw new Error('Safe account data deletion is unavailable on this server.');
  }

  const ownedCollections = [
    ['billingPayments', 'uid'],
    ['billingAccessHistory', 'uid'],
    ['billingSubscriptions', 'uid'],
    ['sharedResumes', 'ownerUid'],
    ['forumActivity', 'userUid'],
    ['forumActivity', 'actorUid'],
    ['forumPosts', 'authorUid']
  ];
  for (const [collectionName, field] of ownedCollections) {
    const query = db.collection(collectionName).where(field, '==', uid);
    await deleteAccountQueryDocuments(db, query, collectionName === 'forumPosts');
  }

  if (typeof db.collectionGroup === 'function') {
    await deleteAccountQueryDocuments(db,
      db.collectionGroup('comments').where('authorUid', '==', uid)
    );
  }

  for (const subscriptionId of subscriptionIds) {
    await deleteAccountQueryDocuments(db,
      db.collection('billingWebhookEvents').where('subscriptionId', '==', subscriptionId)
    );
  }

  const assignedVouchers = await db.collection('adminVouchers').where('assignedUid', '==', uid).get();
  const redeemedVouchers = await db.collection('adminVouchers').where('redeemedByUid', '==', uid).get();
  const voucherDocuments = new Map(
    [...(assignedVouchers.docs || []), ...(redeemedVouchers.docs || [])]
      .map(document => [document.ref.path, document])
  );
  for (const voucherDocument of voucherDocuments.values()) {
    const voucher = voucherDocument.data() || {};
    const updatedVoucher = { ...voucher };
    if (updatedVoucher.assignedUid === uid) {
      updatedVoucher.assignedUid = '';
      updatedVoucher.assignedEmail = '';
    }
    if (updatedVoucher.redeemedByUid === uid) {
      delete updatedVoucher.redeemedByUid;
      delete updatedVoucher.redeemedByEmail;
    }
    await voucherDocument.ref.set(updatedVoucher);
  }
  await db.recursiveDelete(db.doc(`users/${uid}`));
}

app.post('/api/admin/subscriptions/:subscriptionId/retry-cancellation', requireFirebaseUser, requireAdmin, async (request, response) => {
  const subscriptionId = request.params.subscriptionId;
  if (!/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) {
    response.status(400).json({ error: 'The subscription ID is invalid.' });
    return;
  }
  try {
    const { auth, db } = await getFirebaseAdmin();
    const selectedRef = subscriptionDocument(db, subscriptionId);
    const selectedSnapshot = await selectedRef.get();
    const selectedMapping = selectedSnapshot.data() || {};
    if (!selectedSnapshot.exists || selectedMapping.providerCancellationPending !== true
      || typeof selectedMapping.uid !== 'string' || !selectedMapping.uid) {
      response.status(404).json({ error: 'No pending account subscription cancellation was found.' });
      return;
    }

    const uid = selectedMapping.uid;
    const subscriptionSnapshot = await db.collection(subscriptionCollection).where('uid', '==', uid).get();
    const subscriptions = new Map((subscriptionSnapshot.docs || []).map(document => [
      document.id,
      { ref: document.ref, ...(document.data() || {}) }
    ]));
    subscriptions.set(subscriptionId, { ref: selectedRef, ...selectedMapping });
    const cancellationErrors = [];
    for (const [linkedId, mapping] of subscriptions) {
      if (['cancelled', 'completed', 'expired'].includes(String(mapping.status))) continue;
      try {
        await razorpayRequest(`/subscriptions/${encodeURIComponent(linkedId)}/cancel`, {
          method: 'POST',
          body: { cancel_at_cycle_end: false }
        });
      } catch (error) {
        let providerAlreadyCancelled = false;
        try {
          const providerSubscription = await razorpayRequest(`/subscriptions/${encodeURIComponent(linkedId)}`);
          providerAlreadyCancelled = ['cancelled', 'completed', 'expired'].includes(String(providerSubscription?.status));
        } catch (statusError) {
          console.error('Could not verify Razorpay subscription status during cancellation retry.', {
            uid,
            subscriptionId: linkedId,
            error: statusError.message
          });
        }
        if (!providerAlreadyCancelled) cancellationErrors.push({ subscriptionId: linkedId, error });
      }
    }

    if (cancellationErrors.length) {
      for (const item of cancellationErrors) {
        const mapping = subscriptions.get(item.subscriptionId);
        await mapping.ref.set({
          providerCancellationPending: true,
          providerCancellationError: String(item.error.message || 'Razorpay cancellation failed').slice(0, 500),
          updatedAt: Date.now()
        }, { merge: true });
      }
      response.status(502).json({
        error: 'Razorpay could not cancel every linked subscription. Account data has not been deleted; retry later.',
        subscriptionCancellationPending: cancellationErrors.map(item => item.subscriptionId)
      });
      return;
    }

    let accountExists = true;
    try {
      await auth.getUser(uid);
    } catch (error) {
      if (error.code !== 'auth/user-not-found') throw error;
      accountExists = false;
    }
    if (!accountExists) {
      await deleteAccountFirestoreData(db, uid, new Set(subscriptions.keys()));
    } else {
      for (const [linkedId, mapping] of subscriptions) {
        await mapping.ref.set({
          status: 'cancelled',
          cancelAtCycleEnd: false,
          adminRevoked: true,
          providerCancellationPending: false,
          providerCancellationError: null,
          updatedAt: Date.now()
        }, { merge: true });
      }
    }
    response.json({
      uid,
      cancelled: true,
      accountDataDeleted: !accountExists
    });
  } catch (error) {
    console.error('Pending Razorpay cancellation retry failed.', error);
    response.status(500).json({ error: 'Could not complete the pending subscription cancellation. Retry or contact support.' });
  }
});

app.post('/api/admin/users/:uid/ban', requireFirebaseUser, requireAdmin, async (request, response) => {
  try {
    const target = await adminTarget(request.params.uid, request, response);
    if (!target) return;
    const { auth, target: user } = target;
    if (user.disabled) {
      response.json({ uid: user.uid, disabled: true });
      return;
    }
    const { db } = await getFirebaseAdmin();
    const entitlementRef = userEntitlementDocument(db, user.uid);
    const entitlementSnapshot = await entitlementRef.get();
    const entitlement = entitlementSnapshot.data() || {};
    const subscriptionId = await linkedSubscriptionId(db, user.uid, entitlement);
    let providerResult = null;
    let providerCancellationError = null;
    let mappingRef = null;
    if (subscriptionId) {
      mappingRef = subscriptionDocument(db, subscriptionId);
      const mapping = await mappingRef.get();
      if (mapping.exists && mapping.data()?.uid !== user.uid) {
        response.status(409).json({ error: 'The subscription is not linked to this account.' });
        return;
      }
      try {
        providerResult = await razorpayRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
          method: 'POST',
          body: { cancel_at_cycle_end: false }
        });
      } catch (error) {
        providerCancellationError = error;
        console.error('Razorpay cancellation failed while banning account.', {
          uid: user.uid,
          subscriptionId,
          error: error.message
        });
      }
      await mappingRef.set({
        uid: user.uid,
        status: providerResult?.status || (providerCancellationError ? 'cancellation_pending' : 'cancelled'),
        cancelAtCycleEnd: false,
        adminRevoked: true,
        providerCancellationPending: Boolean(providerCancellationError),
        ...(providerCancellationError
          ? { providerCancellationError: String(providerCancellationError.message || 'Razorpay cancellation failed').slice(0, 500) }
          : {}),
        updatedAt: Date.now()
      }, { merge: true });
    }
    const bannedAt = Date.now();
    await entitlementRef.set({
      planId: 'free', billingPlan: 'free', status: 'inactive', source: 'admin', lifetime: false,
      validUntil: null, subscriptionId: null, adminRevoked: true, adminRevokedAt: bannedAt,
      cancelAtCycleEnd: false, updatedAt: bannedAt
    }, { merge: true });
    await userCheckoutDocument(db, user.uid).set({
      subscriptionId: subscriptionId || null,
      status: providerResult?.status || (providerCancellationError ? 'cancellation_pending' : 'cancelled'),
      currentEnd: 0,
      cancelAtCycleEnd: false,
      updatedAt: bannedAt
    }, { merge: true });
    await auth.updateUser(user.uid, { disabled: true });
    await auth.revokeRefreshTokens(user.uid);
    await db.doc(`users/${user.uid}/adminStatus/current`).set({
      disabled: true, reason: String(request.body?.reason || '').trim().slice(0, 500),
      actorUid: request.user.uid, updatedAt: bannedAt
    }, { merge: true });
    await db.doc(`users/${user.uid}/billingActivity/${randomUUID()}`).set({
      type: 'account_banned', status: 'disabled', title: 'Account banned by admin',
      detail: String(request.body?.reason || '').trim(), actorType: 'admin', actorUid: request.user.uid,
      createdAt: bannedAt, occurredAt: bannedAt
    });
    response.json({
      uid: user.uid,
      disabled: true,
      isPro: false,
      subscriptionCancelled: Boolean(subscriptionId) && !providerCancellationError,
      subscriptionCancellationPending: Boolean(providerCancellationError),
      message: providerCancellationError
        ? 'The account was banned and Pro access was removed, but Razorpay could not cancel the subscription. Contact support to complete cancellation.'
        : undefined
    });
  } catch (error) {
    console.error('Admin account ban failed.', error);
    response.status(error.status === 503 ? 503 : 502).json({ error: 'Unable to ban this account. Retry or contact support.' });
  }
});

app.post('/api/admin/users/:uid/unban', requireFirebaseUser, requireAdmin, async (request, response) => {
  try {
    const target = await adminTarget(request.params.uid, request, response);
    if (!target) return;
    const { auth, target: user } = target;
    await auth.updateUser(user.uid, { disabled: false });
    const { db } = await getFirebaseAdmin();
    const updatedAt = Date.now();
    await db.doc(`users/${user.uid}/adminStatus/current`).set({
      disabled: false, actorUid: request.user.uid, updatedAt
    }, { merge: true });
    await db.doc(`users/${user.uid}/billingActivity/${randomUUID()}`).set({
      type: 'account_unbanned', status: 'enabled', title: 'Account unbanned by admin',
      actorType: 'admin', actorUid: request.user.uid, createdAt: updatedAt, occurredAt: updatedAt
    });
    response.json({ uid: user.uid, disabled: false });
  } catch (error) {
    console.error('Admin account unban failed.', error);
    response.status(500).json({ error: 'Unable to unban this account.' });
  }
});

app.delete('/api/admin/users/:uid', requireFirebaseUser, requireAdmin, async (request, response) => {
  try {
    const target = await adminTarget(request.params.uid, request, response);
    if (!target) return;
    const { auth, target: user } = target;
    const { db } = await getFirebaseAdmin();
    const entitlementRef = userEntitlementDocument(db, user.uid);
    const entitlementSnapshot = await entitlementRef.get();
    const subscriptionIds = new Set();
    const entitlementSubscriptionId = await linkedSubscriptionId(db, user.uid, entitlementSnapshot.data());
    if (entitlementSubscriptionId) subscriptionIds.add(entitlementSubscriptionId);
    const subscriptionsSnapshot = await db.collection(subscriptionCollection)
      .where('uid', '==', user.uid)
      .get();
    const subscriptions = new Map((subscriptionsSnapshot.docs || []).map(document => [
      document.id,
      { ref: document.ref, ...(document.data() || {}) }
    ]));
    for (const [subscriptionId, mapping] of subscriptions) {
      if (mapping.uid !== user.uid) {
        response.status(409).json({ error: 'The subscription is not linked to this account.' });
        return;
      }
      subscriptionIds.add(subscriptionId);
    }
    for (const subscriptionId of subscriptionIds) {
      if (subscriptions.has(subscriptionId)) continue;
      const mappingRef = subscriptionDocument(db, subscriptionId);
      const mappingSnapshot = await mappingRef.get();
      const mapping = mappingSnapshot.data() || {};
      if (mappingSnapshot.exists && mapping.uid !== user.uid) {
        response.status(409).json({ error: 'The subscription is not linked to this account.' });
        return;
      }
      subscriptions.set(subscriptionId, { ref: mappingRef, ...mapping });
    }

    const cancellationErrors = [];
    for (const subscriptionId of subscriptionIds) {
      const mapping = subscriptions.get(subscriptionId) || {};
      if (['cancelled', 'completed', 'expired'].includes(String(mapping.status))) continue;
      const mappingRef = mapping.ref || subscriptionDocument(db, subscriptionId);
      try {
        const providerResult = await razorpayRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
          method: 'POST',
          body: { cancel_at_cycle_end: false }
        });
        await mappingRef.set({
          uid: user.uid,
          status: providerResult?.status || 'cancelled',
          cancelAtCycleEnd: false,
          adminRevoked: true,
          providerCancellationPending: false,
          updatedAt: Date.now()
        }, { merge: true });
      } catch (error) {
        let providerAlreadyCancelled = false;
        try {
          const providerSubscription = await razorpayRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
          providerAlreadyCancelled = ['cancelled', 'completed', 'expired'].includes(String(providerSubscription?.status));
          if (providerAlreadyCancelled) {
            await mappingRef.set({
              uid: user.uid,
              status: providerSubscription.status,
              cancelAtCycleEnd: false,
              adminRevoked: true,
              providerCancellationPending: false,
              updatedAt: Date.now()
            }, { merge: true });
          }
        } catch (statusError) {
          console.error('Could not verify Razorpay subscription status during account deletion.', {
            uid: user.uid,
            subscriptionId,
            error: statusError.message
          });
        }
        if (!providerAlreadyCancelled) {
          cancellationErrors.push({ subscriptionId, error });
          await mappingRef.set({
            uid: user.uid,
            status: mapping.status || 'cancellation_pending',
            adminRevoked: true,
            providerCancellationPending: true,
            providerCancellationError: String(error.message || 'Razorpay cancellation failed').slice(0, 500),
            updatedAt: Date.now()
          }, { merge: true });
        }
      }
    }

    if (cancellationErrors.length) {
      response.status(502).json({
        error: 'The account was not deleted because Razorpay could not cancel every linked subscription. Retry deletion or contact support.',
        subscriptionCancellationPending: cancellationErrors.map(item => item.subscriptionId)
      });
      return;
    }

    await deleteAccountFirestoreData(db, user.uid, subscriptionIds);
    await auth.deleteUser(user.uid);
    response.json({ uid: user.uid, deleted: true });
  } catch (error) {
    console.error('Admin account deletion failed.', error);
    response.status(error.message === 'Safe account data deletion is unavailable on this server.' ? 503 : 500)
      .json({ error: error.message || 'Unable to delete this account. Retry or contact support.' });
  }
});

app.post('/api/admin/vouchers', requireFirebaseUser, requireAdmin, async (request, response) => {
  const durations = {
    '1-month': { durationDays: 30, durationLabel: '1 month', prefix: 'MONTH' },
    '3-months': { durationDays: 90, durationLabel: '3 months', prefix: '3MONTH' },
    '6-months': { durationDays: 180, durationLabel: '6 months', prefix: '6MONTH' },
    '1-year': { durationDays: 365, durationLabel: '1 year', prefix: 'YEAR' },
    lifetime: { durationDays: null, durationLabel: 'Lifetime', prefix: 'LIFETIME', lifetime: true }
  };
  const selectedDuration = durations[request.body?.duration];
  if (!selectedDuration) {
    response.status(400).json({ error: 'Choose a valid voucher duration.' });
    return;
  }
  const assignedUser = typeof request.body?.user === 'string'
    ? request.body.user.trim()
    : typeof request.body?.uid === 'string'
      ? request.body.uid.trim()
      : '';
  const { durationDays, durationLabel, prefix, lifetime = false } = selectedDuration;
  const code = `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
  try {
    const { auth, db } = await getFirebaseAdmin();
    let assignedUid = '';
    let assignedEmail = '';
    if (assignedUser) {
      try {
        const assignedAccount = assignedUser.includes('@')
          ? await auth.getUserByEmail(assignedUser)
          : await auth.getUser(assignedUser);
        assignedUid = assignedAccount.uid;
        assignedEmail = assignedAccount.email || '';
      } catch (error) {
        if (error.code === 'auth/invalid-email') {
          response.status(400).json({ error: 'Enter a valid Firebase UID or account email.' });
          return;
        }
        if (error.code === 'auth/user-not-found') {
          response.status(404).json({ error: 'No account was found for that Firebase UID or email.' });
          return;
        }
        throw error;
      }
    }
    const id = voucherDocumentId(code);
    const createdAt = Date.now();
    await db.doc(`adminVouchers/${id}`).set({
      code, duration: request.body.duration, durationLabel, durationDays, lifetime,
      maxRedemptions: VOUCHER_MAX_REDEMPTIONS, assignedUid, assignedEmail, redeemedCount: 0, createdAt,
      expiresAt: createdAt + 24 * 60 * 60 * 1000, createdBy: request.user.uid
    });
    response.status(201).json({ id, code, duration: request.body.duration, durationLabel, durationDays, lifetime, assignedUid, assignedEmail });
  } catch (error) {
    console.error('Admin voucher generation failed.', error);
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
    const now = Date.now();
    const referralAccess = await referralPromotionalAccess(db, request.user.uid, now);
    let checkout = await db.runTransaction(async transaction => {
      const [entitlementSnapshot, checkoutSnapshot] = await Promise.all([
        transaction.get(userEntitlementDocument(db, request.user.uid)),
        transaction.get(checkoutRef)
      ]);
      const currentEntitlement = entitlementSnapshot.data() || {};
      const activePro = hasActiveProEntitlement(currentEntitlement, now);
      const activePaidSubscription = activePro
        && (['monthly', 'yearly'].includes(currentEntitlement.billingPlan)
          || Boolean(currentEntitlement.subscriptionId));
      const activeVoucher = activePro
        && currentEntitlement.billingPlan === 'voucher'
        && currentEntitlement.lifetime !== true;
      const activeReferral = referralAccess.activeRewards.length > 0
        && !activePaidSubscription
        && currentEntitlement.lifetime !== true
        && currentEntitlement.source !== 'admin'
        && currentEntitlement.billingPlan !== 'admin';
      const canScheduleAfterPromotion = !activePaidSubscription && (activeVoucher || activeReferral);
      if (activePro && !canScheduleAfterPromotion) {
        const error = new Error('This account already has active Pro access.');
        error.status = 409;
        throw error;
      }
      const promotionalValidUntil = Math.max(
        activeVoucher ? entitlementValidUntil(currentEntitlement) : 0,
        activeReferral ? referralAccess.promotionalValidUntil : 0
      );
      const prepaidAccessStartsAt = canScheduleAfterPromotion && promotionalValidUntil > now
        ? promotionalValidUntil
        : null;
      const scheduledStartAt = prepaidAccessStartsAt
        ? billingPeriodEnd(prepaidAccessStartsAt, plan.period)
        : null;
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
            scheduledStartAt,
            prepaidAccessStartsAt,
            status: 'creating',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            subscriptionId: null,
            currentEnd: 0
          });
          return { requestId, reused: false, scheduledStartAt, prepaidAccessStartsAt };
        }
        if (current.planKey === planKey && current.subscriptionId) {
          if ((current.currency || 'INR') === currency) {
            const currentUpfrontAmount = Number(current.upfrontAmount) || 0;
            const currentPrepaidStartsAt = Number(current.prepaidAccessStartsAt) || null;
            const currentScheduledStartAt = Number(current.scheduledStartAt) || null;
            if (currentUpfrontAmount === (prepaidAccessStartsAt ? plan.amount : 0)
              && currentPrepaidStartsAt === prepaidAccessStartsAt
              && currentScheduledStartAt === scheduledStartAt) {
              return {
                subscriptionId: current.subscriptionId,
                reused: true,
                scheduledStartAt: currentScheduledStartAt,
                prepaidAccessStartsAt: currentPrepaidStartsAt
              };
            }
          }
        }
        if (current.status === 'creating' && Date.now() - Number(current.createdAt) > 5 * 60 * 1000) {
          transaction.set(checkoutRef, {
            requestId,
            planKey,
            currency,
            scheduledStartAt,
            prepaidAccessStartsAt,
            status: 'creating',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            subscriptionId: null
          });
          return { requestId, reused: false, scheduledStartAt, prepaidAccessStartsAt };
        }
        if (current.subscriptionId) {
          return {
            replaceSubscriptionId: current.subscriptionId,
            previousRequestId: current.requestId || null,
            scheduledStartAt,
            prepaidAccessStartsAt
          };
        }
        const error = new Error('This account already has a pending subscription checkout. Finish or wait for it to expire before choosing another plan.');
        error.status = 409;
        throw error;
      }
      transaction.create(checkoutRef, {
        requestId,
        planKey,
        currency,
        scheduledStartAt,
        prepaidAccessStartsAt,
        status: 'creating',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      return { requestId, reused: false, scheduledStartAt, prepaidAccessStartsAt };
    });
    if (checkout.replaceSubscriptionId) {
      const previousSubscriptionId = checkout.replaceSubscriptionId;
      const previousProviderSubscription = await razorpayRequest(
        `/subscriptions/${encodeURIComponent(previousSubscriptionId)}`
      );
      if (previousProviderSubscription.status !== 'created') {
        const error = new Error(
          `The existing Razorpay subscription is ${previousProviderSubscription.status || 'not ready'} and cannot be replaced. Complete or cancel that checkout first.`
        );
        error.status = 409;
        throw error;
      }
      await razorpayRequest(`/subscriptions/${encodeURIComponent(previousSubscriptionId)}/cancel`, {
        method: 'POST',
        body: { cancel_at_cycle_end: false }
      });
      const cancelledProviderSubscription = await razorpayRequest(
        `/subscriptions/${encodeURIComponent(previousSubscriptionId)}`
      );
      if (!['cancelled', 'completed', 'expired'].includes(cancelledProviderSubscription.status)) {
        const error = new Error('The previous Razorpay checkout could not be cancelled. Retry or finish that checkout before choosing another plan.');
        error.status = 409;
        throw error;
      }
      await db.runTransaction(async transaction => {
        const currentCheckout = await transaction.get(checkoutRef);
        const currentData = currentCheckout.data() || {};
        if (!currentCheckout.exists
          || currentData.subscriptionId !== previousSubscriptionId
          || (currentData.requestId || null) !== checkout.previousRequestId) {
          const error = new Error('The saved checkout changed. Refresh the Plans page and retry.');
          error.status = 409;
          throw error;
        }
        transaction.set(subscriptionDocument(db, previousSubscriptionId), {
          status: cancelledProviderSubscription.status,
          currentEnd: 0,
          updatedAt: Date.now()
        }, { merge: true });
        transaction.set(checkoutRef, {
          requestId,
          planKey,
          currency,
          scheduledStartAt: checkout.scheduledStartAt,
          prepaidAccessStartsAt: checkout.prepaidAccessStartsAt,
          status: 'creating',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          subscriptionId: null,
          currentEnd: 0
        });
      });
      checkout = {
        requestId,
        reused: false,
        scheduledStartAt: checkout.scheduledStartAt,
        prepaidAccessStartsAt: checkout.prepaidAccessStartsAt
      };
    }
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
          scheduledAt: checkout.prepaidAccessStartsAt,
          recurringAt: checkout.scheduledStartAt,
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
        ...(checkout.scheduledStartAt
          ? { start_at: Math.ceil(checkout.scheduledStartAt / 1000) }
          : {}),
        ...(checkout.prepaidAccessStartsAt
          ? {
              addons: [{
                item: {
                  name: `${plan.label} first billing period`,
                  amount: plan.amount,
                  currency
                }
              }]
            }
          : {}),
        notes: { plan_key: planKey, currency }
      }
    });
    await db.runTransaction(async transaction => {
      const entitlementSnapshot = await transaction.get(userEntitlementDocument(db, request.user.uid));
      const revocationAt = Number(entitlementSnapshot.data()?.adminRevokedAt) || 0;
      const createdAt = Math.max(Date.now(), revocationAt + 1);
      transaction.create(subscriptionDocument(db, created.id), {
        uid: request.user.uid,
        planKey,
        currency,
        planId: providerPlan.id,
        amount: plan.amount,
        status: created.status || 'created',
        currentEnd: 0,
        scheduledStartAt: checkout.scheduledStartAt,
        prepaidAccessStartsAt: checkout.prepaidAccessStartsAt,
        prepaidAccessUntil: checkout.scheduledStartAt,
        upfrontAmount: checkout.prepaidAccessStartsAt ? plan.amount : 0,
        createdAt,
        updatedAt: createdAt
      });
      transaction.set(checkoutRef, {
        subscriptionId: created.id,
        planId: providerPlan.id,
        amount: plan.amount,
        status: created.status || 'created',
        scheduledStartAt: checkout.scheduledStartAt,
        prepaidAccessStartsAt: checkout.prepaidAccessStartsAt,
        prepaidAccessUntil: checkout.scheduledStartAt,
        upfrontAmount: checkout.prepaidAccessStartsAt ? plan.amount : 0,
        updatedAt: createdAt
      }, { merge: true });
    });
    await recordBillingActivity(db, request.user.uid, {
      type: 'subscription', status: 'pending', title: `${plan.label} checkout started`,
      detail: checkout.prepaidAccessStartsAt
        ? `Checkout will charge the first ${plan.period === 'yearly' ? 'year' : 'month'} of ${plan.label.toLowerCase()} now. That prepaid period starts after promotional Pro access ends on ${new Date(checkout.prepaidAccessStartsAt).toLocaleDateString('en-IN')}; recurring billing begins after the prepaid period.`
        : 'Razorpay subscription checkout was created.', planKey,
      currency, providerSubscriptionId: created.id,
      amount: plan.amount
    });
    response.status(201).json({
      subscriptionId: created.id,
      keyId: process.env.RAZORPAY_KEY_ID,
      scheduledAt: checkout.prepaidAccessStartsAt,
      recurringAt: checkout.scheduledStartAt,
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
    const message = `${razorpayPaymentId}|${subscription.id}`;
    if (subscription.id !== razorpaySubscriptionId
      || !validRazorpaySignature(message, razorpaySignature, process.env.RAZORPAY_KEY_SECRET)) {
      response.status(400).json({ error: 'Payment signature verification failed.' });
      return;
    }
    if (subscription.plan_id !== mapping.planId
      || !planMatchesRazorpay(providerPlan, expectedPlan)
      || payment.subscription_id !== razorpaySubscriptionId
      || payment.amount !== expectedAmount
      || payment.currency !== currency
      || !['captured', 'authorized'].includes(payment.status)) {
      response.status(400).json({ error: 'The payment is not verified as belonging to this plan and currency.' });
      return;
    }

    const deferredStartPending = Number(mapping.scheduledStartAt) > Date.now();
    const prepaidAccessUntil = Number(mapping.prepaidAccessUntil);
    const prepaidPeriodPending = deferredStartPending
      && Number.isFinite(prepaidAccessUntil)
      && prepaidAccessUntil > Date.now();
    const entitlement = prepaidPeriodPending
      ? {
        planId: 'pro',
        billingPlan: mapping.planKey,
        status: 'active',
        source: 'server-verified',
        lifetime: false,
        validUntil: prepaidAccessUntil
      }
      : deferredStartPending
        ? null
        : entitlementFromSubscription(subscription, mapping.planKey);
    if (payment.status === 'captured' && entitlement?.status === 'active') {
      entitlement.currency = currency;
      let accessRevoked = false;
      await db.runTransaction(async transaction => {
        const currentMappingSnapshot = await transaction.get(mappingRef);
        const currentMapping = currentMappingSnapshot.data() || {};
        const currentEntitlementSnapshot = await transaction.get(userEntitlementDocument(db, request.user.uid));
        const currentEntitlement = currentEntitlementSnapshot.data() || {};
        const currentRevocationApplies = currentEntitlement.adminRevoked === true
          && (!Number(currentMapping.createdAt)
            || Number(currentMapping.createdAt) <= Number(currentEntitlement.adminRevokedAt));
        if (currentMapping.uid !== request.user.uid
          || currentMapping.adminRevoked === true
          || currentRevocationApplies) {
          accessRevoked = true;
          return;
        }
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
          adminRevoked: false,
          cancelAtCycleEnd: false
        });
        transaction.set(db.doc(`billingAccessHistory/${razorpayPaymentId}`), {
          uid: request.user.uid,
          subscriptionId: razorpaySubscriptionId,
          planKey: mapping.planKey,
          validFrom: prepaidPeriodPending && Number(mapping.prepaidAccessStartsAt) > 0
            ? Number(mapping.prepaidAccessStartsAt)
            : Number(payment.created_at) > 0 ? Number(payment.created_at) * 1000 : Date.now(),
          validUntil: entitlement.validUntil,
          paymentId: razorpayPaymentId,
          paymentMode: payment.method || subscription.payment_method || 'unknown',
          amount: payment.amount,
          currency,
          status: 'active',
          source: 'razorpay',
          createdAt: Number(payment.created_at) > 0 ? Number(payment.created_at) * 1000 : Date.now()
        }, { merge: true });
      });
      if (accessRevoked) {
        response.status(409).json({
          error: 'Pro access for this subscription was revoked by an administrator. Start a new subscription to restore access.'
        });
        return;
      }
      await db.doc(`billingPayments/${razorpayPaymentId}`).set({
        uid: request.user.uid, providerPaymentId: razorpayPaymentId, subscriptionId: razorpaySubscriptionId,
        planKey: mapping.planKey, status: 'captured', amount: payment.amount,
        currency, paymentMode: payment.method || subscription.payment_method || 'unknown',
        createdAt: Number(payment.created_at) > 0 ? Number(payment.created_at) * 1000 : Date.now()
      }, { merge: true });
      await recordBillingActivity(db, request.user.uid, {
        type: 'payment', status: 'success', title: 'Subscription payment verified',
        detail: prepaidPeriodPending
          ? `The first ${mapping.planKey === 'yearly' ? 'year' : 'month'} of Pro is paid and will begin after promotional access ends.`
          : `${mapping.planKey === 'yearly' ? 'Yearly' : 'Monthly'} Pro access is active.`,
        planKey: mapping.planKey, providerSubscriptionId: razorpaySubscriptionId,
        currency, amount: payment.amount
      });
      response.json({ verified: true, entitlement });
      return;
    }
    if (deferredStartPending) {
      await db.runTransaction(async transaction => {
        const [currentMappingSnapshot, currentCheckoutSnapshot] = await Promise.all([
          transaction.get(mappingRef),
          transaction.get(userCheckoutDocument(db, request.user.uid))
        ]);
        if (currentMappingSnapshot.data()?.uid !== request.user.uid
          || currentMappingSnapshot.data()?.adminRevoked === true) return;
        transaction.set(mappingRef, {
          status: subscription.status,
          updatedAt: Date.now()
        }, { merge: true });
        if (currentCheckoutSnapshot.data()?.subscriptionId === razorpaySubscriptionId) {
          transaction.set(userCheckoutDocument(db, request.user.uid), {
            status: subscription.status,
            updatedAt: Date.now()
          }, { merge: true });
        }
      });
    }
    response.json({
      verified: true,
      pending: true,
      message: deferredStartPending
        ? 'Your monthly subscription is set up and will start after your current Pro access ends.'
        : 'Payment was verified. Pro access will become available after Razorpay confirms subscription activation.'
    });
  } catch (error) {
    console.error('Could not verify Razorpay checkout.', error);
    response.status(502).json({ error: 'Could not verify payment status. Your payment will be reconciled by the Razorpay webhook.' });
  }
});

app.post('/api/billing/checkout/cancel', requireBillingConfig, requireFirebaseUser, async (request, response) => {
  const subscriptionId = typeof request.body?.subscriptionId === 'string'
    ? request.body.subscriptionId.trim()
    : '';
  if (!/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) {
    response.status(400).json({ error: 'A valid checkout subscription ID is required.' });
    return;
  }

  try {
    const { db } = await getFirebaseAdmin();
    const checkoutRef = userCheckoutDocument(db, request.user.uid);
    const mappingRef = subscriptionDocument(db, subscriptionId);
    const [checkoutSnapshot, mappingSnapshot] = await Promise.all([
      checkoutRef.get(),
      mappingRef.get()
    ]);
    if (checkoutSnapshot.data()?.subscriptionId !== subscriptionId
      || !mappingSnapshot.exists
      || mappingSnapshot.data()?.uid !== request.user.uid) {
      response.status(404).json({ error: 'This pending checkout was not found for your account.' });
      return;
    }

    let providerSubscription = await razorpayRequest(
      `/subscriptions/${encodeURIComponent(subscriptionId)}`
    );
    if (providerSubscription.status === 'created') {
      await razorpayRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
        method: 'POST',
        body: { cancel_at_cycle_end: false }
      });
      providerSubscription = await razorpayRequest(
        `/subscriptions/${encodeURIComponent(subscriptionId)}`
      );
    }
    const paidCount = Number(providerSubscription.paid_count) || 0;
    const currentEnd = Number(providerSubscription.current_end) * 1000;
    const isUnpaidAndStopped = ['cancelled', 'expired'].includes(providerSubscription.status)
      && paidCount === 0
      && (!Number.isFinite(currentEnd) || currentEnd <= Date.now());
    if (!isUnpaidAndStopped) {
      response.status(409).json({
        error: 'Razorpay could not confirm this checkout was cancelled before payment. Refresh your plan status before trying again.'
      });
      return;
    }

    await db.runTransaction(async transaction => {
      const [currentCheckout, currentMapping] = await Promise.all([
        transaction.get(checkoutRef),
        transaction.get(mappingRef)
      ]);
      if (currentCheckout.data()?.subscriptionId !== subscriptionId
        || currentMapping.data()?.uid !== request.user.uid) {
        const error = new Error('The saved checkout changed. Refresh your Plans page before trying again.');
        error.status = 409;
        throw error;
      }
      transaction.set(mappingRef, {
        status: providerSubscription.status,
        currentEnd: 0,
        checkoutCancelledAt: Date.now(),
        updatedAt: Date.now()
      }, { merge: true });
      transaction.set(checkoutRef, {
        subscriptionId: null,
        planId: null,
        planKey: null,
        amount: null,
        status: 'cancelled',
        currentEnd: 0,
        scheduledStartAt: null,
        updatedAt: Date.now()
      }, { merge: true });
    });

    response.json({ cancelled: true });
  } catch (error) {
    console.error('Could not cancel pending Razorpay checkout.', error);
    response.status(error.status === 409 ? 409 : 502).json({
      error: error.status === 409
        ? error.message
        : 'Could not confirm checkout cancellation with Razorpay. Refresh your plan status before trying again.'
    });
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

app.get('/file/d/:shareId/view', (request, response, next) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(request.params.shareId)) {
    response.status(404).json({ error: 'This public resume link is invalid.' });
    return;
  }
  response.sendFile(path.join(distDir, 'editor.html'), error => {
    if (error) next(error);
  });
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
