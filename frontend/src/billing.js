import {
  cancelBillingSubscription,
  loadBillingActivity,
  loadBillingConfig,
  loadBillingEntitlement,
  loadBillingPayments,
  redeemBillingVoucher,
  requestBillingRefundReview,
  scheduleBillingPlanChange
} from './billing-client.js';
import { cloudConfigured, observeAuth } from './firebase-cloud.js';
import { PLAN_CONFIG } from './plan-access.js';
import { formatCurrencyPrice } from './pricing-currency.js';
import { alertModern, confirmModern } from './modern-modal.js';

const $ = selector => document.querySelector(selector);
const accountStatus = $('#billingAccountStatus');
const planTitle = $('#billingPlanTitle');
const planDetail = $('#billingPlanDetail');
const historyList = $('#billingHistory');
const paymentsList = $('#billingPayments');
const billingStatus = $('#billingServiceStatus');
const voucherInput = $('#voucherCode');
const redeemButton = $('#redeemVoucher');
const cancelButton = $('#cancelBilling');
const cancelDialog = $('#cancelSubscriptionDialog');
const cancelDialogForm = $('#cancelSubscriptionForm');
const cancelReasonInput = $('#cancelReason');
const yearlyButton = $('#switchBillingYearly');
let currentUser = null;
let entitlement = null;
let billingConfig = null;
let billingConfigError = null;
let entitlementResolved = false;
let refreshId = 0;
let cancellationPending = false;

const formatDate = value => {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp))
    : 'Date unavailable';
};

function renderHistory(activity) {
  historyList.replaceChildren();
  if (!activity.length) {
    const empty = document.createElement('p');
    empty.className = 'billing-history-empty';
    empty.textContent = 'No billing activity yet.';
    historyList.append(empty);
    return;
  }

  for (const item of activity) {
    const row = document.createElement('article');
    row.className = 'billing-history-item';
    const icon = document.createElement('span');
    icon.className = 'billing-history-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = item.status === 'success' || item.status === 'active' ? '✓' : '•';
    const details = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = item.title || 'Billing activity';
    const description = document.createElement('p');
    description.textContent = item.detail || 'Billing activity updated.';
    details.append(title, description);
    const time = document.createElement('time');
    time.textContent = formatDate(item.occurredAt);
    row.append(icon, details, time);
    historyList.append(row);
  }
}

function renderPayments(payments) {
  paymentsList.replaceChildren();
  if (!payments.length) {
    const empty = document.createElement('p');
    empty.className = 'billing-history-empty';
    empty.textContent = 'No eligible Razorpay payments were found for this account.';
    paymentsList.append(empty);
    return;
  }

  for (const payment of payments) {
    const card = document.createElement('article');
    card.className = 'billing-payment-item';
    const details = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `${payment.planKey === 'yearly' ? 'Yearly' : 'Monthly'} Pro · ${formatCurrencyPrice(Number(payment.amount) / 100, payment.currency || 'INR')}`;
    const meta = document.createElement('p');
    meta.textContent = `${payment.paymentId} · ${formatDate(payment.createdAt)}`;
    details.append(title, meta);

    const request = payment.refundRequest;
    if (request) {
      const state = document.createElement('p');
      state.className = 'billing-payment-request-state';
      state.textContent = request.status === 'requested'
        ? 'Refund review requested. Our team will review it; this does not issue a refund automatically.'
        : `Refund request status: ${request.status}.`;
      card.append(details, state);
    } else {
      const reason = document.createElement('textarea');
      reason.maxLength = 500;
      reason.rows = 2;
      reason.placeholder = 'Reason for requesting a refund (optional)';
      reason.setAttribute('aria-label', `Optional refund request reason for payment ${payment.paymentId}`);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn outline';
      button.textContent = 'Request refund review';
      const state = document.createElement('p');
      state.className = 'billing-payment-request-state';
      button.addEventListener('click', async () => {
        if (!currentUser || button.disabled) return;
        button.disabled = true;
        state.textContent = 'Submitting refund review request…';
        try {
          await requestBillingRefundReview(currentUser, payment.paymentId, reason.value.trim());
          await refreshBillingPage(currentUser);
          billingStatus.textContent = 'Refund review requested. No refund has been issued; your request will be reviewed.';
        } catch (error) {
          state.textContent = error.message || 'Could not submit the refund request.';
          button.disabled = false;
        }
      });
      card.append(details, reason, button, state);
    }
    paymentsList.append(card);
  }
}

