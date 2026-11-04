import { cloudConfigured, getFirebaseIdToken, observeAuth } from './firebase-cloud.js';
import { confirmModern } from './modern-modal.js';

const postList = document.querySelector('[data-post-list]');
const feedStatus = document.querySelector('[data-feed-status]');
const retryButton = document.querySelector('[data-retry-feed]');
const loadMorePostsButton = document.querySelector('[data-load-more]');
const signInPrompt = document.querySelector('[data-community-signin]');
const signedInPanel = document.querySelector('[data-community-signed-in]');
const postForm = document.querySelector('[data-post-form]');
const postType = document.querySelector('[data-post-type]');
const ratingField = document.querySelector('[data-rating-field]');
const ratingHelp = document.querySelector('[data-rating-help]');
const postStatus = document.querySelector('[data-post-status]');
const submitPostButton = document.querySelector('[data-submit-post]');
const ratingAverage = document.querySelector('[data-rating-average]');
const ratingStars = document.querySelector('[data-rating-summary-stars]');
const ratingCount = document.querySelector('[data-rating-count]');
const requestedPostId = new URLSearchParams(window.location.search).get('post');
const commentCache = new Map();
const commentCursors = new Map();
let currentUser = null;
let posts = [];
let currentFilter = 'all';
let selectedRating = 0;
let editingPostId = null;
let nextPostCursor = null;
let retryAppend = false;

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function setStatus(element, message, isError = false) {
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('is-error', isError);
}

function setRating(value) {
  selectedRating = value;
  document.querySelectorAll('[data-rating-choice]').forEach(button => {
    const active = Number(button.dataset.ratingChoice) <= value;
    button.textContent = active ? '★' : '☆';
    button.setAttribute('aria-checked', String(Number(button.dataset.ratingChoice) === value));
  });
  if (ratingHelp) ratingHelp.textContent = value ? `${value} out of 5 stars` : 'Select a rating from 1 to 5 stars.';
}

function updatePostFormType() {
  const isReview = postType.value === 'review';
  ratingField.hidden = !isReview;
  submitPostButton.textContent = editingPostId
    ? 'Save changes'
    : isReview ? 'Publish review' : 'Publish discussion';
}

