import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REFERRAL_CONFIG,
  calculateReferralSummary,
  generateReferralCode,
  maskReferralIdentity,
  referralPageSize,
  referralRewardDays,
  referralRewardSchedule,
  referralsEnabled,
  validReferralCode
} from '../backend/referrals.js';
import { buildReferralShareMessage, buildReferralShareUrl } from '../frontend/src/referral-sharing.js';

const server = readFileSync(new URL('../backend/server.js', import.meta.url), 'utf8');
const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
const page = readFileSync(new URL('../frontend/referrals.html', import.meta.url), 'utf8');
const client = readFileSync(new URL('../frontend/src/referrals.js', import.meta.url), 'utf8');

test('referral configuration is enabled by default and can be disabled by the backend flag', () => {
  assert.equal(referralsEnabled({}), true);
  assert.equal(referralsEnabled({ REFERRALS_ENABLED: 'false' }), false);
  assert.equal(referralsEnabled({ REFERRALS_ENABLED: 'true' }), true);
  assert.deepEqual(REFERRAL_CONFIG, {
    attributionWindowDays: 30,
    registrationRewardDays: 7,
    monthlyConversionRewardDays: 7,
    yearlyConversionRewardDays: 30,
    registrationReviewThreshold: 50,
    version: '2026-01'
  });
});

test('referral codes are opaque and plan rewards match the specified durations', () => {
  const first = generateReferralCode();
  const second = generateReferralCode();
  assert.match(first, /^[A-Z0-9_-]{10,40}$/);
  assert.notEqual(first, second);
  assert.equal(validReferralCode(first), true);
  assert.equal(validReferralCode('short'), false);
  assert.equal(referralRewardDays('monthly'), 7);
  assert.equal(referralRewardDays('yearly'), 30);
  assert.equal(referralRewardDays('weekly'), 0);
});

test('referral identities are masked and reward stacking preserves current Pro time', () => {
  assert.equal(maskReferralIdentity('alex@example.com'), 'a***@e***.com');
  assert.equal(maskReferralIdentity('invalid'), 'ResumeOut member');
  assert.deepEqual(referralRewardSchedule({
    now: 100,
    paidUntil: 200,
    priorRewards: [{ status: 'active', expiresAt: 300 }, { status: 'revoked', expiresAt: 500 }],
    days: 7
  }), { startsAt: 300, expiresAt: 604800300 });
});

