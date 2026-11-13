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

test('voucher-based Pro accounts are labeled as Voucher in the plan and activation column', () => {
  assert.match(source, /activationSource === 'voucher' \? 'Voucher'/);
});

test('admin typography uses consistent 12px, 14px, and 15px text categories', () => {
  assert.match(styles, /--admin-font-small:\s*12px/);
  assert.match(styles, /--admin-font-body:\s*14px/);
  assert.match(styles, /--admin-font-primary:\s*15px/);
  assert.match(styles, /body\.admin-page[\s\S]*?font-size:\s*var\(--admin-font-body\)/);
});

test('admin can cancel subscriptions immediately or at period end and manage account access', () => {
  const adminScript = readFileSync(new URL('../frontend/src/admin.js', import.meta.url), 'utf8');
  const adminPage = readFileSync(new URL('../frontend/admin.html', import.meta.url), 'utf8');
  assert.match(adminScript, /data-timing="immediate"/);
  assert.match(adminScript, /data-timing="period-end"/);
  assert.match(adminScript, /Cancel at next renewal/);
  assert.match(adminScript, /subscriptionId && !user\.cancelAtCycleEnd/);
  assert.match(adminScript, /\/ban`/);
  assert.match(adminScript, /\/unban`/);
  assert.match(adminScript, /method: 'DELETE'/);
  assert.match(adminPage, /id="cancel-timing"[\s\S]*?value="immediate"[\s\S]*?value="period-end"/);
});

test('billing, pricing, editor, and navigation refresh entitlement after admin changes', () => {
  const sources = [
    'auth-nav.js',
    'billing.js',
    'pricing.js',
    'main.js'
  ].map(file => readFileSync(new URL(`../frontend/src/${file}`, import.meta.url), 'utf8'));
  for (const script of sources) {
    assert.match(script, /loadBillingEntitlement\([^;]*forceRefresh:\s*true/);
  }
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
  assert.match(renderEvent, /event\.eventType === 'post_deleted'[\s\S]*?escapeHtml\(event\.postTitle\)/);
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

test('admin community posts have searchable, type, and deleted-status filters', () => {
  assert.match(html, /id="forum-post-search" type="search"/);
  assert.match(html, /id="forum-post-type"[\s\S]*?<option value="review">Reviews<\/option>[\s\S]*?<option value="discussion">Discussions<\/option>/);
  assert.match(html, /id="forum-post-status-filter"[\s\S]*?<option value="deleted">Deleted<\/option>/);
  assert.match(source, /query\.set\('search', \$\('#forum-post-search'\)\.value\.trim\(\)\)/);
  assert.match(source, /query\.set\('type', \$\('#forum-post-type'\)\.value\)/);
  assert.match(source, /query\.set\('status', \$\('#forum-post-status-filter'\)\.value\)/);
  assert.match(source, /\$\('#forum-post-search'\)\.addEventListener\('input', refreshFilteredForumPosts\)/);
  assert.match(styles, /\.forum-post-filters\s*\{[\s\S]*?grid-template-columns:\s*minmax\(180px, 1fr\)/);
});

test('admin community posts and comments are separate accessible tabs', () => {
  assert.match(html, /<div class="forum-content-tabs" role="tablist" aria-label="Community content">/);
  assert.match(html, /id="forum-posts-tab"[^>]*role="tab" aria-selected="true" aria-controls="forum-posts-panel"/);
  assert.match(html, />Posts and reviews<\/button>/);
  assert.match(html, /id="forum-comments-tab"[^>]*role="tab" aria-selected="false" aria-controls="forum-comments-panel"/);
  assert.match(html, />Comments<\/button>/);
  assert.match(html, /id="forum-posts-panel" role="tabpanel" aria-labelledby="forum-posts-tab"/);
  assert.match(html, /id="forum-comments-panel" role="tabpanel" aria-labelledby="forum-comments-tab"[^>]*hidden/);
  assert.match(source, /function selectForumContentTab\(tabName/);
  assert.match(source, /tab\.setAttribute\('aria-selected', String\(active\)\)/);
  assert.match(source, /event\.key === 'ArrowRight' \|\| event\.key === 'ArrowDown'/);
});

test('admin current deleted posts display their title without a community hyperlink', () => {
  const renderStart = source.indexOf('function renderForumContentItem(');
  const deleteStart = source.indexOf('async function permanentlyDeleteForumContent(', renderStart);
  const renderItem = source.slice(renderStart, deleteStart);
  assert.match(renderItem, /kind === 'posts' && item\.isDeleted[\s\S]*?escapeHtml\(title \|\| ''\)/);
});