async function requestApi(url, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && !currentUser) throw new Error('Sign in before posting or commenting.');
  if (currentUser) headers.authorization = `Bearer ${await getFirebaseIdToken(currentUser)}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
  } catch (error) {
    console.error('Could not reach the community API.', error);
    throw new Error('Could not reach the community service. Start the API backend and try again.');
  }
  let result = null;
  if (response.status !== 204) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        result = await response.json();
      } catch (error) {
        console.error('Community API returned invalid JSON.', error);
        throw new Error('The community service returned an invalid response. Please try again.');
      }
    } else {
      const responseText = await response.text();
      console.error('Community API returned a non-JSON response.', {
        status: response.status,
        contentType,
        responseText
      });
      if (response.status >= 500) {
        throw new Error('The community API is unavailable. Make sure the backend is running, then try again.');
      }
      throw new Error(responseText || 'The community service returned an unexpected response. Please try again.');
    }
  }
  if (!response.ok) throw new Error(result?.error || 'The community request could not be completed.');
  return result;
}

function formatDate(timestamp) {
  const date = new Date(Number(timestamp));
  return Number.isNaN(date.getTime())
    ? 'Date unavailable'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

function updateRatingSummary(summary) {
  const count = Number(summary?.count) || 0;
  const average = Number(summary?.average);
  ratingAverage.textContent = count && Number.isFinite(average) ? average.toFixed(1) : '—';
  ratingStars.textContent = count && Number.isFinite(average)
    ? `${'★'.repeat(Math.round(average))}${'☆'.repeat(5 - Math.round(average))}`
    : '☆☆☆☆☆';
  ratingCount.textContent = count === 1 ? '1 recent review' : `${count} recent reviews`;
}

function setAuthState(user, error = null) {
  const previousUid = currentUser?.uid || null;
  currentUser = user;
  const currentUid = currentUser?.uid || null;
  if (previousUid !== currentUid) {
    posts = posts.map(post => ({ ...post, isOwner: false }));
    commentCache.clear();
    commentCursors.clear();
  }
  signInPrompt.hidden = Boolean(user);
  signedInPanel.hidden = !user;
  if (user) {
    const name = user.displayName?.trim() || user.email?.split('@')[0] || 'there';
    document.querySelector('[data-community-welcome]').textContent = `Signed in as ${name}. Your posts and comments are public.`;
  } else if (error) {
    signInPrompt.querySelector('p').textContent = 'Sign-in is temporarily unavailable.';
    signInPrompt.querySelector('span').textContent = error.message || 'Check the sign-in status in the page header and try again.';
  } else {
    signInPrompt.querySelector('p').textContent = 'Want to share a review or join the conversation?';
    signInPrompt.querySelector('span').textContent = 'Sign in with Google to post and comment. Community posts and comments are visible to everyone.';
  }
  renderPosts();
  if (previousUid !== currentUid) void loadPosts();
}

function createPostCard(post) {
  const article = createElement('article', 'community-post-card');
  article.dataset.postId = post.id;
  article.id = `community-post-${post.id}`;

  const metadata = createElement('div', 'community-post-meta');
  metadata.append(
    createElement('span', 'community-post-author', post.authorName || 'Google user'),
    createElement('span', 'community-post-type', post.type === 'review' ? 'App review' : 'Discussion'),
    createElement('time', '', formatDate(post.createdAt))
  );
  article.append(metadata);

  const title = createElement('h3', '', post.title);
  article.append(title);
  if (post.type === 'review') {
    const stars = createElement('div', 'community-post-rating', `${'★'.repeat(post.rating)}${'☆'.repeat(5 - post.rating)}  ${post.rating}/5`);
    stars.setAttribute('aria-label', `Rated ${post.rating} out of 5 stars`);
    article.append(stars);
  }
  article.append(createElement('p', 'community-post-content', post.content));

  const actions = createElement('div', 'community-post-actions');
  if (post.isDeleted) {
    actions.append(createElement('strong', 'community-deleted-post', 'Deleted post · Admin view'));
    article.append(actions);
    return article;
  }
  const commentsButton = createElement('button', 'community-button community-button-secondary', 'View comments');
  commentsButton.type = 'button';
  commentsButton.setAttribute('aria-expanded', 'false');
  actions.append(commentsButton);

  if (currentUser && post.isOwner) {
    const editButton = createElement('button', 'community-button community-button-secondary', 'Edit');
    editButton.type = 'button';
    editButton.addEventListener('click', () => openEditor(post));
    const deleteButton = createElement('button', 'community-button community-danger', 'Delete');
    deleteButton.type = 'button';
    deleteButton.addEventListener('click', () => void deletePost(post.id));
    actions.append(editButton, deleteButton);
  }
  article.append(actions);

  const comments = createElement('section', 'community-comments');
  comments.hidden = true;
  comments.setAttribute('aria-label', `Comments on ${post.title}`);
  const commentsHeading = createElement('div', 'community-comment-heading');
  commentsHeading.append(createElement('h4', '', 'Comments'));
  const commentStatus = createElement('span', 'community-status');
  commentStatus.setAttribute('role', 'status');
  commentsHeading.append(commentStatus);
  const commentList = createElement('div', 'community-comment-list');
  const loadMoreCommentsButton = createElement('button', 'community-button community-button-secondary community-load-more', 'Load older comments');
  loadMoreCommentsButton.type = 'button';
  loadMoreCommentsButton.hidden = true;
  loadMoreCommentsButton.addEventListener('click', () => {
    loadMoreCommentsButton.disabled = true;
    void loadComments(post.id, commentList, commentStatus, {
      append: true,
      loadMoreButton: loadMoreCommentsButton
    }).finally(() => { loadMoreCommentsButton.disabled = false; });
  });
  comments.append(commentsHeading, commentList, loadMoreCommentsButton);
  commentsButton.addEventListener('click', async () => {
    comments.hidden = !comments.hidden;
    commentsButton.setAttribute('aria-expanded', String(!comments.hidden));
    commentsButton.textContent = comments.hidden ? 'View comments' : 'Hide comments';
    if (!comments.hidden) await loadComments(post.id, commentList, commentStatus, {
      loadMoreButton: loadMoreCommentsButton
    });
  });
  if (currentUser) {
    const commentForm = createElement('form', 'community-comment-form');
    const label = createElement('label', 'community-field');
    label.append(createElement('span', '', 'Add a comment'));
    const textarea = createElement('textarea');
    textarea.name = 'content';
    textarea.maxLength = 2000;
    textarea.required = true;
    textarea.rows = 3;
    textarea.placeholder = 'Write a thoughtful comment…';
    label.append(textarea);
    const formActions = createElement('div', 'community-comment-form-actions');
    const formStatus = createElement('span', 'community-status');
    formStatus.setAttribute('role', 'status');
    const submit = createElement('button', 'community-button community-button-primary', 'Post comment');
    submit.type = 'submit';
    formActions.append(formStatus, submit);
    commentForm.append(label, formActions);
    commentForm.addEventListener('submit', event => {
      event.preventDefault();
      void submitComment(post.id, commentForm, commentList, formStatus, submit, loadMoreCommentsButton);
    });
    comments.append(commentForm);
  } else {
    comments.append(createElement('p', 'community-status', 'Sign in with Google to add a comment.'));
  }
  article.append(comments);
  return article;
}

function renderComments(comments, list, status, loadMoreButton, hasMore = false) {
  list.replaceChildren();
  if (loadMoreButton) loadMoreButton.hidden = !hasMore;
  if (!comments.length) {
    list.append(createElement('p', 'community-empty', 'No comments yet. Start the conversation.'));
    setStatus(status, '');
    return;
  }
  for (const comment of comments) {
    const item = createElement('article', 'community-comment');
    const metadata = createElement('div', 'community-comment-meta');
    metadata.append(
      createElement('strong', '', comment.authorName || 'Google user'),
      createElement('time', '', formatDate(comment.createdAt))
    );
    if (currentUser && comment.isOwner) {
      const remove = createElement('button', 'community-button community-danger community-comment-delete', 'Delete');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Delete your comment');
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          await requestApi(`/api/forum/posts/${encodeURIComponent(item.dataset.postId || '')}/comments/${encodeURIComponent(comment.id)}`, { method: 'DELETE' });
          const updated = (commentCache.get(item.dataset.postId) || []).filter(entry => entry.id !== comment.id);
          commentCache.set(item.dataset.postId, updated);
          renderComments(updated, list, status, loadMoreButton, Boolean(commentCursors.get(item.dataset.postId)));
        } catch (error) {
          remove.disabled = false;
          setStatus(status, error.message, true);
        }
      });
      metadata.append(remove);
    }
    item.append(metadata, createElement('p', 'community-comment-content', comment.content));
    item.dataset.postId = comment.postId || '';
    list.append(item);
  }
  setStatus(status, `${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}`);
}

async function loadComments(postId, list, status, { force = false, append = false, loadMoreButton } = {}) {
  if (!force && !append && commentCache.has(postId)) {
    renderComments(commentCache.get(postId), list, status, loadMoreButton, Boolean(commentCursors.get(postId)));
    return;
  }
  setStatus(status, append ? 'Loading older comments…' : 'Loading comments…');
  try {
    const cursor = append ? commentCursors.get(postId) : null;
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const result = await requestApi(`/api/forum/posts/${encodeURIComponent(postId)}/comments${query}`);
    const comments = result.comments.map(comment => ({ ...comment, postId }));
    const allComments = append ? [...(commentCache.get(postId) || []), ...comments] : comments;
    commentCache.set(postId, allComments);
    commentCursors.set(postId, result.nextCursor);
    renderComments(allComments, list, status, loadMoreButton, Boolean(result.nextCursor));
  } catch (error) {
    setStatus(status, error.message, true);
  }
}

async function submitComment(postId, form, list, status, button, loadMoreButton) {
  const content = new FormData(form).get('content')?.toString().trim();
  if (!content) {
    setStatus(status, 'Enter a comment before posting.', true);
    return;
  }
  button.disabled = true;
  setStatus(status, 'Publishing comment…');
  try {
    await requestApi(`/api/forum/posts/${encodeURIComponent(postId)}/comments`, {
      method: 'POST',
      body: { content }
    });
    form.reset();
    await loadComments(postId, list, status, { force: true, loadMoreButton });
  } catch (error) {
    setStatus(status, error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderPosts() {
  if (!postList) return;
  const shown = posts.filter(post => currentFilter === 'all' || post.type === currentFilter);
  postList.replaceChildren();
  for (const post of shown) postList.append(createPostCard(post));
  if (!shown.length && !feedStatus.textContent) {
    postList.append(createElement('p', 'community-empty', posts.length
      ? 'There are no posts in this category yet.'
      : 'No community posts yet. Be the first to share a review or start a discussion.'));
  }
}

async function loadPosts({ append = false } = {}) {
  const viewerUid = currentUser?.uid || null;
  retryButton.hidden = true;
  if (!append) {
    nextPostCursor = null;
    loadMorePostsButton.hidden = true;
  }
  setStatus(feedStatus, append ? 'Loading older posts…' : 'Loading community posts…');
  try {
    const query = append && nextPostCursor ? `?cursor=${encodeURIComponent(nextPostCursor)}` : '';
    const result = await requestApi(`/api/forum/posts${query}`);
    if (viewerUid !== (currentUser?.uid || null)) return;
    if (requestedPostId && !append) {
      let linkedPost = result.posts.find(post => post.id === requestedPostId);
      if (!linkedPost) {
        const linkedResult = await requestApi(`/api/forum/posts/${encodeURIComponent(requestedPostId)}`);
        linkedPost = linkedResult.post;
      }
      if (viewerUid !== (currentUser?.uid || null)) return;
      posts = [linkedPost];
      nextPostCursor = null;
    } else {
      posts = append ? [...posts, ...result.posts] : result.posts;
      nextPostCursor = result.nextCursor;
    }
    loadMorePostsButton.hidden = !nextPostCursor;
    if (!append) updateRatingSummary(result.ratingSummary);
    retryAppend = false;
    setStatus(feedStatus, '');
    renderPosts();
    if (requestedPostId && !append) {
      window.requestAnimationFrame(() => {
        document.getElementById(`community-post-${requestedPostId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  } catch (error) {
    if (!append) {
      posts = [];
      postList.replaceChildren();
    }
    retryAppend = append;
    setStatus(feedStatus, error.message, true);
    retryButton.hidden = false;
  }
}

