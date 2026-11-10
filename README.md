# ResumeOut.com

A browser-based resume editor with multiple templates, editable sections, JSON project import/export, guest browser-saving controls, Google sign-in and Firebase cloud resume storage, and high-resolution PDF export with selectable text. Signed-in users reopen the cloud resume they last worked on. PDF downloads are capped below 500 KB; the exporter balances image resolution and JPEG quality, and blocks downloads if a resume cannot fit at readable settings.

## Requirements

- Node.js 22.x
- npm 10 or newer

## Setup

```sh
npm install
npm run start:all
```

This builds the frontend and starts the frontend and API together at `http://localhost:3000`. Billing remains disabled unless all server-side configuration is present. For frontend hot reload during development, use `npm run dev` and run `npm run backend` in a second terminal.

### Local admin dashboard

The admin page is available at `http://localhost:3000/admin.html` when using `npm run start:all`. Set `FIREBASE_SERVICE_ACCOUNT_JSON` to a server-only service account for this Firebase project and `ADMIN_EMAILS` to the Google account allowed to administer it in the root `.env` file. Use `localhost` (not `127.0.0.1`) for Google sign-in, and add `localhost` to Firebase Authentication's authorized domains if needed. Never commit the service-account JSON. The dashboard reports missing backend credentials or access configuration instead of treating API failures as an authorization denial.

## Deploy on Vercel

Import this repository into Vercel with the repository root as the project root. `vercel.json` runs `npm run build` and publishes Vite's `dist/` output. The catch-all function in `api/[...path].js` runs the Express API directly on Vercel; no Render backend is required. Use Node.js 22.x.

Add `FIREBASE_SERVICE_ACCOUNT_JSON` and `ADMIN_EMAILS` under **Project Settings → Environment Variables** in Vercel, then redeploy. Add the Razorpay and billing release variables there only when enabling paid checkout. Do not copy `.env` into the repository or expose server credentials as `VITE_*` variables.

## Production

The public Vercel site is `https://resumeout.vercel.app`. Public resume share links use this stable domain; local-development share links also point to it.

```sh
npm run build
npm start
```

The production build is generated in `dist/`. `npm start` serves the site and billing API; run `npm run build` first.

## Deploy on Render

The root `render.yaml` configures a Render Node web service that serves the built site and trusted billing API. Push it to the `main` branch, then in Render choose **New > Blueprint** and connect `mauryavishal93/primeresume`. Render runs `npm install && npm run build`, then `npm start`. Approve the `buildmyportfolio` service to start the deploy. Because the GitHub repository is private, authorize Render to access it when prompted. Configure the secret environment variables described below before enabling billing.

The site is multi-page: `/` opens the editor; `/editor.html` is the editor page; `/about.html` is the About page; `/privacy.html` is the privacy policy; `/pricing.html` is the plan and purchase page; `/terms.html` describes service terms; and `/refunds.html` describes refund status.

## Project structure

- `frontend/index.html`, `frontend/editor.html`, `frontend/about.html`, and `frontend/privacy.html` are the main HTML entry points.
- `frontend/pricing.html`, `frontend/src/pricing.js`, and `frontend/src/billing-client.js` provide the signed-in monthly/yearly purchase experience and call the same-origin billing API.
- `frontend/src/main.js` owns editor state, resume rendering, editing controls, local autosave, JSON import/export, and PDF workflows.
- `Templates/` contains the resume template registry and each template's metadata and styles; the six Free templates and 19 Pro templates share the editor renderer.
- `frontend/src/plan-access.js` centralizes the Free/Pro feature definitions and UI gates. Editor access is based on entitlements loaded from the server; browser code is not the payment authority.
- `frontend/src/firebase-cloud.js` provides Google authentication and per-user Firestore resume storage. Firebase SDK modules are loaded only when cloud/auth features are used.
- `backend/server.js` verifies Firebase ID tokens, manages unlisted resume-share links with Firebase Admin, creates Razorpay subscriptions, verifies checkout signatures and provider state, processes signed webhooks, supports cancellation, and manages server-side Firestore entitlements.
- `backend/billing.js` contains server-owned prices, subscription intervals, signature checks, and entitlement validity logic.
- `firestore.rules` restricts resume documents to their authenticated owner and explicitly blocks all client access to billing documents. `firebase.json` maps the rules for Firebase CLI rules-only deployments; it does not configure Firebase Hosting.
- `frontend/src/ats-scoring.js`, `frontend/src/cover-letter.js`, `frontend/src/cover-letter-pdf.js`, and `frontend/src/zoom.js` contain focused editor helpers.
- `frontend/src/style.css` and `frontend/src/about.css` contain editor and informational-page styles.
- `vite.config.js` configures the frontend build and local API proxy. `tests/` contains the Node.js test suite.

## Data flow

Guest resumes are saved in this browser by default. The editor header's **Save in this browser** toggle controls whether guest resume data is autosaved to `localStorage`; when off, edits stay in memory and are discarded on refresh or page close. The preference is remembered. Google-authenticated resumes always use account-scoped Firebase cloud storage and are never written to guest resume storage. The ID of the last-opened cloud resume is stored in a private account preference, so the editor reopens that resume on the user's next visit; if it was deleted, the most recently updated resume is opened instead. If the account has no saved resumes, a guest draft can be migrated or a new cloud resume is created. Unlisted resume links are created and revoked through the authenticated server API; anyone with an active link can open its snapshot, and recipient edits remain separate from the owner's original. If saved project data cannot be read, the editor pauses autosave, keeps the original data available for download, and asks before replacing it; a valid legacy copy can be recovered. JSON imports are limited to 5 MB and validated before replacing the current project. Signed-in Free users may use any Pro template and get two lifetime Pro-template PDF downloads per Google account; each download counts, including repeats. Firestore rules protect account-scoped data and the account counter; active server-verified Pro subscribers are not limited. Deploy the updated rule before enabling this allowance with `firebase deploy --only firestore:rules`.

