import { cloudConfigured, getFirebaseIdToken, observeAuth } from './firebase-cloud.js';

const status = document.querySelector('[data-history-status]');
const list = document.querySelector('[data-history-list]');
const loadMoreButton = document.querySelector('[data-history-more]');
const contentAuthStatus = document.querySelector('[data-content-auth-status]');
const contentStates = {
  posts: {
    status: document.querySelector('[data-current-posts-status]'),
    list: document.querySelector('[data-current-posts-list]'),
    button: document.querySelector('[data-current-posts-more]'),
    cursor: null,
    loading: false
  },
  comments: {
    status: document.querySelector('[data-current-comments-status]'),
    list: document.querySelector('[data-current-comments-list]'),
    button: document.querySelector('[data-current-comments-more]'),
    cursor: null,
    loading: false
  }
};
let currentUser = null;
let cursor = null;
let loading = false;
let requestGeneration = 0;

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('is-error', isError);
}

function addText(parent, tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value || '';
  parent.append(element);
  return element;
}

function addPostLink(parent, title, postId, heading = 'h2') {
  const element = document.createElement(heading);
  const link = document.createElement('a');
  link.className = 'community-content-link';
  link.href = `/community.html?post=${encodeURIComponent(postId)}`;
  link.textContent = title || 'Community post';
  element.append(link);
  parent.append(element);
}

function actionLabel(event) {
  return ({
    post_created: 'Published post',
    post_edited: 'Edited post',
    comment_created: 'Published comment',
    comment_edited: 'Edited comment'
  })[event.eventType] || 'Community activity';
}

function renderSnapshot(container, label, snapshot) {
  if (!snapshot) return;
  const section = document.createElement('section');
  section.className = 'history-snapshot';
  addText(section, 'h3', '', label);
  if (snapshot.type === 'review') {
    addText(section, 'p', 'history-rating', `${snapshot.rating || 0}/5 stars`);
  }
  if (snapshot.title) addText(section, 'h4', '', snapshot.title);
  if (snapshot.content) addText(section, 'p', 'community-post-content', snapshot.content);
  if (snapshot.content === undefined && snapshot.type === undefined && snapshot.title === undefined) {
    addText(section, 'p', 'community-comment-content', snapshot.content || '');
  }
  container.append(section);
}

function renderEvent(event) {
  const article = document.createElement('article');
  article.className = 'community-post-card history-entry';
  const metadata = document.createElement('div');
  metadata.className = 'community-post-meta';
  addText(metadata, 'strong', 'community-post-author', actionLabel(event));
  addText(metadata, 'span', 'history-date', Number(event.occurredAt)
    ? new Date(event.occurredAt).toLocaleString()
    : 'Date unavailable');
  article.append(metadata);
  if (event.postId) addPostLink(article, event.postTitle || 'Community comment', event.postId);
  else addText(article, 'h2', '', event.postTitle || 'Community comment');

  if (event.eventType === 'post_edited' || event.eventType === 'comment_edited') {
    const versions = document.createElement('div');
    versions.className = 'history-versions';
    renderSnapshot(versions, 'Previous version', event.before);
    renderSnapshot(versions, 'Updated version', event.after);
    article.append(versions);
  } else {
    renderSnapshot(article, 'Content', event.before || event.after);
  }
  return article;
}

function renderEvents(events, append) {
  if (!append) list.replaceChildren();
  for (const event of events) list.append(renderEvent(event));
}

function renderCurrentContent(kind, item) {
  const article = document.createElement('article');
  article.className = 'community-post-card history-entry';
  const metadata = document.createElement('div');
  metadata.className = 'community-post-meta';
  addText(metadata, 'strong', 'community-post-author', kind === 'posts'
    ? item.type === 'review' ? 'Current review' : 'Current post'
    : 'Current comment');
  addText(metadata, 'span', 'history-date', Number(item.createdAt)
    ? new Date(item.createdAt).toLocaleString()
    : 'Date unavailable');
  article.append(metadata);
  if (kind === 'posts') {
    addPostLink(article, item.title, item.id);
    if (item.type === 'review') addText(article, 'p', 'history-rating', `${item.rating}/5 stars`);
    addText(article, 'p', 'community-post-content', item.content);
  } else {
    addPostLink(article, item.postTitle || 'Comment on community post', item.postId);
    addText(article, 'p', 'community-comment-content', item.content);
  }
  return article;
}