function openEditor(post = null) {
  editingPostId = post?.id || null;
  postForm.reset();
  postType.disabled = Boolean(post);
  postType.value = post?.type || 'review';
  postForm.elements.title.value = post?.title || '';
  postForm.elements.content.value = post?.content || '';
  setRating(post?.rating || 0);
  document.querySelector('[data-post-form-title]').textContent = post ? 'Edit your post' : 'Write a post';
  updatePostFormType();
  setStatus(postStatus, '');
  postForm.hidden = false;
  postForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
  postForm.elements.title.focus({ preventScroll: true });
}

async function deletePost(postId) {
  const confirmed = await confirmModern({
    title: 'Delete this post?',
    message: 'This will remove the post and cannot be undone.',
    confirmText: 'Delete post',
    variant: 'danger'
  });
  if (!confirmed) return;
  try {
    await requestApi(`/api/forum/posts/${encodeURIComponent(postId)}`, { method: 'DELETE' });
    commentCache.delete(postId);
    await loadPosts();
  } catch (error) {
    setStatus(feedStatus, error.message, true);
  }
}

async function submitPost(event) {
  event.preventDefault();
  const type = postType.value;
  if (type === 'review' && selectedRating < 1) {
    setStatus(postStatus, 'Choose an application rating from 1 to 5 stars.', true);
    return;
  }
  const body = {
    type,
    title: postForm.elements.title.value.trim(),
    content: postForm.elements.content.value.trim(),
    ...(type === 'review' ? { rating: selectedRating } : {})
  };
  submitPostButton.disabled = true;
  setStatus(postStatus, editingPostId ? 'Saving changes…' : 'Publishing your post…');
  try {
    await requestApi(
      editingPostId ? `/api/forum/posts/${encodeURIComponent(editingPostId)}` : '/api/forum/posts',
      { method: editingPostId ? 'PATCH' : 'POST', body }
    );
    postForm.reset();
    postForm.hidden = true;
    editingPostId = null;
    setRating(0);
    commentCache.clear();
    await loadPosts();
  } catch (error) {
    setStatus(postStatus, error.message, true);
  } finally {
    submitPostButton.disabled = false;
    updatePostFormType();
  }
}