function updateVoucherControls() {
  const signInRequired = !currentUser;
  const proActive = entitlement?.status === 'active';
  const planCheckPending = Boolean(currentUser) && !entitlementResolved;
  const voucherUnavailable = billingConfig?.entitlementEnabled === false;
  const disabled = signInRequired || planCheckPending || proActive || voucherUnavailable;
  voucherInput.disabled = disabled;
  redeemButton.disabled = disabled;
  $('#voucherSection').classList.toggle('voucher-disabled', disabled);
  $('#voucherSection').classList.toggle('voucher-pro-active', proActive);

  if (signInRequired) {
    voucherInput.value = '';
    voucherInput.placeholder = 'Sign in to redeem a voucher';
    voucherStatus.dataset.state = 'error';
    voucherStatus.textContent = 'Sign in with Google before redeeming a voucher.';
  } else if (planCheckPending) {
    voucherInput.placeholder = 'Checking plan status…';
    voucherStatus.dataset.state = '';
    voucherStatus.textContent = 'Checking whether this account can redeem a voucher…';
  } else if (!billingConfig) {
    voucherInput.placeholder = 'Enter voucher code';
    voucherStatus.dataset.state = billingConfigError ? 'error' : '';
    voucherStatus.textContent = billingConfigError
      ? 'Voucher availability could not be checked. Enter a code and the server will verify it.'
      : 'Checking voucher availability…';
  } else if (voucherUnavailable) {
    voucherStatus.dataset.state = 'error';
    voucherStatus.textContent = 'Voucher redemption is unavailable because server-side account verification is not configured.';
  } else {
    voucherInput.placeholder = proActive ? 'Voucher unavailable while Pro is active' : 'Enter voucher code';
    voucherStatus.dataset.state = proActive ? 'success' : '';
    voucherStatus.textContent = proActive
      ? `Voucher redemption is disabled while Pro is active${entitlement.lifetime ? '.' : ` through ${entitlement.validUntil ? new Date(entitlement.validUntil).toLocaleDateString('en-IN') : 'the current plan period'}.`}`
      : 'Enter a voucher code to check it for this account.';
  }
}

function updatePlanSummary(user) {
  const active = entitlement?.status === 'active';
  cancelButton.hidden = !user || !active || !entitlement?.subscriptionId || Boolean(entitlement.cancelAtCycleEnd);
  yearlyButton.hidden = !user || !active || entitlement.billingPlan !== 'monthly' || Boolean(entitlement.cancelAtCycleEnd);
  yearlyButton.disabled = !billingConfig?.checkoutEnabled;

  if (!user) {
    planTitle.textContent = 'No active plan';
    planDetail.textContent = 'Sign in to review purchases and manage billing.';
  } else if (!active) {
    planTitle.textContent = 'Free plan';
    planDetail.textContent = 'No active Pro plan is linked to this account.';
  } else {
    const plan = entitlement.billingPlan === 'voucher' ? 'Pro voucher' : `Pro ${entitlement.billingPlan || ''}`.trim();
    const validUntil = entitlement.lifetime
      ? 'Lifetime'
      : entitlement.validUntil ? new Date(entitlement.validUntil).toLocaleDateString('en-IN') : 'the current billing period';
    const renews = entitlement.cancelAtCycleEnd ? ' This plan will not renew.' : '';
    const scheduled = entitlement.scheduledPlan === 'yearly' ? ` Yearly billing is scheduled after ${validUntil}.` : '';
    planTitle.textContent = `${plan} active`;
    planDetail.textContent = entitlement.lifetime
      ? `Lifetime Pro access does not expire.${renews}`
      : `Access continues through ${validUntil}.${renews}${scheduled}`;
  }
}