async function loadCurrentContent(kind, { append = false } = {}) {
  const state = contentStates[kind];
  if (!currentUser || state.loading) return;
  state.loading = true;
  state.button.disabled = true;
  state.status.classList.remove('is-error');
  state.status.textContent = append ? 'Loading older content…' : `Loading your ${kind}…`;
  const generation = requestGeneration;
  try {
    const token = await getFirebaseIdToken(currentUser);
    const query = new URLSearchParams({ kind });
    if (append && state.cursor) query.set('cursor', state.cursor);
    const response = await fetch(`/api/forum/my-content?${query}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.error || `Could not load your ${kind} (HTTP ${response.status}).`);
    if (generation !== requestGeneration) return;
    if (!append) state.list.replaceChildren();
    for (const item of result.items || []) state.list.append(renderCurrentContent(kind, item));
    state.cursor = result.nextCursor || null;
    state.button.hidden = !state.cursor;
    state.button.textContent = 'Load older ' + kind;
    state.status.textContent = result.items?.length || append ? '' : `You have no current ${kind}.`;
  } catch (error) {
    if (generation !== requestGeneration) return;
    console.error(`Could not load your community ${kind}.`, error);
    state.status.textContent = error.message || `Could not load your ${kind}.`;
    state.status.classList.add('is-error');
    state.button.hidden = true;
  } finally {
    if (generation === requestGeneration) {
      state.loading = false;
      state.button.disabled = false;
    }
  }
}

async function loadActivity({ append = false } = {}) {
  if (!currentUser || loading) return;
  loading = true;
  loadMoreButton.disabled = true;
  setStatus(append ? 'Loading older activity…' : 'Loading your community history…');
  const generation = requestGeneration;
  try {
    const token = await getFirebaseIdToken(currentUser);
    const query = append && cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const response = await fetch(`/api/forum/activity${query}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.error || `Could not load history (HTTP ${response.status}).`);
    if (generation !== requestGeneration) return;
    renderEvents(result.events || [], append);
    cursor = result.nextCursor || null;
    loadMoreButton.hidden = !cursor;
    loadMoreButton.textContent = 'Load older activity';
    const hasEvents = (result.events || []).length > 0;
    setStatus(hasEvents ? '' : cursor ? 'No activity on this page. Load older activity.' : 'No activity to show.');
  } catch (error) {
    if (generation !== requestGeneration) return;
    console.error('Could not load your community history.', error);
    setStatus(error.message || 'Could not load your community history.', true);
    loadMoreButton.hidden = true;
  } finally {
    if (generation === requestGeneration) {
      loading = false;
      loadMoreButton.disabled = false;
    }
  }
}

function updateAuth(user, error) {
  requestGeneration++;
  currentUser = user;
  cursor = null;
  loading = false;
  list.replaceChildren();
  loadMoreButton.hidden = true;
  contentAuthStatus.textContent = error
    ? error.message || 'Sign-in is unavailable.'
    : user ? '' : 'Sign in with Google to view your posts, comments, and history.';
  for (const state of Object.values(contentStates)) {
    state.cursor = null;
    state.loading = false;
    state.list.replaceChildren();
    state.status.textContent = '';
    state.status.classList.remove('is-error');
    state.button.hidden = true;
    state.button.textContent = `Load older ${state === contentStates.posts ? 'posts' : 'comments'}`;
  }
  if (error) {
    setStatus(error.message || 'Sign-in is unavailable.', true);
    contentAuthStatus.classList.add('is-error');
  } else if (!user) {
    contentAuthStatus.classList.remove('is-error');
    setStatus('Sign in with Google to view your posts, comments, and history.');
  } else {
    contentAuthStatus.classList.remove('is-error');
    void Promise.all([
      loadCurrentContent('posts'),
      loadCurrentContent('comments'),
      loadActivity()
    ]);
  }
}

for (const kind of Object.keys(contentStates)) {
  contentStates[kind].button.addEventListener('click', () => {
    void loadCurrentContent(kind, { append: true });
  });
}
loadMoreButton.addEventListener('click', () => void loadActivity({ append: true }));
if (cloudConfigured) observeAuth(updateAuth);
else updateAuth(null, new Error('Google sign-in is not configured on this site.'));