document.querySelector('[data-open-composer]')?.addEventListener('click', () => openEditor());
document.querySelector('[data-close-composer]')?.addEventListener('click', () => {
  postForm.hidden = true;
  editingPostId = null;
  postType.disabled = false;
  postForm.reset();
  setRating(0);
  setStatus(postStatus, '');
});
postForm?.addEventListener('submit', event => void submitPost(event));
postType?.addEventListener('change', updatePostFormType);
document.querySelectorAll('[data-rating-choice]').forEach(button => {
  button.addEventListener('click', () => setRating(Number(button.dataset.ratingChoice)));
  button.addEventListener('keydown', event => {
    const choices = [...document.querySelectorAll('[data-rating-choice]')];
    const index = choices.indexOf(button);
    const next = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? index + 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? index - 1
        : -1;
    if (next < 0) return;
    event.preventDefault();
    const choice = choices[(next + choices.length) % choices.length];
    setRating(Number(choice.dataset.ratingChoice));
    choice.focus();
  });
});
document.querySelectorAll('[data-filter]').forEach(button => {
  button.addEventListener('click', () => {
    currentFilter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(filter => {
      const active = filter === button;
      filter.classList.toggle('is-active', active);
      filter.setAttribute('aria-pressed', String(active));
    });
    setStatus(feedStatus, '');
    renderPosts();
  });
});
retryButton?.addEventListener('click', () => void loadPosts({ append: retryAppend }));
loadMorePostsButton?.addEventListener('click', () => {
  loadMorePostsButton.disabled = true;
  void loadPosts({ append: true }).finally(() => { loadMorePostsButton.disabled = false; });
});
updatePostFormType();
setRating(0);
void loadPosts();

if (cloudConfigured) {
  observeAuth((user, error) => setAuthState(user, error));
} else {
  setAuthState(null, new Error('Google sign-in is not configured on this site.'));
}
