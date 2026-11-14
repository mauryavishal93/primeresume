import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../frontend/admin.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../frontend/src/admin.css', import.meta.url), 'utf8');
const aboutStyles = readFileSync(new URL('../frontend/src/about.css', import.meta.url), 'utf8');
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
  assert.match(source, /user\.isPro \? 'Pro · Voucher' : 'Voucher'/);
  assert.match(source, /user\.isPro \? 'Pro · Admin granted' : 'Admin granted'/);
  assert.match(source, /user\.isPro \? 'Pro' : status/);
  assert.match(source, /const accessAction = user\.isPro[\s\S]*?Cancel Pro access/);
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

test('user table groups secondary account actions in compact, accessible menus', () => {
  assert.match(source, /<details class="action-menu"><summary class="mini-button">Grant Pro/);
  assert.match(source, /<details class="action-menu"><summary class="mini-button secondary-filter">Manage/);
  assert.match(source, /action-menu-item danger" data-action="delete"/);
  assert.match(styles, /\.row-actions\s*\{[\s\S]*?display:\s*grid/);
  assert.match(styles, /\.action-menu-panel\s*\{[\s\S]*?position:\s*static/);
});

test('mobile site headers keep compact Google sign-in and main links on one row', () => {
  const pages = ['about', 'admin', 'billing', 'community', 'home', 'index', 'my-account', 'my-posts', 'pricing', 'support'];
  for (const page of pages) {
    const html = readFileSync(new URL(`../frontend/${page}.html`, import.meta.url), 'utf8');
    assert.match(html, /<body[^>]*\bsite-mobile-header\b/, `${page} should use the mobile header layout`);
  }
  const authNav = readFileSync(new URL('../frontend/src/auth-nav.js', import.meta.url), 'utf8');
  assert.match(authNav, /classList\.toggle\('auth-user-signed-in', Boolean\(user\) && !error\)/);
  assert.match(aboutStyles, /grid-template-columns:36px repeat\(3,minmax\(0,1fr\)\);grid-template-areas:"auth community plans editor" "theme theme theme theme"/);
  assert.match(aboutStyles, /body\.about-page\.site-mobile-header\.auth-user-signed-in:not\(\.admin-page\) \.about-nav\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\);grid-template-areas:"community plans editor" "theme theme theme"\}/);
  assert.match(aboutStyles, /body\.site-mobile-header\.admin-page \.about-nav\{display:grid;grid-template-columns:36px repeat\(3,minmax\(0,1fr\)\);grid-template-areas:"auth community plans editor" "theme theme theme theme"/);
  assert.match(aboutStyles, /body\.site-mobile-header\.admin-page\.auth-user-signed-in \.about-nav\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\);grid-template-areas:"community plans editor" "theme theme theme"\}/);
  assert.match(aboutStyles, /body\.site-mobile-header\.admin-page \.about-nav \.google-signin\{display:inline-flex;width:34px;min-width:34px;max-width:34px/);
  assert.doesNotMatch(aboutStyles, /body\.site-mobile-header\.admin-page \.about-nav \.google-signin::after\{content:"Google"/);
  const adminPage = readFileSync(new URL('../frontend/admin.html', import.meta.url), 'utf8');
  const aboutPage = readFileSync(new URL('../frontend/about.html', import.meta.url), 'utf8');
  assert.match(adminPage, /data-auth-sign-in[^>]*>[\s\S]*?<svg class="google-signin-logo"/);
  const googleIcon = page => page.match(/<svg class="google-signin-logo" viewBox="0 0 24 24" aria-hidden="true">[\s\S]*?<\/svg>/)?.[0]
    .replace(/>\s+</g, '><');
  assert.ok(googleIcon(adminPage));
  assert.equal(googleIcon(adminPage), googleIcon(aboutPage));
  assert.doesNotMatch(adminPage, /google-signin-mark/);
  assert.match(aboutStyles, /body\.site-mobile-header\.admin-page \.about-nav \.google-signin-logo\{width:18px;height:18px;flex-basis:18px\}/);
  assert.match(html, /<nav class="about-nav">[\s\S]*?data-auth-sign-in[\s\S]*?href="\/community\.html"/);
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

test('admin overview summary and metric cards use a compact two-column mobile layout', () => {
  const mobileStyles = styles.slice(styles.indexOf('@media (max-width: 720px)'));
  assert.match(mobileStyles, /\.admin-summary-bar\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(mobileStyles, /\.admin-stats\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(mobileStyles, /\.stat-header\s*\{[\s\S]*?display:\s*grid/);
  assert.match(mobileStyles, /\.admin-stats article\s*\{[\s\S]*?min-width:\s*0/);
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
