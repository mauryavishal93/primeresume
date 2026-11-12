import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../frontend/src/community.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../frontend/src/community.css', import.meta.url), 'utf8');

test('deleting a comment rerenders with its own post load-more button', () => {
  const renderCommentsStart = source.indexOf('function renderComments(');
  const loadCommentsStart = source.indexOf('async function loadComments(', renderCommentsStart);
  const renderComments = source.slice(renderCommentsStart, loadCommentsStart);

  assert.match(renderComments, /function renderComments\(comments, list, status, loadMoreButton/);
  assert.match(renderComments, /renderComments\(updated, list, status, loadMoreButton,/);
  assert.doesNotMatch(renderComments, /renderComments\(updated, list, status, loadMoreCommentsButton,/);
});

test('comments are styled as a responsive visual conversation thread', () => {
  assert.match(styles, /\.community-comment-list:not\(:empty\)::before\s*\{[\s\S]*?background:\s*linear-gradient\(180deg/);
  assert.match(styles, /\.community-comment::before\s*\{[\s\S]*?border-radius:\s*50%/);
  assert.match(styles, /\.community-comment::after\s*\{[\s\S]*?background:\s*rgba\(211, 185, 121, \.38\)/);
  assert.match(styles, /@media \(max-width: 700px\) \{[\s\S]*?\.community-comment-list \{[\s\S]*?padding-left:\s*17px/);
});
