import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../frontend/src/community.js', import.meta.url), 'utf8');

test('deleting a comment rerenders with its own post load-more button', () => {
  const renderCommentsStart = source.indexOf('function renderComments(');
  const loadCommentsStart = source.indexOf('async function loadComments(', renderCommentsStart);
  const renderComments = source.slice(renderCommentsStart, loadCommentsStart);

  assert.match(renderComments, /function renderComments\(comments, list, status, loadMoreButton/);
  assert.match(renderComments, /renderComments\(updated, list, status, loadMoreButton,/);
  assert.doesNotMatch(renderComments, /renderComments\(updated, list, status, loadMoreCommentsButton,/);
});
