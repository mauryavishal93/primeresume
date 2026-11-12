import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../frontend/src/community.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../frontend/src/community.css', import.meta.url), 'utf8');
const adminSource = readFileSync(new URL('../frontend/src/admin.js', import.meta.url), 'utf8');
const myPostsSource = readFileSync(new URL('../frontend/src/my-posts.js', import.meta.url), 'utf8');

test('deleting a comment rerenders with its own post load-more button', () => {
  const renderCommentsStart = source.indexOf('function renderComments(');
  const loadCommentsStart = source.indexOf('async function loadComments(', renderCommentsStart);
  const renderComments = source.slice(renderCommentsStart, loadCommentsStart);

  assert.match(renderComments, /function renderComments\(comments, list, status, loadMoreButton/);
  assert.match(renderComments, /renderComments\(updated, list, status, loadMoreButton,/);
  assert.doesNotMatch(renderComments, /renderComments\(updated, list, status, loadMoreCommentsButton,/);
});

test('comments are styled as a responsive visual conversation thread', () => {
  assert.match(styles, /\.community-comment-list:has\(> \.community-comment\)::before\s*\{[\s\S]*?background:\s*linear-gradient\(180deg/);
  assert.match(styles, /\.community-comment::before\s*\{[\s\S]*?border-radius:\s*50%/);
  assert.match(styles, /\.community-comment::after\s*\{[\s\S]*?background:\s*rgba\(211, 185, 121, \.38\)/);
  assert.match(styles, /@media \(max-width: 700px\) \{[\s\S]*?\.community-comment-list \{[\s\S]*?padding-left:\s*15px/);
});

test('editing a post exposes Cancel beside Save changes and discards edits when cancelled', () => {
  const html = readFileSync(new URL('../frontend/community.html', import.meta.url), 'utf8');
  assert.match(html, /data-cancel-edit hidden>Cancel<\/button>\s*<button[^>]*data-submit-post/);
  assert.match(source, /cancelEditButton\.hidden = !post/);
  assert.match(source, /cancelEditButton\?\.addEventListener\('click', closeEditor\)/);
  assert.match(source, /function closeEditor\(\) \{[\s\S]*?postForm\.hidden = true;[\s\S]*?editingPostId = null;[\s\S]*?postForm\.reset\(\)/);
});

test('comment owners can edit inline and cancel without saving', () => {
  assert.match(source, /if \(currentUser && comment\.isOwner\) \{[\s\S]*?community-comment-edit/);
  assert.match(source, /method: 'PATCH',\s*body: \{ content \}/);
  assert.match(source, /cancel\.addEventListener\('click', \(\) => renderComments\(/);
  assert.match(source, /const updated = \{ \.\.\.comment, \.\.\.result\.comment, postId \}/);
});

test('comment edit history shows previous and updated text in user and admin history', () => {
  assert.match(adminSource, /comment_edited: 'Edited comment'/);
  assert.match(adminSource, /event\.eventType === 'post_edited' \|\| event\.eventType === 'comment_edited'/);
  assert.match(myPostsSource, /comment_edited: 'Edited comment'/);
  assert.match(myPostsSource, /event\.eventType === 'post_edited' \|\| event\.eventType === 'comment_edited'/);
});

test('comment toggle displays total comment count and updates it after loading', () => {
  assert.match(source, /commentCounts\.set\(post\.id, Number\.isInteger\(post\.commentCount\) \? post\.commentCount : 0\)/);
  assert.match(source, /updateCommentsButton\(commentsButton, commentCounts\.get\(post\.id\), false\)/);
  assert.match(source, /if \(!post\.commentCount\) void refreshCommentCount\(post\.id, commentsButton\)/);
  assert.match(source, /comments\?countOnly=1/);
  assert.match(source, /updateCommentsButton\(button, result\.totalCount\)/);
  assert.match(source, /updateCommentsButton\(commentsButton, commentCounts\.get\(post\.id\), !comments\.hidden\)/);
  assert.match(source, /commentCounts\.set\(postId, Number\.isInteger\(result\.totalCount\) \? result\.totalCount : allComments\.length\)/);
  assert.match(source, /const label = count === undefined \? 'comments' : `comments \(\$\{count\}\)`/);
  assert.match(source, /button\.textContent = `\$\{action\} \$\{label\}`/);
  assert.match(source, /button\.setAttribute\('aria-label', `\$\{action\} comments/);
});

test('Community typography uses compact forum-style heading and post text sizes', () => {
  assert.match(styles, /\.community-hero h1\s*\{[\s\S]*?font-size:\s*clamp\(1\.8rem, 4vw, 2\.5rem\)/);
  assert.match(styles, /\.community-feed-heading h2\s*\{[\s\S]*?font-size:\s*clamp\(20px, 2\.5vw, 25px\)/);
  assert.match(styles, /\.community-post-card h3\s*\{[\s\S]*?font-size:\s*16px/);
  assert.match(styles, /\.community-post-content,\s*\.community-comment-content\s*\{[\s\S]*?font-size:\s*14px/);
  assert.match(styles, /\.community-hero h1\s*\{[\s\S]*?font-size:\s*clamp\(1\.65rem, 7vw, 2rem\)/);
});

test('expanded comments use a compact inline composer and a minimal empty state', () => {
  assert.match(source, /textarea\.rows = 1/);
  assert.match(source, /textarea\.setAttribute\('aria-label', 'Add a comment'\)/);
  assert.match(styles, /\.community-comment-form\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  assert.match(styles, /\.community-comment-form \.community-field textarea\s*\{[\s\S]*?min-height:\s*40px;[\s\S]*?height:\s*40px;[\s\S]*?border-radius:\s*20px/);
  assert.match(styles, /\.community-comment-list > \.community-empty\s*\{[\s\S]*?padding:\s*6px 0;[\s\S]*?text-align:\s*left/);
});
