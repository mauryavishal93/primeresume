import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../backend/server.js';

function createFakeDatabase() {
  const records = new Map();
  let generatedId = 0;
  const snapshot = key => ({
    id: key.split('/').at(-1),
    ref: { path: key },
    exists: records.has(key),
    data: () => records.get(key)
  });
  const documentReference = key => ({
    id: key.split('/').at(-1),
    path: key,
    idPath: key,
    get: async () => snapshot(key),
    set: async (value, options = {}) => {
      records.set(key, options.merge ? { ...records.get(key), ...value } : value);
    },
    delete: async () => { records.delete(key); },
    collection: name => collectionReference(`${key}/${name}`)
  });
  const collectionReference = (path, options = {}) => {
    const { orderField = null, direction = 'asc', maximum = Infinity, startAfterPath = null, filters = [] } = options;
    const withOptions = changes => collectionReference(path, { ...options, ...changes });
    const result = {
      doc: id => documentReference(`${path}/${id || `forum-${++generatedId}`}`),
      orderBy: (field, order) => withOptions({ orderField: field, direction: order }),
      limit: value => withOptions({ maximum: value }),
      where: (field, operator, value) => withOptions({
        filters: [...filters, { field, operator, value }]
      }),
      startAfter: cursorSnapshot => withOptions({ startAfterPath: cursorSnapshot.ref.path }),
      count: () => ({
        get: async () => {
          const result = await collectionReference(path).get();
          return { data: () => ({ count: result.docs.length }) };
        }
      }),
      get: async () => {
        const depth = path.split('/').length + 1;
        let documents = [...records.entries()]
          .filter(([key]) => {
            if (path === '**/comments') {
              const parts = key.split('/');
              return parts.length === 4 && parts[2] === 'comments';
            }
            return key.startsWith(`${path}/`) && key.split('/').length === depth;
          })
          .filter(([, data]) => filters.every(filter => filter.operator === '==' && data[filter.field] === filter.value))
          .map(([key, data]) => ({ id: key.split('/').at(-1), ref: { path: key }, data: () => data }));
        if (orderField) {
          documents.sort((left, right) => {
            const difference = Number(left.data()[orderField]) - Number(right.data()[orderField]);
            return (direction === 'desc' ? -difference : difference) || (direction === 'desc'
              ? right.id.localeCompare(left.id)
              : left.id.localeCompare(right.id));
          });
        } else {
          documents.sort((left, right) => left.ref.path.localeCompare(right.ref.path));
        }
        const startIndex = startAfterPath
          ? documents.findIndex(document => document.ref.path === startAfterPath) + 1
          : 0;
        return { docs: documents.slice(startIndex, startIndex + maximum) };
      }
    };
    return result;
  };
  const db = {
    collection: collectionReference,
    collectionGroup: collectionName => collectionReference(`**/${collectionName}`),
    doc: documentReference,
    batch: () => {
      const operations = [];
      return {
        set: (reference, value, options = {}) => {
          operations.push(() => records.set(reference.idPath, options.merge
            ? { ...records.get(reference.idPath), ...value }
            : value));
        },
        delete: reference => operations.push(() => records.delete(reference.idPath)),
        commit: async () => operations.forEach(operation => operation())
      };
    }
  };
  return {
    db,
    records
  };
}

let server;
let origin;
let database;
const previousAdmin = app.locals.firebaseAdmin;

