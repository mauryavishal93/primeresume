import { randomBytes } from 'node:crypto';

export const REFERRAL_CONFIG = Object.freeze({
  attributionWindowDays: 30,
  registrationRewardDays: 7,
  monthlyConversionRewardDays: 7,
  yearlyConversionRewardDays: 30,
  registrationReviewThreshold: 50,
  version: '2026-01'
});

export function referralsEnabled(env = process.env) {
  if (env.REFERRALS_ENABLED === undefined) return true;
  return ['true', '1', 'yes', 'on'].includes(String(env.REFERRALS_ENABLED).trim().toLowerCase());
}

export function generateReferralCode() {
  return randomBytes(9).toString('base64url').toUpperCase();
}

export function validReferralCode(value) {
  return typeof value === 'string' && /^[A-Z0-9_-]{10,40}$/.test(value);
}

export function maskReferralIdentity(email) {
  if (typeof email !== 'string' || !email.includes('@')) return 'ResumeOut member';
  const [name, domain] = email.toLowerCase().split('@');
  const domainParts = domain.split('.');
  const maskedName = name.length < 2 ? '*' : `${name[0]}${'*'.repeat(Math.min(name.length - 1, 5))}`;
  const maskedDomain = domainParts.length > 1
    ? `${domainParts[0][0]}***.${domainParts.at(-1)}`
    : '***';
  return `${maskedName}@${maskedDomain}`;
}

export function referralRewardDays(planKey) {
  if (planKey === 'monthly') return REFERRAL_CONFIG.monthlyConversionRewardDays;
  if (planKey === 'yearly') return REFERRAL_CONFIG.yearlyConversionRewardDays;
  return 0;
}

export function calculateReferralSummary(referrals = [], rewards = []) {
  const summary = {
    successfulRegistrations: 0,
    monthlyConversions: 0,
    yearlyConversions: 0,
    registrationRewardDays: 0,
    conversionRewardDays: 0,
    revokedConversionRewardDays: 0,
    totalPromotionalDaysEarned: 0
  };
  for (const referral of referrals) {
    if (['registered', 'payment_pending', 'converted', 'revoked'].includes(referral.status)) {
      summary.successfulRegistrations += 1;
    }
    if (referral.firstQualifyingPlanKey === 'monthly' && referral.firstQualifyingPaymentId) summary.monthlyConversions += 1;
    if (referral.firstQualifyingPlanKey === 'yearly' && referral.firstQualifyingPaymentId) summary.yearlyConversions += 1;
  }
  for (const reward of rewards) {
    const days = Number.isSafeInteger(reward.durationDays) ? reward.durationDays : 0;
    if (reward.rewardType === 'registration') summary.registrationRewardDays += days;
    if (reward.rewardType === 'conversion') summary.conversionRewardDays += days;
    if (reward.rewardType === 'reversal' && reward.originalRewardType === 'conversion') {
      summary.revokedConversionRewardDays += days;
    }
    if (reward.status !== 'revoked' && reward.rewardType !== 'reversal') summary.totalPromotionalDaysEarned += days;
  }
  return summary;
}

export function referralPageSize(value, fallback = 20) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.min(50, Math.max(1, parsed)) : fallback;
}

export function parseReferralCursor(value) {
  if (typeof value !== 'string' || value.length > 300) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof cursor?.id !== 'string' || !Number.isFinite(cursor.createdAt)) return null;
    return cursor;
  } catch {
    return null;
  }
}

export function encodeReferralCursor(document) {
  const data = document.data() || {};
  return Buffer.from(JSON.stringify({
    id: document.id,
    createdAt: Number(data.createdAt) || 0
  })).toString('base64url');
}

export function referralRewardSchedule({ now, days, paidUntil = 0, priorRewards = [] }) {
  const lastRewardEnd = priorRewards.reduce((latest, reward) => (
    reward.status === 'revoked' ? latest : Math.max(latest, Number(reward.expiresAt) || 0)
  ), 0);
  const startsAt = Math.max(now, paidUntil, lastRewardEnd);
  return { startsAt, expiresAt: startsAt + days * 86_400_000 };
}
