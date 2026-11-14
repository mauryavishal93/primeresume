# Referral & Rewards

## Architecture

Referral logic lives in `backend/referrals.js` and authenticated/public API handlers in `backend/server.js`. Firebase Authentication ID tokens identify users; Admin SDK account creation metadata is used to establish new-account eligibility. Razorpay rewards are granted only in the signed `subscription.charged` webhook path after the backend re-fetches both the captured payment and its active subscription. Refunds, lost disputes, and immediate cancellations are re-fetched from Razorpay before the linked conversion reward is reversed.

The user experience is a separate `/referrals.html` page (`frontend/src/referrals.js` and `frontend/src/referrals.css`). The Admin Dashboard has a separate Referrals category. User reads and all writes go through authenticated server APIs. Firestore rules deny direct client access to referral data.

## Firestore data

| Collection | Purpose |
| --- | --- |
| `referralCodes` | Opaque code, owner UID, active state, version, registration count |
| `referralUserCodes` | Unique code mapping for each owner UID |
| `referralAttributions` | First-touch code and 30-day server timestamp window; keyed by an HttpOnly-cookie UUID |
| `referralByUser` | Enforces one referral attribution per referred UID |
| `referrals` | Referral relationship, eligibility outcome, qualifying payment/subscription, and status |
| `referralRewards` | Append-only reward and reversal ledger |
| `referralUserSummaries` | Per-user reward stacking watermark and aggregate issued-day counters |
| `referralPaymentReversals` | Verified payment-level reversal marker, preventing a delayed payment event from rewarding a charged-back payment |
| `referralRewardEvents` | Immutable system reversal audit records |
| `referralAdminAudit` | Administrator action, target, reason, actor, timestamp, and before/after state |

Reward ledger rows are not overwritten or deleted. A reversal is a separate row linked by `originalRewardId`; the user-facing ledger derives the original reward's revoked status from that reversal. The `firestore.indexes.json` file contains the composite indexes used for referral history. Reward history is sorted and paginated from the beneficiary-scoped read, so it does not depend on a composite history index. Deploy the indexes and rules before enabling the feature.

## Reward and entitlement semantics

- Attribution expires 30 days after the server records the first valid referral link. A later code cannot replace an unexpired first-touch attribution.
- Firebase Auth creation time must be on or after the recorded attribution (within Firebase's one-second creation-time precision) and inside the 30-day window. One server-side UID mapping prevents duplicate attribution. Self-referrals and disabled codes are rejected.
- A new account opened from a referral URL is sent to My Account on its first Google sign-in, with the referral code prefilled. The new user applies it there. A new account signed in without a referral URL can enter a code on My Account within 30 days of creation. The server verifies the account age and code owner; a referral UID mapping permanently prevents that account from using a second code. Applying the code credits the same 7-day registration rewards as a valid referral link.
- Normal eligible registration credits 7 days to each party. A code reaching 50 registered accounts is flagged for admin review; no registration days are credited until approved. Rejection does not issue rewards.
- The first verified captured monthly payment credits 7 days to the referrer; yearly credits 30 days. Captured state and active subscription state are fetched from Razorpay. A payment-level reversal marker prevents an out-of-order chargeback event from being followed by a reward.
- Reward `startsAt` is the latest of issue time, the currently known Pro `validUntil`, and that beneficiary's prior reward-stack watermark. This keeps paid-through dates and Razorpay billing data untouched.
- `/api/billing/entitlement` combines currently valid and scheduled, non-reversed promotional periods with the existing server-verified entitlement in its response only. For a currently active Pro account, the displayed expiry includes earned referral days stacked after the current paid-through date. Future-only rewards do not activate an otherwise inactive account early. The API never writes promotional expiry into the paid entitlement document.
- Period-end cancellation leaves the conversion reward intact while the provider reports a future paid-through date. Only a verified inactive subscription with no remaining paid period, verified refund, or verified lost dispute reverses the linked conversion reward. Registration rewards are unaffected.

## API

### User

- `GET /api/referrals/config` — feature availability.
- `POST /api/referrals/attribution` — public code resolution; first-touch cookie only.
- `POST /api/referrals/register` — authenticated new-user eligibility and registration reward processing.
- `GET /api/referrals/claim-status` — authenticated, server-verified status for the one-time 30-day manual referral-code claim.
- `GET /api/referrals/me` — own code, complete referral URL, and summary.
- `GET /api/referrals/history?limit=20&cursor=...` — own masked referral history. An empty result is rendered as “No referral history.” If the composite history index is unavailable, the server falls back to the same user-scoped database read and sorts/pages those records.
- `GET /api/referrals/rewards?limit=20&cursor=...` — own paginated reward ledger.

### Admin

- `GET /api/admin/referrals/summary` — dashboard metrics.
- `GET /api/admin/referrals?status=...&search=...&limit=...&cursor=...` — searchable/paginated referral table.
- `GET /api/admin/referral-details/:referralId` — referral, ledger, and audit details.
- `POST /api/admin/referrals/:referralId/action` — approve/reject a pending review or reverse its conversion reward; every action requires a reason.
- `POST /api/admin/referrals/:referralId/adjustment` — issue a separately identified positive promotional adjustment; this does not change billing.
- `POST /api/admin/referrals/codes/:code/action` — enable or disable a code with a reason.
- `GET /api/admin/referrals/export.csv?status=...&search=...` — export filtered referral rows.

All Admin routes require a verified Firebase ID token and server-side admin authorization. Admin mutations require confirmation in the UI and record an audit entry.

## Configuration and rollout

Backend environment:

```text
REFERRALS_ENABLED=true
PUBLIC_SITE_URL=https://resumeout.com
```

Referrals are enabled when `REFERRALS_ENABLED` is absent; set it to `false` to disable referral APIs and rewards. Configure it as `true` in the deployed backend to make the intended state explicit. Before rollout:

1. Deploy Firestore rules and indexes.
2. Verify backend Firebase Admin credentials and Razorpay server credentials in a staging environment.
3. Configure Razorpay webhooks for subscription lifecycle, `payment.refunded`, and `payment.dispute.lost`.
4. Test new and existing accounts, first-touch expiry, monthly/yearly verified conversion, duplicate and out-of-order events, period-end cancellation, immediate cancellation, refund, lost dispute, code review, and admin audit/export.
5. Monitor webhook failures, `referralRewardEvents`, `referralAdminAudit`, pending reviews, and reward/entitlement discrepancies during a small pilot.

No existing user, subscription, payment, plan, or entitlement data migration is required. New collections are created lazily by server APIs. To roll back, set `REFERRALS_ENABLED=false`; existing referral ledgers remain intact and ordinary billing continues to use its original entitlement data. Do not delete referral records as a rollback step.