before(async () => {
  database = createFakeDatabase();
  app.locals.firebaseAdmin = {
    auth: {
      verifyIdToken: async token => {
        if (token === 'author-token') return { uid: 'author-1', name: 'Alex Author' };
        if (token === 'reader-token') return { uid: 'reader-2', name: 'Sam Reader' };
        if (token === 'admin-token') return { uid: 'admin-3', name: 'Casey Admin', admin: true };
        throw new Error('Invalid test token');
      }
    },
    db: database.db
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
  return {
    response,
    data: response.status === 204 ? null : await response.json()
  };
}

test('public community feed and authenticated post, rating, and comment ownership work', async () => {
  const anonymousCreate = await request('/api/forum/posts', {
    method: 'POST',
    body: { type: 'review', title: 'Helpful tool', content: 'This tool helped me write a resume.', rating: 5 }
  });
  assert.equal(anonymousCreate.response.status, 401);

  const invalidRating = await request('/api/forum/posts', {
    method: 'POST',
    token: 'author-token',
    body: { type: 'review', title: 'Helpful tool', content: 'This tool helped me write a resume.', rating: 6 }
  });
  assert.equal(invalidRating.response.status, 400);

  const review = await request('/api/forum/posts', {
    method: 'POST',
    token: 'author-token',
    body: {
      type: 'review',
      title: 'A helpful resume builder',
      content: 'The editor made it easy to organize my experience.',
      rating: 5
    }
  });
  assert.equal(review.response.status, 201);
  assert.equal(review.data.post.authorName, 'Alex Author');
  assert.equal(review.data.post.rating, 5);
  const reviewId = review.data.post.id;

  const discussion = await request('/api/forum/posts', {
    method: 'POST',
    token: 'reader-token',
    body: { type: 'discussion', title: 'Template question', content: 'Which template do you use for tech roles?' }
  });
  assert.equal(discussion.response.status, 201);
  const discussionId = discussion.data.post.id;

  const feed = await request('/api/forum/posts');
  assert.equal(feed.response.status, 200);
  assert.equal(feed.response.headers.get('cache-control'), 'no-store');
  assert.equal(feed.data.posts.length, 2);
  assert.equal(feed.data.ratingSummary.count, 1);
  assert.equal(feed.data.ratingSummary.average, 5);
  assert.equal(feed.data.posts.every(post => !Object.hasOwn(post, 'authorUid')), true);
  assert.equal(feed.data.posts.some(post => post.isOwner), false);
  const authorFeed = await request('/api/forum/posts', { token: 'author-token' });
  assert.equal(authorFeed.data.posts.find(post => post.id === reviewId).isOwner, true);

  const forbiddenEdit = await request(`/api/forum/posts/${reviewId}`, {
    method: 'PATCH',
    token: 'reader-token',
    body: { title: 'Changed title', content: 'This should not be allowed for another author.', rating: 2 }
  });
  assert.equal(forbiddenEdit.response.status, 403);

  const commentWithoutAuth = await request(`/api/forum/posts/${reviewId}/comments`, {
    method: 'POST',
    body: { content: 'I agree with this review.' }
  });
  assert.equal(commentWithoutAuth.response.status, 401);

  const comment = await request(`/api/forum/posts/${reviewId}/comments`, {
    method: 'POST',
    token: 'reader-token',
    body: { content: 'I agree with this review.' }
  });
  assert.equal(comment.response.status, 201);
  assert.equal(comment.data.comment.authorName, 'Sam Reader');
  assert.equal(comment.data.comment.isOwner, true);
  const feedWithComment = await request('/api/forum/posts');
  const reviewWithCommentCount = feedWithComment.data.posts.find(post => post.id === reviewId);
  assert.ok(reviewWithCommentCount);
  assert.equal(reviewWithCommentCount.commentCount, 1);

  const authorCurrentPosts = await request('/api/forum/my-content?kind=posts', { token: 'author-token' });
  assert.equal(authorCurrentPosts.data.items.some(item => item.id === reviewId), true);
  const readerCurrentComments = await request('/api/forum/my-content?kind=comments', { token: 'reader-token' });
  assert.equal(readerCurrentComments.data.items.some(item => item.id === comment.data.comment.id), true);
  const adminCurrentComments = await request('/api/admin/forum/content?kind=comments', { token: 'admin-token' });
  assert.equal(adminCurrentComments.response.status, 200);
  assert.equal(adminCurrentComments.data.items.some(item => item.id === comment.data.comment.id), true);

  const publicComments = await request(`/api/forum/posts/${reviewId}/comments`);
  assert.equal(publicComments.response.status, 200);
  assert.equal(publicComments.data.comments.length, 1);
  assert.equal(publicComments.data.totalCount, 1);
  const commentCountOnly = await request(`/api/forum/posts/${reviewId}/comments?countOnly=1`);
  assert.equal(commentCountOnly.response.status, 200);
  assert.equal(commentCountOnly.data.totalCount, 1);
  assert.equal(publicComments.data.comments[0].isOwner, false);
  const readerComments = await request(`/api/forum/posts/${reviewId}/comments`, { token: 'reader-token' });
  assert.equal(readerComments.data.comments[0].isOwner, true);

  const forbiddenDeleteComment = await request(
    `/api/forum/posts/${reviewId}/comments/${comment.data.comment.id}`,
    { method: 'DELETE', token: 'author-token' }
  );
  assert.equal(forbiddenDeleteComment.response.status, 403);

  const forbiddenEditComment = await request(
    `/api/forum/posts/${reviewId}/comments/${comment.data.comment.id}`,
    { method: 'PATCH', token: 'author-token', body: { content: 'Someone else should not edit this comment.' } }
  );
  assert.equal(forbiddenEditComment.response.status, 403);
  const invalidCommentEdit = await request(
    `/api/forum/posts/${reviewId}/comments/${comment.data.comment.id}`,
    { method: 'PATCH', token: 'reader-token', body: { content: '   ' } }
  );
  assert.equal(invalidCommentEdit.response.status, 400);
  const editComment = await request(
    `/api/forum/posts/${reviewId}/comments/${comment.data.comment.id}`,
    { method: 'PATCH', token: 'reader-token', body: { content: 'I agree and updated my comment.' } }
  );
  assert.equal(editComment.response.status, 200);
  assert.equal(editComment.data.comment.content, 'I agree and updated my comment.');
  assert.equal(editComment.data.comment.isOwner, true);
  assert.ok(editComment.data.comment.updatedAt);
  const editedPublicComments = await request(`/api/forum/posts/${reviewId}/comments`);
  assert.equal(editedPublicComments.data.comments[0].content, 'I agree and updated my comment.');
  const readerHistoryAfterCommentEdit = await request('/api/forum/activity', { token: 'reader-token' });
  const commentEditActivity = readerHistoryAfterCommentEdit.data.events.find(event =>
    event.commentId === comment.data.comment.id && event.eventType === 'comment_edited'
  );
  assert.deepEqual(commentEditActivity.before, { content: 'I agree with this review.' });
  assert.deepEqual(commentEditActivity.after, { content: 'I agree and updated my comment.' });

  const edit = await request(`/api/forum/posts/${reviewId}`, {
    method: 'PATCH',
    token: 'author-token',
    body: {
      title: 'Updated review title',
      content: 'The editor helped me organize my experience and improve my resume.',
      rating: 4
    }
  });
  assert.equal(edit.response.status, 200);
  assert.equal(edit.data.post.rating, 4);

  const removeComment = await request(
    `/api/forum/posts/${reviewId}/comments/${comment.data.comment.id}`,
    { method: 'DELETE', token: 'reader-token' }
  );
  assert.equal(removeComment.response.status, 204);
  const readerHistoryAfterCommentDelete = await request('/api/forum/activity', { token: 'reader-token' });
  assert.equal(readerHistoryAfterCommentDelete.response.status, 200);
  assert.equal(readerHistoryAfterCommentDelete.data.events.some(event =>
    event.commentId === comment.data.comment.id || event.postId === reviewId
  ), false);
  assert.equal(readerHistoryAfterCommentDelete.data.events.some(event => event.postId === discussionId), true);

  const deleteDiscussion = await request(`/api/forum/posts/${discussionId}`, {
    method: 'DELETE',
    token: 'reader-token'
  });
  assert.equal(deleteDiscussion.response.status, 204);
  const remainingFeed = await request('/api/forum/posts');
  assert.equal(remainingFeed.data.posts.length, 1);
  assert.equal(remainingFeed.data.ratingSummary.average, 4);

  const finalComment = await request(`/api/forum/posts/${reviewId}/comments`, {
    method: 'POST',
    token: 'author-token',
    body: { content: 'One last note before removing this review.' }
  });
  assert.equal(finalComment.response.status, 201);
  const deleteReview = await request(`/api/forum/posts/${reviewId}`, {
    method: 'DELETE',
    token: 'author-token'
  });
  assert.equal(deleteReview.response.status, 204);
  assert.equal(database.records.has(`forumPosts/${reviewId}/comments/${finalComment.data.comment.id}`), false);

  const authorHistory = await request('/api/forum/activity', { token: 'author-token' });
  assert.equal(authorHistory.response.status, 200);
  assert.equal(authorHistory.data.events.some(event => event.postId === reviewId), false);
  assert.equal(authorHistory.data.events.every(event => event.userUid === 'author-1'), true);
  assert.equal(authorHistory.data.events.some(event => event.eventType.endsWith('_deleted')), false);
  const readerHistory = await request('/api/forum/activity', { token: 'reader-token' });
  assert.equal(readerHistory.response.status, 200);
  assert.equal(readerHistory.data.events.every(event => event.userUid === 'reader-2'), true);
  assert.equal(readerHistory.data.events.some(event =>
    event.postId === reviewId || event.postId === discussionId
  ), false);
  assert.equal(readerHistory.data.events.some(event => event.eventType.endsWith('_deleted')), false);
  assert.equal(readerHistory.data.events.some(event => event.postId === reviewId && event.eventType === 'post_edited'), false);
  const authorDeletedPosts = await request('/api/forum/my-content?kind=posts', { token: 'author-token' });
  assert.equal(authorDeletedPosts.data.items.some(item => item.id === reviewId), false);
  const readerDeletedComments = await request('/api/forum/my-content?kind=comments', { token: 'reader-token' });
  assert.equal(readerDeletedComments.data.items.some(item => item.id === comment.data.comment.id), false);
  const deniedAdminHistory = await request('/api/admin/forum/activity', { token: 'reader-token' });
  assert.equal(deniedAdminHistory.response.status, 403);
  const adminHistory = await request('/api/admin/forum/activity', { token: 'admin-token' });
  assert.equal(adminHistory.response.status, 200);
  assert.equal(adminHistory.data.events.length, 10);
  assert.equal(adminHistory.data.events.some(event => event.userUid === 'author-1'), true);
  assert.equal(adminHistory.data.events.some(event => event.userUid === 'reader-2'), true);
  assert.equal(adminHistory.data.events.some(event => event.eventType === 'comment_edited'), true);
  const deletedPost = adminHistory.data.events.find(event => event.eventType === 'post_deleted');
  assert.equal(deletedPost.before.content, 'The editor helped me organize my experience and improve my resume.');
  const cascadeDelete = adminHistory.data.events.find(event =>
    event.eventType === 'comment_deleted' && event.reason === 'post_deleted'
  );
  assert.equal(cascadeDelete.reason, 'post_deleted');
  assert.equal(cascadeDelete.before.content, 'One last note before removing this review.');

  const emptyFeed = await request('/api/forum/posts');
  assert.equal(emptyFeed.data.posts.length, 0);
  assert.equal(emptyFeed.data.ratingSummary.average, null);

  for (let index = 0; index < 52; index += 1) {
    database.records.set(`forumPosts/seed-${index}`, {
      type: 'discussion',
      title: `Seeded topic ${index}`,
      content: 'A seeded discussion used to verify public feed pagination.',
      authorUid: 'seed-user',
      authorName: 'Seed User',
      createdAt: index,
      updatedAt: index
    });
  }
  const firstPage = await request('/api/forum/posts');
  assert.equal(firstPage.data.posts.length, 50);
  assert.ok(firstPage.data.nextCursor);
  const secondPage = await request(`/api/forum/posts?cursor=${encodeURIComponent(firstPage.data.nextCursor)}`);
  assert.equal(secondPage.data.posts.length, 2);
  assert.equal(new Set([...firstPage.data.posts, ...secondPage.data.posts].map(post => post.id)).size, 52);

  database.records.set('forumPosts/comment-pagination', {
    type: 'discussion',
    title: 'Comment pagination',
    content: 'A seeded topic used to verify comments are all publicly accessible.',
    authorUid: 'seed-user',
    authorName: 'Seed User',
    createdAt: 1000,
    updatedAt: 1000
  });
  for (let index = 0; index < 101; index += 1) {
    database.records.set(`forumPosts/comment-pagination/comments/comment-${index}`, {
      content: `Seed comment ${index}`,
      authorUid: 'seed-user',
      authorName: 'Seed User',
      createdAt: index
    });
  }
  const firstCommentPage = await request('/api/forum/posts/comment-pagination/comments');
  assert.equal(firstCommentPage.data.comments.length, 100);
  assert.ok(firstCommentPage.data.nextCursor);
  const secondCommentPage = await request(
    `/api/forum/posts/comment-pagination/comments?cursor=${encodeURIComponent(firstCommentPage.data.nextCursor)}`
  );
  assert.equal(secondCommentPage.data.comments.length, 1);

  database.records.set('forumPosts/legacy-author-post', {
    type: 'discussion',
    title: 'A post created before history tracking',
    content: 'Current user content remains visible even when it predates the activity history feature.',
    authorUid: 'author-1',
    authorName: 'Alex Author',
    createdAt: 100,
    updatedAt: 100
  });
  for (let index = 0; index < 26; index += 1) {
    database.records.set(`forumPosts/legacy-post-${String(index).padStart(2, '0')}`, {
      type: 'discussion',
      title: `Legacy author post ${index}`,
      content: 'A current post used to verify user-owned content pagination.',
      authorUid: 'author-1',
      authorName: 'Alex Author',
      createdAt: index,
      updatedAt: index
    });
  }
  database.records.set('forumPosts/legacy-author-post/comments/legacy-author-comment', {
    content: 'An existing comment by the author.',
    authorUid: 'author-1',
    authorName: 'Alex Author',
    createdAt: 101
  });
  database.records.set('forumPosts/legacy-author-post/comments/legacy-reader-comment', {
    content: 'A comment that belongs to another account.',
    authorUid: 'reader-2',
    authorName: 'Sam Reader',
    createdAt: 102
  });

  const anonymousContent = await request('/api/forum/my-content?kind=posts');
  assert.equal(anonymousContent.response.status, 401);
  const authorPosts = await request('/api/forum/my-content?kind=posts', { token: 'author-token' });
  assert.equal(authorPosts.response.status, 200);
  assert.equal(authorPosts.data.items.length, 25);
  assert.ok(authorPosts.data.nextCursor);
  assert.equal(authorPosts.data.items.every(item => item.authorName === 'Alex Author'), true);
  const authorPostsPageTwo = await request(
    `/api/forum/my-content?kind=posts&cursor=${encodeURIComponent(authorPosts.data.nextCursor)}`,
    { token: 'author-token' }
  );
  assert.equal(authorPostsPageTwo.data.items.length, 2);
  assert.equal(
    [...authorPosts.data.items, ...authorPostsPageTwo.data.items].some(item => item.title === 'A post created before history tracking'),
    true
  );
  const foreignContentCursor = await request(
    `/api/forum/my-content?kind=posts&cursor=${encodeURIComponent(authorPosts.data.nextCursor)}`,
    { token: 'reader-token' }
  );
  assert.equal(foreignContentCursor.response.status, 400);
  const authorComments = await request('/api/forum/my-content?kind=comments', { token: 'author-token' });
  assert.equal(authorComments.response.status, 200);
  assert.deepEqual(authorComments.data.items.map(item => item.id), ['legacy-author-comment']);
  assert.equal(authorComments.data.items[0].postTitle, 'A post created before history tracking');
  const readerCommentsOnly = await request('/api/forum/my-content?kind=comments', { token: 'reader-token' });
  assert.deepEqual(readerCommentsOnly.data.items.map(item => item.id), ['legacy-reader-comment']);
  const adminCurrentPosts = await request('/api/admin/forum/content?kind=posts', { token: 'admin-token' });
  assert.equal(adminCurrentPosts.response.status, 200);
  assert.equal(adminCurrentPosts.response.headers.get('cache-control'), 'no-store');
  assert.equal(adminCurrentPosts.data.items.find(item => item.id === 'legacy-author-post').authorUid, 'author-1');
  for (let index = 0; index < 27; index += 1) {
    database.records.set(`forumPosts/admin-filter-review-${String(index).padStart(2, '0')}`, {
      type: 'review',
      title: `Moderation fixture ${index}`,
      content: 'Searchable admin moderation fixtures.',
      rating: 5,
      authorUid: 'moderation-author',
      authorName: 'Moderation Author',
      createdAt: index,
      updatedAt: index
    });
  }
  database.records.set('forumPosts/admin-filter-deleted-review', {
    type: 'review',
    title: 'Deleted moderation fixture',
    content: 'Searchable deleted moderation fixture.',
    rating: 5,
    authorUid: 'moderation-author',
    authorName: 'Moderation Author',
    createdAt: 100,
    updatedAt: 100,
    isDeleted: true
  });
  const filteredAdminPosts = await request('/api/admin/forum/content?kind=posts&type=review&status=active&search=moderation+fixture', { token: 'admin-token' });
  assert.equal(filteredAdminPosts.response.status, 200);
  assert.ok(filteredAdminPosts.data.items.length > 0, JSON.stringify(filteredAdminPosts.data));
  assert.equal(filteredAdminPosts.data.items.length, 25);
  assert.ok(filteredAdminPosts.data.nextCursor);
  assert.equal(filteredAdminPosts.data.items.every(item =>
    item.type === 'review' && !item.isDeleted && item.title.toLowerCase().includes('moderation fixture')
  ), true);
  const filteredAdminPostsPageTwo = await request(
    `/api/admin/forum/content?kind=posts&type=review&status=active&search=moderation+fixture&cursor=${encodeURIComponent(filteredAdminPosts.data.nextCursor)}`,
    { token: 'admin-token' }
  );
  assert.equal(filteredAdminPostsPageTwo.response.status, 200);
  assert.equal(filteredAdminPostsPageTwo.data.items.length, 2);
  const filteredDeletedAdminPosts = await request('/api/admin/forum/content?kind=posts&type=review&status=deleted&search=moderation+fixture', { token: 'admin-token' });
  assert.equal(filteredDeletedAdminPosts.data.items.length, 1);
  assert.equal(filteredDeletedAdminPosts.data.items[0].id, 'admin-filter-deleted-review');
  const invalidAdminPostFilter = await request('/api/admin/forum/content?kind=posts&type=invalid', { token: 'admin-token' });
  assert.equal(invalidAdminPostFilter.response.status, 400);
  const deniedAdminContent = await request('/api/admin/forum/content?kind=comments', { token: 'reader-token' });
  assert.equal(deniedAdminContent.response.status, 403);

  const permanentCommentPostId = 'admin-comment-purge';
  const permanentCommentId = 'admin-comment-to-purge';
  database.records.set(`forumPosts/${permanentCommentPostId}`, {
    type: 'discussion',
    title: 'Post with comment for permanent deletion',
    content: 'This post is only used to verify permanent admin comment deletion.',
    authorUid: 'author-1',
    authorName: 'Alex Author',
    createdAt: 200,
    updatedAt: 200
  });
  database.records.set(`forumPosts/${permanentCommentPostId}/comments/${permanentCommentId}`, {
    content: 'This comment should be permanently removed.',
    authorUid: 'reader-2',
    authorName: 'Sam Reader',
    createdAt: 201
  });
  database.records.set('forumActivity/permanent-comment-created', {
    eventType: 'comment_created',
    userUid: 'reader-2',
    postId: permanentCommentPostId,
    commentId: permanentCommentId,
    occurredAt: 202
  });
  database.records.set('users/reader-2/forumActivity/permanent-comment-created', {
    eventType: 'comment_created',
    userUid: 'reader-2',
    postId: permanentCommentPostId,
    commentId: permanentCommentId,
    occurredAt: 202
  });
  const deniedPermanentCommentDelete = await request(
    `/api/admin/forum/posts/${permanentCommentPostId}/comments/${permanentCommentId}`,
    { method: 'DELETE', token: 'reader-token' }
  );
  assert.equal(deniedPermanentCommentDelete.response.status, 403);
  const permanentCommentDelete = await request(
    `/api/admin/forum/posts/${permanentCommentPostId}/comments/${permanentCommentId}`,
    { method: 'DELETE', token: 'admin-token' }
  );
  assert.equal(permanentCommentDelete.response.status, 204);
  assert.equal(database.records.has(`forumPosts/${permanentCommentPostId}/comments/${permanentCommentId}`), false);
  assert.equal(database.records.has('forumActivity/permanent-comment-created'), false);
  assert.equal(database.records.has('users/reader-2/forumActivity/permanent-comment-created'), false);
  const deletedCommentId = 'admin-deleted-comment';
  database.records.set('forumActivity/permanent-comment-deleted', {
    eventType: 'comment_deleted',
    userUid: 'reader-2',
    postId: permanentCommentPostId,
    commentId: deletedCommentId,
    occurredAt: 203
  });
  database.records.set('users/reader-2/forumActivity/permanent-comment-deleted', {
    eventType: 'comment_deleted',
    userUid: 'reader-2',
    postId: permanentCommentPostId,
    commentId: deletedCommentId,
    occurredAt: 203
  });
  const permanentDeletedComment = await request(
    `/api/admin/forum/posts/${permanentCommentPostId}/comments/${deletedCommentId}`,
    { method: 'DELETE', token: 'admin-token' }
  );
  assert.equal(permanentDeletedComment.response.status, 204);
  assert.equal(database.records.has('forumActivity/permanent-comment-deleted'), false);
  assert.equal(database.records.has('users/reader-2/forumActivity/permanent-comment-deleted'), false);

  const permanentPostId = 'admin-soft-deleted-post-purge';
  const permanentPostCommentId = 'comment-under-deleted-post';
  const permanentPostActivityId = 'deleted-post-activity';
  database.records.set(`forumPosts/${permanentPostId}`, {
    type: 'review',
    title: 'Already deleted review',
    content: 'An already-deleted review that can still be permanently purged.',
    rating: 1,
    authorUid: 'author-1',
    authorName: 'Alex Author',
    isDeleted: true,
    deletedAt: 300,
    createdAt: 250,
    updatedAt: 300
  });
  database.records.set(`forumPosts/${permanentPostId}/comments/${permanentPostCommentId}`, {
    content: 'A remaining comment on the deleted review.',
    authorUid: 'reader-2',
    authorName: 'Sam Reader',
    createdAt: 260
  });
  database.records.set(`forumActivity/${permanentPostActivityId}`, {
    eventType: 'post_deleted',
    userUid: 'author-1',
    postId: permanentPostId,
    occurredAt: 300
  });
  database.records.set(`users/author-1/forumActivity/${permanentPostActivityId}`, {
    eventType: 'post_deleted',
    userUid: 'author-1',
    postId: permanentPostId,
    occurredAt: 300
  });
  const deniedPermanentPostDelete = await request(`/api/admin/forum/posts/${permanentPostId}`, {
    method: 'DELETE',
    token: 'reader-token'
  });
  assert.equal(deniedPermanentPostDelete.response.status, 403);
  const permanentPostDelete = await request(`/api/admin/forum/posts/${permanentPostId}`, {
    method: 'DELETE',
    token: 'admin-token'
  });
  assert.equal(permanentPostDelete.response.status, 204);
  assert.equal(database.records.has(`forumPosts/${permanentPostId}`), false);
  assert.equal(database.records.has(`forumPosts/${permanentPostId}/comments/${permanentPostCommentId}`), false);
  assert.equal(database.records.has(`forumActivity/${permanentPostActivityId}`), false);
  assert.equal(database.records.has(`users/author-1/forumActivity/${permanentPostActivityId}`), false);

  const activePostId = 'admin-active-post-purge';
  const activeCommentId = 'active-post-comment';
  database.records.set(`forumPosts/${activePostId}`, {
    type: 'discussion',
    title: 'Active discussion for permanent deletion',
    content: 'This active post should be permanently removed by an administrator.',
    authorUid: 'author-1',
    authorName: 'Alex Author',
    createdAt: 400,
    updatedAt: 400
  });
  database.records.set(`forumPosts/${activePostId}/comments/${activeCommentId}`, {
    content: 'This comment should also be permanently removed.',
    authorUid: 'reader-2',
    authorName: 'Sam Reader',
    createdAt: 401
  });
  database.records.set('forumActivity/active-post-created', {
    eventType: 'post_created',
    userUid: 'author-1',
    postId: activePostId,
    occurredAt: 400
  });
  database.records.set('users/author-1/forumActivity/active-post-created', {
    eventType: 'post_created',
    userUid: 'author-1',
    postId: activePostId,
    occurredAt: 400
  });
  const activePostDelete = await request(`/api/admin/forum/posts/${activePostId}`, {
    method: 'DELETE',
    token: 'admin-token'
  });
  assert.equal(activePostDelete.response.status, 204);
  assert.equal(database.records.has(`forumPosts/${activePostId}`), false);
  assert.equal(database.records.has(`forumPosts/${activePostId}/comments/${activeCommentId}`), false);
  assert.equal(database.records.has('forumActivity/active-post-created'), false);
  assert.equal(database.records.has('users/author-1/forumActivity/active-post-created'), false);

  const staticDeletePostId = 'admin-static-post-purge';
  const staticDeleteCommentId = 'admin-static-comment-purge';
  database.records.set(`forumPosts/${staticDeletePostId}`, {
    type: 'discussion',
    title: 'Post for static admin deletion',
    content: 'This post is removed through the static admin endpoint.',
    authorUid: 'author-1',
    authorName: 'Alex Author',
    createdAt: 500,
    updatedAt: 500
  });
  database.records.set(`forumPosts/${staticDeletePostId}/comments/${staticDeleteCommentId}`, {
    content: 'This comment should be removed with its post.',
    authorUid: 'reader-2',
    authorName: 'Sam Reader',
    createdAt: 501
  });
  database.records.set('forumActivity/static-post-created', {
    eventType: 'post_created',
    userUid: 'author-1',
    postId: staticDeletePostId,
    occurredAt: 500
  });
  database.records.set('users/author-1/forumActivity/static-post-created', {
    eventType: 'post_created',
    userUid: 'author-1',
    postId: staticDeletePostId,
    occurredAt: 500
  });
  const deniedStaticPostDelete = await request('/api/admin/forum/permanent-delete', {
    method: 'POST',
    token: 'reader-token',
    body: { kind: 'post', postId: staticDeletePostId }
  });
  assert.equal(deniedStaticPostDelete.response.status, 403);
  assert.equal(database.records.has(`forumPosts/${staticDeletePostId}`), true);
  const staticPostDelete = await request('/api/admin/forum/permanent-delete', {
    method: 'POST',
    token: 'admin-token',
    body: { kind: 'post', postId: staticDeletePostId }
  });
  assert.equal(staticPostDelete.response.status, 200);
  assert.deepEqual(staticPostDelete.data, { deleted: true });
  assert.equal(database.records.has(`forumPosts/${staticDeletePostId}`), false);
  assert.equal(database.records.has(`forumPosts/${staticDeletePostId}/comments/${staticDeleteCommentId}`), false);
  assert.equal(database.records.has('forumActivity/static-post-created'), false);
  assert.equal(database.records.has('users/author-1/forumActivity/static-post-created'), false);

  const staticCommentPostId = 'admin-static-comment-parent';
  database.records.set(`forumPosts/${staticCommentPostId}`, {
    type: 'discussion',
    title: 'Post for static comment deletion',
    content: 'This post remains after comment deletion.',
    authorUid: 'author-1',
    authorName: 'Alex Author',
    createdAt: 600,
    updatedAt: 600
  });
  database.records.set(`forumPosts/${staticCommentPostId}/comments/${staticDeleteCommentId}`, {
    content: 'This comment should be permanently removed.',
    authorUid: 'reader-2',
    authorName: 'Sam Reader',
    createdAt: 601
  });
  database.records.set('forumActivity/static-comment-created', {
    eventType: 'comment_created',
    userUid: 'reader-2',
    postId: staticCommentPostId,
    commentId: staticDeleteCommentId,
    occurredAt: 602
  });
  database.records.set('users/reader-2/forumActivity/static-comment-created', {
    eventType: 'comment_created',
    userUid: 'reader-2',
    postId: staticCommentPostId,
    commentId: staticDeleteCommentId,
    occurredAt: 602
  });
  const staticCommentDelete = await request('/api/admin/forum/permanent-delete', {
    method: 'POST',
    token: 'admin-token',
    body: { kind: 'comment', postId: staticCommentPostId, commentId: staticDeleteCommentId }
  });
  assert.equal(staticCommentDelete.response.status, 200);
  assert.deepEqual(staticCommentDelete.data, { deleted: true });
  assert.equal(database.records.has(`forumPosts/${staticCommentPostId}`), true);
  assert.equal(database.records.has(`forumPosts/${staticCommentPostId}/comments/${staticDeleteCommentId}`), false);
  assert.equal(database.records.has('forumActivity/static-comment-created'), false);
  assert.equal(database.records.has('users/reader-2/forumActivity/static-comment-created'), false);
});
