import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../frontend/admin.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../frontend/src/admin.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('../frontend/src/admin.js', import.meta.url), 'utf8');

test('admin dashboard groups management tools into left-nav categories', () => {
  const categories = ['overview', 'users', 'access', 'revenue', 'pricing', 'community'];
  for (const category of categories) {
    assert.match(html, new RegExp(`data-admin-category-link="${category}"`));
    assert.match(html, new RegExp(`data-admin-category="${category}"`));
  }
  assert.match(html, /aria-label="Admin dashboard categories"/);
  assert.match(html, /data-admin-category="users"[\s\S]*?id="user-list"/);
  assert.match(html, /data-admin-category="access"[\s\S]*?id="voucher-list"/);
  assert.match(html, /data-admin-category="revenue"[\s\S]*?id="payment-list"/);
  assert.match(html, /data-admin-category="pricing"[\s\S]*?id="save-pricing-config"/);
  assert.match(html, /data-admin-category="community"[\s\S]*?id="forum-activity-list"/);
});

test('admin category navigation switches panels and adapts to narrow screens', () => {
  assert.match(source, /function selectAdminCategory\(category\)/);
  assert.match(source, /panel\.hidden = panel\.dataset\.adminCategory !== category/);
  assert.match(source, /button\.addEventListener\('click', \(\) => selectAdminCategory/);
  assert.match(styles, /#admin-content:not\(\[hidden\]\)\s*\{[\s\S]*?grid-template-columns:\s*220px minmax\(0,\s*1fr\)/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.admin-category-nav \{[\s\S]*?overflow-x: auto/);
});

test('hidden protected-area login panel stays hidden despite its grid layout', () => {
  assert.match(html, /<section id="access" class="admin-access">/);
  assert.match(source, /#access'\)\.hidden = true/);
  assert.match(styles, /#access\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
});

test('community content panel is expanded initially and supports toggling', () => {
  const contentPanel = html.match(/<details class="admin-card forum-content-card"[\s\S]*?<\/details>/)?.[0];
  assert.ok(contentPanel);
  assert.match(contentPanel, /<details[^>]*\bopen(?:\s|>)/);
  assert.match(contentPanel, /class="forum-content-toggle-label">Collapse content<\/span>/);
  assert.match(source, /panel\.addEventListener\('toggle'/);
  assert.match(source, /panel\.open \? `Collapse \$\{sectionName\}` : `Expand \$\{sectionName\}`/);
});

test('post and comment history is collapsed by default and supports expansion', () => {
  const historyPanel = html.match(/<details class="admin-card forum-activity-card"[\s\S]*?<\/details>/)?.[0];
  assert.ok(historyPanel);
  assert.doesNotMatch(historyPanel, /<details[^>]*\bopen(?:\s|>)/);
  assert.match(historyPanel, /class="forum-content-toggle-label">Expand history<\/span>/);
  assert.match(historyPanel, /id="forum-activity-refresh"/);
});

test('deleted post and comment activity entries are collapsed disclosures by default', () => {
  const renderEventStart = source.indexOf('function renderForumActivityEvent(');
  const loadActivityStart = source.indexOf('async function loadForumActivity(', renderEventStart);
  const renderEvent = source.slice(renderEventStart, loadActivityStart);
  assert.match(source, /const isDeleted = event\.eventType\.endsWith\('_deleted'\)/);
  assert.match(renderEvent, /<details class="forum-activity-entry forum-deleted-entry"><summary>/);
  assert.match(renderEvent, /'Deleted content' : 'Content', !isDeleted/);
  assert.doesNotMatch(renderEvent, /<details[^>]*\bopen(?:\s|>)/);
  assert.match(styles, /\.forum-deleted-entry\[open\] > summary::after/);
});

test('admin community content exposes permanent deletion for posts and comments', () => {
  assert.match(source, /data-permanent-delete="post"/);
  assert.match(source, /data-permanent-delete="comment"/);
  assert.match(source, /Permanently delete post and history/);
  assert.match(source, /Permanently delete comment and history/);
  assert.match(source, /This cannot be undone/);
  assert.match(source, /\/api\/admin\/forum\/permanent-delete/);
  assert.match(source, /method: 'POST'/);
});