async function refreshBillingPage(user, authError = null) {
  const requestId = ++refreshId;
  currentUser = user;
  entitlement = null;
  entitlementResolved = !user;
  updatePlanSummary(user);
  updateVoucherControls();

  if (authError) billingStatus.textContent = authError.message || 'Sign-in could not be initialized.';
  else billingStatus.textContent = billingConfigError?.message || '';

  if (!user) {
    accountStatus.textContent = 'Sign in with Google to view and manage billing for your account.';
    historyList.textContent = 'Sign in to view billing activity.';
    paymentsList.textContent = 'Sign in to view payment history and request a refund review.';
    updatePlanSummary(null);
    updateVoucherControls();
    return;
  }

  accountStatus.textContent = `Signed in as ${user.email || user.displayName || 'Google user'}. Billing details are private to this account.`;
  historyList.textContent = 'Loading billing activity…';
  try {
    if (!billingConfig && !billingConfigError) billingConfig = await loadBillingConfig();
  } catch (error) {
    billingConfigError = error;
    billingStatus.textContent = error.message || 'Billing configuration is unavailable.';
  }

  if (currentUser?.uid !== user.uid || requestId !== refreshId) return;
  const [entitlementResult, activityResult, paymentsResult] = await Promise.allSettled([
    billingConfig?.entitlementEnabled
      ? loadBillingEntitlement(user, { forceRefresh: true })
      : Promise.resolve(null),
    loadBillingActivity(user),
    loadBillingPayments(user)
  ]);
  if (currentUser?.uid !== user.uid || requestId !== refreshId) return;

  if (entitlementResult.status === 'fulfilled') {
    entitlement = entitlementResult.value;
    entitlementResolved = true;
  } else {
    entitlementResolved = false;
    billingStatus.textContent = entitlementResult.reason?.message || 'Could not load plan status.';
  }
  if (activityResult.status === 'fulfilled') renderHistory(activityResult.value || []);
  else {
    historyList.replaceChildren();
    const error = document.createElement('p');
    error.className = 'billing-history-empty';
    error.textContent = activityResult.reason?.message || 'Billing activity is temporarily unavailable.';
    historyList.append(error);
  }
  if (paymentsResult.status === 'fulfilled') renderPayments(paymentsResult.value || []);
  else {
    paymentsList.replaceChildren();
    const error = document.createElement('p');
    error.className = 'billing-history-empty';
    error.textContent = paymentsResult.reason?.message || 'Payment history is temporarily unavailable.';
    paymentsList.append(error);
  }

  updatePlanSummary(user);
  updateVoucherControls();
}

async function finalizeCancellation() {
  if (cancellationPending || !currentUser || !entitlement?.subscriptionId) return;
  cancellationPending = true;
  cancelButton.disabled = true;
  const confirmButton = cancelDialogForm?.querySelector('[type="submit"]');
  if (confirmButton) {
    confirmButton.disabled = true;
    confirmButton.textContent = 'Scheduling cancellation…';
  }
  try {
    const reason = cancelReasonInput.value.trim();
    await cancelBillingSubscription(currentUser, entitlement.subscriptionId, reason);
    cancelDialog?.close?.();
    await refreshBillingPage(currentUser);
    billingStatus.textContent = 'Cancellation scheduled. Pro remains active through the current paid period.';
  } catch (error) {
    billingStatus.textContent = error.message || 'Could not cancel this subscription.';
  } finally {
    cancellationPending = false;
    cancelButton.disabled = false;
    if (confirmButton) {
      confirmButton.disabled = false;
      confirmButton.textContent = 'Confirm cancellation';
    }
  }
}

cancelButton.addEventListener('click', async () => {
  if (cancellationPending || !currentUser || !entitlement?.subscriptionId) return;
  if (cancelDialog && typeof cancelDialog.showModal === 'function') {
    cancelReasonInput.value = '';
    cancelDialog.showModal();
    return;
  }
  if (!await confirmModern({
    title: 'Cancel future renewals?',
    message: 'Pro remains active until the current paid period ends.',
    confirmText: 'Cancel renewals',
    variant: 'danger'
  })) return;
  void finalizeCancellation();
});

cancelDialogForm?.addEventListener('submit', event => {
  event.preventDefault();
  void finalizeCancellation();
});

document.querySelectorAll('[data-close-cancel-dialog]').forEach(button => {
  button.addEventListener('click', () => {
    cancelDialog?.close?.();
    cancelReasonInput.value = '';
  });
});