test('referral sign-in buttons use the shared Google mark and stay visible in the sign-in card', () => {
  const signInButtons = [...page.matchAll(/<button class="btn google-signin"[^>]*data-auth-sign-in>([\s\S]*?)<\/button>/g)];
  assert.equal(signInButtons.length, 2);
  for (const [, button] of signInButtons) {
    assert.match(button, /<svg class="google-signin-logo" viewBox="0 0 24 24"/);
    assert.match(button, /<span data-auth-sign-in-label>Sign in with Google<\/span>/);
  }

  const styles = readFileSync(new URL('../frontend/src/referrals.css', import.meta.url), 'utf8');
  assert.match(styles, /\.referrals-sign-in\s*\{\s*display:\s*grid;\s*justify-items:\s*center;[\s\S]*?text-align:\s*center/);
  assert.match(styles, /\.referrals-sign-in \.google-signin,[\s\S]*?\.referrals-page \.about-nav \.auth-actions \.google-signin/);
  assert.match(styles, /@media\(max-width:760px\)\{[\s\S]*?grid-template-areas:"auth community plans editor" "theme theme theme theme"/);
  assert.match(styles, /\.referrals-page \.about-nav\{grid-area:nav;width:100%;min-width:0;justify-self:stretch\}/);
  assert.match(styles, /body\.site-mobile-header:not\(\.admin-page\) \.about-nav \.google-signin \[data-auth-sign-in-label\]/);
  assert.match(styles, /white-space:nowrap/);
});

test('referral message has one link after Get started and is reused by every sharing option', () => {
  const url = 'https://www.resumeout.com/?ref=INVITECODE12';
  const message = buildReferralShareMessage(url, 'INVITECODE12');
  const linkPosition = message.indexOf(url);
  assert.ok(linkPosition > message.indexOf('Get started today:'));
  assert.equal(message.slice(0, linkPosition).includes('https://'), false);
  assert.equal((message.match(/https:\/\//g) || []).length, 1);
  assert.match(message, /Your referral code: INVITECODE12/);

  for (const service of ['whatsapp', 'telegram', 'facebook', 'x', 'linkedin']) {
    const shareUrl = new URL(buildReferralShareUrl(service, message, url));
    if (service === 'facebook') {
      assert.equal(shareUrl.searchParams.get('u'), url);
      assert.equal(shareUrl.searchParams.has('quote'), false);
      assert.equal(shareUrl.searchParams.has('text'), false);
    } else {
      assert.equal(shareUrl.searchParams.get('text'), message, `${service} should share the same full message`);
    }
  }
});

test('referral summary counts issued, converted, and separately revoked days', () => {
  assert.deepEqual(calculateReferralSummary([
    { status: 'registered' },
    { status: 'revoked', firstQualifyingPlanKey: 'monthly', firstQualifyingPaymentId: 'pay_1' },
    { status: 'converted', firstQualifyingPlanKey: 'yearly', firstQualifyingPaymentId: 'pay_2' }
  ], [
    { rewardType: 'registration', durationDays: 7, status: 'active' },
    { rewardType: 'conversion', durationDays: 7, status: 'active' },
    { rewardType: 'reversal', originalRewardType: 'conversion', durationDays: 7, status: 'revoked' }
  ]), {
    successfulRegistrations: 3,
    monthlyConversions: 1,
    yearlyConversions: 1,
    registrationRewardDays: 7,
    conversionRewardDays: 7,
    revokedConversionRewardDays: 7,
    totalPromotionalDaysEarned: 14
  });
});

test('user referral page and server support pagination, verified reversals, and private ledger data', () => {
  assert.ok(referralPageSize('999') === 50);
  assert.ok(referralPageSize('0') === 1);
  assert.match(page, /data-referral-history/);
  assert.match(page, /data-reward-ledger/);
  assert.match(page, /<section class="referrals-hero">[\s\S]*?Refer friends[\s\S]*?<section class="referral-steps"/);
  assert.match(page, /data-share-invite/);
  assert.match(page, /<code data-referral-code>[\s\S]*?<\/code>/);
  assert.match(page, /data-referral-message/);
  assert.match(page, /data-copy-message/);
  assert.ok(page.indexOf('<section class="referral-link-card"') < page.indexOf('<div class="referrals-content"'));
  assert.match(page, /This general link does not track referrals/);
  assert.match(page, /data-referral-metrics/);
  assert.match(page, /<details class="referral-message">[\s\S]*?<\/details>/);
  assert.match(page, /data-telegram/);
  assert.match(page, /data-whatsapp[^>]*aria-label="Share via WhatsApp">[\s\S]*?<svg viewBox="0 0 24 24"/);
  assert.doesNotMatch(page, /data-whatsapp[^>]*>wa<\/a>/);
  assert.match(page, /data-facebook/);
  assert.match(page, /data-x-social/);
  assert.match(page, /data-linkedin/);
  assert.match(page, /data-share-invite/);
  assert.match(page, /data-facebook-share-dialog/);
  assert.match(page, /Facebook does not allow websites to prefill post text/);
  assert.match(page, /data-facebook-continue[^>]*target="_blank"/);
  assert.match(readFileSync(new URL('../frontend/src/referrals.css', import.meta.url), 'utf8'), /\.referrals-content\[hidden\][^}]*display:none/);
  assert.match(client, /navigator\.share/);
  assert.match(client, /referralShareMessage\(\)/);
  assert.match(client, /facebookShareLink\.addEventListener\('click', event => \{[\s\S]*?facebookContinueLink\.href = shareUrlFor\('facebook'\)/);
  assert.match(client, /facebookShareLink\.addEventListener\('click', event => \{\s+event\.preventDefault\(\)/);
  assert.match(client, /facebookShareDialog\.showModal\(\)/);
  assert.match(client, /Message copied\. Click “Open Facebook”/);
  assert.match(client, /Copy failed\. Select the message above and copy it manually\./);
  assert.match(client, /referralUrl = 'https:\/\/www\.resumeout\.com\/'/);
  assert.match(client, /updateShareLinks\(\)/);
  assert.match(client, /signInPanel\.hidden = Boolean\(user\)/);
  assert.match(client, /No referral history\./);
  assert.match(server, /function referralHistoryIndexUnavailable/);
  assert.match(server, /Using the fallback reader for \$\{collection\}/);
  assert.match(client, /renderListError\(historyBody, 'Referral history could not be loaded right now/);
  assert.match(client, /renderListError\(ledgerBody, 'Reward history could not be loaded right now/);
  assert.match(client, /data\.summaryError \|\| 'Referral dashboard loaded\.'/);
  assert.match(readFileSync(new URL('../frontend/src/referral-sharing.js', import.meta.url), 'utf8'), /Get started today:\n\$\{shareUrl\}/);
  assert.match(server, /\/api\/referrals\/history/);
  assert.match(server, /\/api\/referrals\/rewards/);
  assert.match(server, /payment\.dispute\.lost/);
  assert.match(server, /verified-immediate-cancellation/);
  assert.match(server, /verified-refund/);
  assert.match(server, /referralPaymentReversals/);
  assert.doesNotMatch(server, /transaction\.set\(originalRewardRef/);
  assert.match(rules, /match \/referralRewards\/\{rewardId\}[\s\S]*?allow read, write: if false/);
  assert.match(rules, /match \/referralAdminAudit\/\{auditId\}[\s\S]*?allow read, write: if false/);
});