Paid plan purchases require a signed-in Google account. The backend verifies the Firebase ID token, creates the subscription with a server-selected Razorpay plan, verifies the checkout signature and Razorpay subscription/payment state, and activates entitlements only from verified checkout/provider events. A signed-in user can cancel future renewals; access remains valid through the current paid period. Resume contents and job descriptions are not sent to Razorpay.

## Free and Pro plans

Core resume editing, six templates, two lifetime Pro-template PDF downloads after Google sign-in, standard PDF export, resume-only ATS checks, basic cover-letter tools, JSON backup, and browser autosave remain free. Pro is a recurring subscription until canceled. New subscriptions are billed in INR only, regardless of browser locale. The initial prices are ₹99 per month or ₹399 per year. Administrators can set current and list prices in the admin dashboard. Pro includes all 25 templates, unlimited Pro-template PDF downloads, and job-description ATS matching.

Checkout fails closed until the server is fully configured. For a safe Vercel sandbox, configure test credentials only in the **Preview** environment. The backend enables test checkout only when `BILLING_TEST_MODE_ENABLED=true`, `BILLING_ENABLED=true`, `VERCEL_ENV=preview`, and the Razorpay Key ID starts with `rzp_test_`. Test credentials are rejected on Vercel Production, and live credentials are rejected on Preview.

For localhost testing, add the rotated Razorpay **Test Mode** key pair, monthly/yearly Test Mode plan IDs, webhook secret, and Firebase service account to the ignored root `.env` file. Set `BILLING_ENABLED=true` and `BILLING_LOCAL_TEST_MODE_ENABLED=true`; local checkout is accepted only with test keys when Vercel deployment environment variables are absent (or Vercel CLI reports `VERCEL_ENV=development`). This flag cannot enable checkout on Vercel Preview or Production. Run the backend and Vite frontend with `npm run backend` and `npm run dev`. A local webhook requires a reachable HTTPS tunnel configured as the Razorpay Test Mode webhook URL ending in `/api/billing/webhook`; never use live credentials locally.

1. Create Razorpay Plans for INR 99 monthly and INR 399 yearly, each with interval 1, and set their IDs as `RAZORPAY_PLAN_MONTHLY_ID` and `RAZORPAY_PLAN_YEARLY_ID`. These seed the default prices and are required to enable checkout. Admins can update INR checkout prices in the admin dashboard; the backend creates and verifies matching Razorpay plans before publishing changes. New checkout requests in any currency other than INR are rejected. Before creating a subscription, the backend fetches and verifies the selected provider plan's amount, currency, and interval; the browser cannot set the charge amount.
2. In Vercel **Preview** environment variables, configure the test `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_PLAN_MONTHLY_ID`, and `RAZORPAY_PLAN_YEARLY_ID`. Also set `FIREBASE_SERVICE_ACCOUNT_JSON` to a server-only Firebase service account JSON with only the permissions needed to verify Firebase Authentication ID tokens and access billing records. Firebase client rules explicitly deny access to billing documents.
3. Create a Razorpay Test Mode webhook pointing to `https://<preview-deployment-url>/api/billing/webhook`. Subscribe to `subscription.activated`, `subscription.charged`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`, and `subscription.expired`. Set the webhook's secret as `RAZORPAY_WEBHOOK_SECRET` in Vercel **Preview**. The backend verifies signatures against the exact raw body and records event IDs for idempotency.
4. Set `BILLING_ENABLED=true` and `BILLING_TEST_MODE_ENABLED=true` in Vercel **Preview**, then redeploy the Preview. Do not set these test credentials or this test-mode flag in **Production**. Keep the Production billing and release-approval flags disabled while reviewing and publishing final service terms and refund information.
5. After test-mode purchases, renewals, failed payments, cancellations, webhook replay, and expired entitlements have been verified and final policies are published, configure separate **live-mode** API keys, live plan IDs, and a live webhook secret in Vercel **Production**. Only then set `BILLING_TERMS_PUBLISHED=true`, `BILLING_REFUNDS_PUBLISHED=true`, `BILLING_TEST_MODE_VERIFIED=true`, `BILLING_LIVE_LAUNCH_APPROVED=true`, and `BILLING_ENABLED=true` in Production. Never copy test credentials to Production or provider secrets to Vite variables, frontend code, or browser storage.
6. Optional vouchers are configured privately using the Render `PRO_VOUCHERS_JSON` server environment variable, for example `[{"code":"PRIVATE-CODE-123","durationDays":30,"maxRedemptions":50}]`. Use uppercase alphanumeric codes with optional hyphens, durations from 1 to 3,650 days, and a redemption cap. Codes are never returned by the public config endpoint; sample codes shown in the pricing page are examples only. Redemption requires Google sign-in and is limited to once per account per code. Public configured vouchers can be redeemed by any signed-in account; account-specific admin vouchers remain restricted to their assigned account. If Pro access is already active, the voucher is queued to start after the current access expires. Checkout can remain disabled while vouchers are active.

The configured Razorpay subscriptions cover up to 100 years of billing cycles. Using Razorpay test credentials, verify purchases, renewals, failed payments, cancellations, webhook replay, and expired entitlements. Record and review those results, verify the production webhook and published policies, and only then approve the live launch. The repository contains no payment credentials; live purchases remain unavailable until all external services and release gates are explicitly configured.