yearlyButton.addEventListener('click', async () => {
  if (!currentUser || entitlement?.billingPlan !== 'monthly' || !billingConfig?.checkoutEnabled) return;
  const date = entitlement.validUntil ? new Date(entitlement.validUntil).toLocaleDateString('en-IN') : 'the end of this billing period';
  const currency = entitlement.currency === 'USD' ? 'USD' : 'INR';
  const configuredAmount = Number(billingConfig.currencyPlans?.[currency]?.yearly?.amount);
  const price = Number.isSafeInteger(configuredAmount) && configuredAmount > 0
    ? configuredAmount / 100
    : PLAN_CONFIG.pro.currencies[currency].yearly.price;
  if (!await confirmModern({
    title: 'Schedule yearly billing?',
    message: `Pro Yearly will begin after ${date}. Your monthly access continues until then; ${formatCurrencyPrice(price, currency)}/year will be charged when the switch takes effect.`,
    confirmText: 'Schedule yearly'
  })) return;
  yearlyButton.disabled = true;
  try {
    const result = await scheduleBillingPlanChange(currentUser, 'yearly');
    billingStatus.textContent = `Yearly plan scheduled for ${new Date(result.scheduledAt).toLocaleDateString('en-IN')}.`;
    await refreshBillingPage(currentUser);
  } catch (error) {
    billingStatus.textContent = error.message || 'Could not schedule the yearly plan.';
    if (error.code === 'YEARLY_SWITCH_REQUIRES_CANCELLATION') {
      const cancelMonthly = await confirmModern({
        title: 'Stop monthly renewal instead?',
        message: `Razorpay does not support switching this domestic-card subscription directly to yearly. Your monthly plan is unchanged. If you continue, monthly renewal will stop at the end of this period (${date}); Pro remains active through then, and you will need to start yearly from the Plans page after it expires. No yearly subscription or charge will be created now.`,
        confirmText: 'Stop monthly renewal',
        variant: 'danger'
      });
      if (cancelMonthly) {
        try {
          await cancelBillingSubscription(currentUser, entitlement.subscriptionId);
          await refreshBillingPage(currentUser);
          billingStatus.textContent = `Monthly renewal is stopped. Pro remains active through ${date}; start yearly from the Plans page after access expires.`;
          await alertModern({
            title: 'Monthly renewal stopped',
            message: `Your current Pro access continues through ${date}. Start the yearly plan from the Plans page after it expires.`,
            confirmText: 'OK'
          });
        } catch (cancelError) {
          billingStatus.textContent = cancelError.message || 'Could not stop monthly renewal.';
          await alertModern({
            title: 'Could not stop monthly renewal',
            message: cancelError.message || 'Your monthly plan remains unchanged. Please retry or contact support.',
            confirmText: 'OK',
            variant: 'error'
          });
        }
      }
    } else {
      await alertModern({
        title: 'Could not switch to yearly',
        message: error.message || 'Could not schedule the yearly plan. Your current monthly subscription remains unchanged.',
        confirmText: 'OK',
        variant: 'error'
      });
    }
    yearlyButton.disabled = false;
  }
});

$('#voucherForm').addEventListener('submit', async event => {
  event.preventDefault();
  const code = voucherInput.value.trim();
  if (!currentUser) {
    voucherStatus.dataset.state = 'error';
    voucherStatus.textContent = 'Sign in with Google before redeeming a voucher.';
    return;
  }
  if (entitlement?.status === 'active') {
    voucherStatus.dataset.state = 'error';
    voucherStatus.textContent = 'Voucher redemption is disabled while Pro is active.';
    return;
  }
  if (!entitlementResolved) {
    voucherStatus.dataset.state = '';
    voucherStatus.textContent = 'Wait until your plan status has been checked before redeeming a voucher.';
    return;
  }
  if (billingConfig?.entitlementEnabled === false) {
    voucherStatus.dataset.state = 'error';
    voucherStatus.textContent = 'Voucher redemption is unavailable because server-side account verification is not configured.';
    return;
  }
  if (!code) return;

  redeemButton.disabled = true;
  voucherStatus.dataset.state = '';
  voucherStatus.textContent = 'Checking voucher…';
  try {
    const result = await redeemBillingVoucher(currentUser, code);
    entitlement = result.entitlement;
    voucherInput.value = '';
    voucherStatus.dataset.state = 'success';
    await refreshBillingPage(currentUser);
    voucherStatus.dataset.state = 'success';
    voucherStatus.textContent = entitlement.lifetime
      ? 'Voucher redeemed. Lifetime Pro access is active.'
      : `Voucher redeemed. Pro is active through ${new Date(entitlement.validUntil).toLocaleDateString('en-IN')}.`;
  } catch (error) {
    voucherStatus.dataset.state = 'error';
    voucherStatus.textContent = error.message || 'Could not redeem this voucher.';
    updateVoucherControls();
  }
});

if (cloudConfigured) observeAuth((user, error) => refreshBillingPage(user, error));
else void refreshBillingPage(null, new Error('Google sign-in is not configured on this site.'));