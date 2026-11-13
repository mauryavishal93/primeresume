import {
  createBillingSubscription,
  loadBillingConfig,
  loadBillingEntitlement,
  redeemBillingVoucher,
  scheduleBillingPlanChange,
  verifyBillingCheckout
} from './billing-client.js';
import { cloudConfigured, googleSignInErrorMessage, isGoogleSignInCancellation, observeAuth, signInWithGoogle } from './firebase-cloud.js';
import { alertModern, confirmModern } from './modern-modal.js';
import { PLAN_CONFIG, PRICING_FEATURES } from './plan-access.js';
import { formatCurrencyPrice, preferredPricingCurrency } from './pricing-currency.js';

const $ = selector => document.querySelector(selector);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function razorpayFailureMessage(failure) {
  const reason = typeof failure.reason === 'string' ? failure.reason.toLowerCase() : '';
  const code = typeof failure.code === 'string' ? failure.code.toUpperCase() : '';
  const step = typeof failure.step === 'string' ? failure.step.toLowerCase() : '';
  const explanations = {
    authentication_failed: 'Bank authentication could not be completed. Retry and approve the payment in your bank app or OTP screen.',
    card_declined: 'Your bank declined the card. Try another card or contact your bank.',
    insufficient_funds: 'The payment method has insufficient funds. Try another payment method.',
    international_transaction_not_allowed: 'Your payment method does not allow this transaction. Contact your bank or try another method.',
    transaction_limit_exceeded: 'The payment exceeds your bank or payment-method limit. Try another method or contact your bank.',
    card_expired: 'The card has expired. Use a valid card or another payment method.',
    payment_failed: 'The payment provider could not complete this transaction. Retry or use another payment method.'
  };
  const explanation = explanations[reason]
    || (step.includes('authentication')
      ? explanations.authentication_failed
      : code === 'GATEWAY_ERROR'
        ? 'The payment gateway did not complete the request. Please retry in a moment.'
        : code === 'SERVER_ERROR'
          ? 'Razorpay is temporarily unavailable. Please retry in a moment.'
          : 'Razorpay could not complete the payment. Please retry or use another payment method.');
  const details = [failure.code, failure.description, failure.reason, failure.step]
    .filter(value => typeof value === 'string' && value.trim())
    .join(' — ');
  return {
    title: 'Payment failed',
    message: details ? `${explanation}\n\nRazorpay details: ${details}` : explanation
  };
}

const checkoutStatus = $('#checkoutStatus');
const monthlyButton = $('#purchaseMonthly');
const yearlyButton = $('#purchaseYearly');
const supportDialog = $('#supportDialog');
const pricingAnnouncement = $('#pricingAnnouncement');
const voucherSection = $('#pricingVoucherSection');
const voucherInput = $('#pricingVoucherCode');
const voucherButton = $('#redeemPricingVoucher');
const voucherStatus = $('#pricingVoucherStatus');
let currentUser = null;
let billingConfig = null;
let entitlement = null;
let entitlementResolved = false;
const selectedCurrency = preferredPricingCurrency();

$('#supportLink')?.addEventListener('click', event => {
  event.preventDefault();
  if (typeof supportDialog?.showModal === 'function') supportDialog.showModal();
  else window.location.href = 'mailto:resumeout@gmail.com';
});
$('#closeSupportDialog')?.addEventListener('click', () => supportDialog?.close());
supportDialog?.addEventListener('click', event => {
  if (event.target === supportDialog) supportDialog.close();
});

const formatPrice = (amount, currency = selectedCurrency) => formatCurrencyPrice(amount, currency);

function pricingForCurrency(currency) {
  return window.__pricingConfig || {};
}

function getConfiguredPrice(planKey, fallback, currency = selectedCurrency) {
  const value = Number(pricingForCurrency(currency)?.[planKey]?.currentPrice ?? fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function getConfiguredActualPrice(planKey, fallback, currency = selectedCurrency) {
  const value = Number(pricingForCurrency(currency)?.[planKey]?.actualPrice ?? fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function renderStoredPricing(currency = selectedCurrency) {
  const planConfig = PLAN_CONFIG.pro.currencies[currency];
  const monthlyActual = getConfiguredActualPrice('monthly', planConfig.monthly.price, currency);
  const monthlyCurrent = getConfiguredPrice('monthly', planConfig.monthly.price, currency);
  const yearlyActual = getConfiguredActualPrice('yearly', planConfig.yearly.price, currency);
  const yearlyCurrent = getConfiguredPrice('yearly', planConfig.yearly.price, currency);

  const announcement = typeof window.__pricingConfig?.announcement === 'string'
    ? window.__pricingConfig.announcement
    : '';
  if (pricingAnnouncement) {
    const label = pricingAnnouncement.querySelector('.pricing-announcement-label');
    const copy = pricingAnnouncement.querySelector('.pricing-announcement-copy');
    const discountBadge = pricingAnnouncement.querySelector('.pricing-announcement-discount');
    const trimmedAnnouncement = announcement.trim();
    const limitedTimeOffer = /^\s*limited\s+time\s+offer\b/i.test(trimmedAnnouncement);
    const discountMatch = trimmedAnnouncement.match(/\bsave\s+(\d{1,3})\s*%(?:[.!?]+)?/i);
    const message = trimmedAnnouncement
      .replace(/^\s*limited\s+time\s+offer[.!:\s-]*/i, '')
      .replace(/\s*(?:&|and)?\s*save\s+\d{1,3}\s*%(?:[.!?]+)?/i, '')
      .replace(/\s+([.!?])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim();

    label.textContent = limitedTimeOffer ? 'LIMITED-TIME OFFER' : 'SPECIAL PRICING';
    copy.textContent = message;
    discountBadge.textContent = discountMatch ? `SAVE ${discountMatch[1]}%` : '';
    discountBadge.hidden = !discountMatch;
    copy.hidden = !message;
    pricingAnnouncement.hidden = !trimmedAnnouncement;
  }

  const renderPlanPrice = (node, currentPrice, actualPrice, suffixLabel) => {
    const discount = actualPrice > currentPrice ? Math.round(((actualPrice - currentPrice) / actualPrice) * 100) : 0;
    const actualMarkup = actualPrice > currentPrice
      ? `<span class="price-original">${formatPrice(actualPrice, currency)}</span>`
      : '';
    const discountMarkup = discount > 0
      ? `<span class="price-discount">Save ${discount}%</span>`
      : '';
    node.innerHTML = `${actualMarkup}${formatPrice(currentPrice, currency)} <span>${suffixLabel}${discountMarkup}</span>`;
    node.setAttribute('aria-busy', 'false');
  };

  renderPlanPrice($('#monthlyPrice'), monthlyCurrent, monthlyActual, 'per month, recurring');
  renderPlanPrice($('#yearlyPrice'), yearlyCurrent, yearlyActual, 'per year, recurring');
  $('#freePrice').innerHTML = `${formatPrice(PLAN_CONFIG.free.price, currency)} <span>always free</span>`;
  $('#freePrice').setAttribute('aria-busy', 'false');
}

function updateVoucherControls() {
  const signInRequired = !currentUser;
  const verificationUnavailable = billingConfig?.entitlementEnabled === false;
  const proActive = entitlement?.status === 'active';
  const planCheckPending = Boolean(currentUser) && !entitlementResolved;
  voucherInput.disabled = signInRequired || verificationUnavailable || planCheckPending || proActive;
  voucherButton.disabled = signInRequired || verificationUnavailable || planCheckPending || proActive;
  voucherSection.classList.toggle('voucher-disabled', voucherInput.disabled);
  voucherSection.classList.toggle('voucher-pro-active', proActive);

  if (signInRequired) {
    voucherInput.placeholder = 'Sign in to redeem a voucher';
    voucherStatus.dataset.state = 'error';
    voucherStatus.textContent = 'Sign in with Google before redeeming a voucher.';
  } else if (verificationUnavailable) {
    voucherInput.placeholder = 'Voucher redemption unavailable';
    voucherStatus.dataset.state = 'error';
    voucherStatus.textContent = 'Voucher redemption is unavailable because server-side account verification is not configured.';
  } else if (planCheckPending) {
    voucherInput.placeholder = 'Checking plan status…';
    voucherStatus.dataset.state = '';
    voucherStatus.textContent = 'Checking whether this account can redeem a voucher…';
  } else if (proActive) {
    voucherInput.placeholder = 'Voucher unavailable while Pro is active';
    voucherStatus.dataset.state = 'success';
    voucherStatus.textContent = entitlement.lifetime
      ? 'Voucher redemption is disabled while Lifetime Pro is active.'
      : `Voucher redemption is disabled while Pro is active${entitlement.validUntil ? ` through ${new Date(entitlement.validUntil).toLocaleDateString('en-IN')}` : ' during the current plan period'}.`;
  } else {
    voucherInput.placeholder = 'Enter voucher code';
    voucherStatus.dataset.state = '';
    voucherStatus.textContent = billingConfig
      ? 'Enter a voucher code to check it for this account.'
      : 'Voucher availability could not be checked. Enter a code and the server will verify it.';
  }
}

async function loadPublicPricingConfig() {
  try {
    const response = await fetch('/api/pricing/config', { cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to load pricing configuration.');
    const body = await response.json();
    window.__pricingConfig = body.pricing || {};
    renderStoredPricing(selectedCurrency);
  } catch (error) {
    console.error('Pricing config could not be loaded.', error);
    window.__pricingConfig = {
      monthly: { currentPrice: PLAN_CONFIG.pro.monthly.price, actualPrice: PLAN_CONFIG.pro.monthly.price },
      yearly: { currentPrice: PLAN_CONFIG.pro.yearly.price, actualPrice: PLAN_CONFIG.pro.yearly.price }
    };
    renderStoredPricing(selectedCurrency);
  }
}

renderStoredPricing(selectedCurrency);
void loadPublicPricingConfig();

const tableBody = $('#pricingFeatures');
for (const feature of PRICING_FEATURES) {
  const row = document.createElement('tr');
  for (const value of [feature.label, feature.free, feature.pro]) {
    const cell = document.createElement(row.children.length ? 'td' : 'th');
    if (cell.tagName === 'TH') cell.scope = 'row';
    if (value === 'Included' || value.startsWith('Not available')) {
      const available = value === 'Included';
      const indicator = document.createElement('span');
      indicator.className = `feature-status ${available ? 'feature-status-included' : 'feature-status-unavailable'}`;
      indicator.setAttribute('role', 'img');
      indicator.setAttribute('aria-label', available ? 'Included' : 'Not available');
      indicator.innerHTML = available
        ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10.5 4 4 8-9"/></svg>'
        : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg>';
      cell.append(indicator);
    } else {
      cell.textContent = value;
    }
    row.append(cell);
  }
  tableBody.append(row);
}

function updatePurchaseControls() {
  const checkoutReady = Boolean(
    billingConfig?.checkoutEnabled
    && billingConfig.supportedCurrencies?.includes(selectedCurrency)
  );
  const active = entitlement?.status === 'active';
  const activePlan = active ? entitlement.billingPlan : null;

  monthlyButton.disabled = true;
  yearlyButton.disabled = true;

  if (active) {
    monthlyButton.textContent = 'Manage billing';
    const canSwitchToYearly = activePlan === 'monthly'
      && (!entitlement.currency || entitlement.currency === 'INR')
      && entitlement.scheduledPlan !== 'yearly'
      && checkoutReady;
    yearlyButton.textContent = entitlement.scheduledPlan === 'yearly'
      ? 'Yearly scheduled'
      : canSwitchToYearly
        ? 'Switch to yearly'
        : 'Manage billing';
    monthlyButton.disabled = false;
    yearlyButton.disabled = entitlement.scheduledPlan === 'yearly';
    const validUntil = Number(entitlement.validUntil);
    const validity = entitlement.lifetime
      ? ''
      : Number.isFinite(validUntil) && validUntil > 0
      ? ` through ${new Date(validUntil).toLocaleDateString('en-IN')}`
      : '';
    const planLabel = activePlan === 'monthly'
      ? 'Pro Monthly'
      : activePlan === 'yearly'
        ? 'Pro Yearly'
        : activePlan === 'voucher'
          ? entitlement.lifetime ? 'Pro Lifetime Voucher' : 'Pro Voucher'
          : 'Pro';
    const activationSource = entitlement.source === 'admin'
      ? ' (Admin granted)'
      : ['monthly', 'yearly'].includes(activePlan)
        ? ' (Subscription)'
        : '';
    const scheduledChange = entitlement.scheduledPlan === 'yearly'
      ? ` Yearly billing is scheduled${entitlement.scheduledAt ? ` for ${new Date(entitlement.scheduledAt).toLocaleDateString('en-IN')}` : ''}.`
      : '';
    checkoutStatus.textContent = `Your active plan: ${planLabel}${activationSource}${validity}.${scheduledChange}`;
  } else if (!checkoutReady) {
    monthlyButton.textContent = 'Coming soon';
    yearlyButton.textContent = 'Coming soon';
    checkoutStatus.textContent = billingConfig?.checkoutEnabled
      ? 'INR subscriptions are temporarily unavailable.'
      : '';
  } else if (!currentUser) {
    monthlyButton.textContent = 'Sign in to purchase monthly';
    yearlyButton.textContent = 'Sign in to purchase yearly';
    monthlyButton.disabled = false;
    yearlyButton.disabled = false;
  } else {
    monthlyButton.textContent = 'Start monthly subscription';
    yearlyButton.textContent = 'Start yearly subscription';
    monthlyButton.disabled = false;
    yearlyButton.disabled = false;
    checkoutStatus.textContent = 'No plan active';
  }

  const monthlyBadge = $('#monthlyPlanBadge');
  const yearlyBadge = $('#yearlyPlanBadge');
  const yearlyScheduled = active && entitlement.scheduledPlan === 'yearly';
  monthlyBadge.textContent = 'Active plan';
  monthlyBadge.hidden = activePlan !== 'monthly';
  yearlyBadge.textContent = activePlan === 'yearly' ? 'Active plan' : 'Scheduled';
  yearlyBadge.classList.toggle('scheduled', yearlyScheduled);
  yearlyBadge.hidden = activePlan !== 'yearly' && !yearlyScheduled;

}

async function refreshPricingState(user) {
  currentUser = user;
  entitlement = null;
  entitlementResolved = !user;
  updatePurchaseControls();
  updateVoucherControls();
  if (!user) {
    checkoutStatus.textContent = 'Sign in with Google before starting a purchase.';
    updateVoucherControls();
    return;
  }
  try {
    if (!billingConfig) {
      billingConfig = await loadBillingConfig();
    }
    if (billingConfig.entitlementEnabled) {
      entitlement = await loadBillingEntitlement(user, { forceRefresh: true });
    }
    if (currentUser?.uid !== user.uid) return;
    entitlementResolved = true;
    updatePurchaseControls();
    updateVoucherControls();
  } catch (error) {
    console.error('Could not load billing status.', error);
    entitlementResolved = false;
    checkoutStatus.textContent = error.message === 'Could not load your plan status.'
      ? 'No plan active'
      : error.message;
    updatePurchaseControls();
    updateVoucherControls();
  }
}

async function scheduleYearlySwitch() {
  if (!currentUser || entitlement?.status !== 'active' || entitlement.billingPlan !== 'monthly'
    || entitlement.scheduledPlan === 'yearly' || !billingConfig?.checkoutEnabled) {
    return;
  }
  const date = entitlement.validUntil
    ? new Date(entitlement.validUntil).toLocaleDateString('en-IN')
    : 'the end of your current monthly period';
  if (entitlement.currency && entitlement.currency !== 'INR') {
    checkoutStatus.textContent = 'Only INR subscriptions can be switched to yearly billing.';
    return;
  }
  const currency = 'INR';
  const amount = Number(billingConfig.currencyPlans?.INR?.yearly?.amount);
  const price = Number.isSafeInteger(amount) && amount > 0
    ? amount / 100
    : PLAN_CONFIG.pro.currencies[currency].yearly.price;
  if (!await confirmModern({
    title: 'Switch to yearly?',
    message: `Your monthly access continues through ${date}. Yearly billing will start then at ${formatCurrencyPrice(price, currency)}/year.`,
    confirmText: 'Switch to yearly'
  })) return;

  yearlyButton.disabled = true;
  checkoutStatus.textContent = 'Scheduling your yearly plan…';
  try {
    const result = await scheduleBillingPlanChange(currentUser, 'yearly');
    await refreshPricingState(currentUser);
    const scheduledDate = new Date(result.scheduledAt).toLocaleDateString('en-IN');
    checkoutStatus.textContent = `Your active plan remains monthly. Yearly billing is scheduled for ${scheduledDate}.`;
    await alertModern({
      title: 'Yearly plan scheduled',
      message: `Your monthly access continues until ${scheduledDate}. Yearly billing will begin after that.`,
      confirmText: 'OK'
    });
  } catch (error) {
    console.error('Could not schedule the yearly plan switch.', error);
    checkoutStatus.textContent = error.message || 'Could not schedule the yearly plan.';
    yearlyButton.disabled = false;
    await alertModern({
      title: 'Could not switch to yearly',
      message: error.message || 'The yearly plan could not be scheduled. Your current monthly subscription remains unchanged.',
      confirmText: 'OK',
      variant: 'error'
    });
  }
}

async function loadRazorpayCheckout() {
  if (window.Razorpay) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Razorpay Checkout could not be loaded. Check your connection and retry.'));
    document.head.append(script);
  });
}

async function startCheckout(planKey) {
  if (!billingConfig?.checkoutEnabled || !billingConfig.supportedCurrencies?.includes(selectedCurrency)) {
    checkoutStatus.textContent = '';
    return;
  }
  if (!currentUser) {
    monthlyButton.disabled = true;
    yearlyButton.disabled = true;
    checkoutStatus.textContent = 'Opening Google sign-in…';
    try {
      const credential = await signInWithGoogle();
      if (credential?.user) {
        currentUser = credential.user;
      } else {
        updatePurchaseControls();
        if (credential === null) checkoutStatus.textContent = '';
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
    } catch (error) {
      if (!isGoogleSignInCancellation(error)) {
        console.error('Google sign-in failed from the Plans page.', error);
        checkoutStatus.textContent = googleSignInErrorMessage(error);
      } else {
        checkoutStatus.textContent = '';
      }
      updatePurchaseControls();
      return;
    }
  }

  monthlyButton.disabled = true;
  yearlyButton.disabled = true;
  checkoutStatus.textContent = 'Preparing secure Razorpay checkout…';
  try {
    const checkoutUser = currentUser;
    await loadRazorpayCheckout();
    const planConfig = PLAN_CONFIG.pro.currencies[selectedCurrency];
    const expectedAmount = Math.round(getConfiguredPrice(planKey, planConfig[planKey].price, selectedCurrency) * 100);
    const created = await createBillingSubscription(checkoutUser, planKey, selectedCurrency, expectedAmount);
    let paymentOutcomeReceived = false;
    const checkout = new window.Razorpay({
      key: created.keyId,
      subscription_id: created.subscriptionId,
      name: 'ResumeOut.com',
      description: `${created.plan.label} subscription`,
      prefill: {
        name: checkoutUser.displayName || '',
        email: checkoutUser.email || ''
      },
      theme: { color: '#5146e5' },
      handler: async checkoutResponse => {
        paymentOutcomeReceived = true;
        checkoutStatus.textContent = 'Verifying your payment with Razorpay…';
        try {
          const result = await verifyBillingCheckout(checkoutUser, checkoutResponse);
          let confirmedEntitlement = result.entitlement?.status === 'active'
            ? result.entitlement
            : null;
          if (result.entitlement?.status === 'active') {
            entitlement = result.entitlement;
            entitlementResolved = true;
            updatePurchaseControls();
            updateVoucherControls();
          } else {
            checkoutStatus.textContent = result.message || 'Payment verified. Waiting for Razorpay to activate the subscription.';
            for (let attempt = 0; attempt < 5; attempt += 1) {
              await delay(2000);
              const updatedEntitlement = await loadBillingEntitlement(checkoutUser);
              if (updatedEntitlement?.status === 'active') {
                confirmedEntitlement = updatedEntitlement;
                entitlement = updatedEntitlement;
                entitlementResolved = true;
                break;
              }
            }
          }
          await refreshPricingState(checkoutUser);
          if (entitlement?.status !== 'active' && confirmedEntitlement) {
            entitlement = confirmedEntitlement;
            updatePurchaseControls();
            updateVoucherControls();
          }
          if (entitlement?.status === 'active') {
            const validUntil = Number(entitlement.validUntil);
            const validity = Number.isFinite(validUntil) && validUntil > 0
              ? ` through ${new Date(validUntil).toLocaleDateString('en-IN')}`
              : '';
            const message = `Payment successful. Pro access is active${validity}.`;
            checkoutStatus.textContent = message;
            await alertModern({
              title: 'Payment successful',
              message,
              confirmText: 'Continue'
            });
          } else {
            const message = result.message
              || 'Razorpay verified your payment. Pro access will appear as soon as the subscription is activated.';
            checkoutStatus.textContent = message;
            await alertModern({
              title: result.pending ? 'Payment successful — activation pending' : 'Payment verification pending',
              message,
              confirmText: 'OK'
            });
          }
        } catch (error) {
          console.error('Payment verification request failed.', error);
          let recoveredEntitlement = null;
          for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
              recoveredEntitlement = await loadBillingEntitlement(checkoutUser, { forceRefresh: true });
              if (recoveredEntitlement?.status === 'active') break;
            } catch (reconciliationError) {
              console.warn('Could not refresh Pro access after checkout verification failed.', reconciliationError);
            }
            if (attempt < 4) await delay(2000);
          }
          if (recoveredEntitlement?.status === 'active') {
            entitlement = recoveredEntitlement;
            entitlementResolved = true;
            updatePurchaseControls();
            updateVoucherControls();
            const message = 'Your account has active Pro access. If this checkout was for a renewal, Razorpay will reconcile its payment record.';
            checkoutStatus.textContent = message;
            await alertModern({
              title: 'Pro access is active',
              message,
              confirmText: 'Continue'
            });
            return;
          }
          const message = 'We could not confirm this checkout yet. Do not make another payment. If Razorpay completed the payment, it will be reconciled shortly; check your plan status again or contact support if Pro access does not appear.';
          checkoutStatus.textContent = message;
          await alertModern({
            title: 'Payment verification issue',
            message,
            confirmText: 'OK',
            variant: 'error'
          });
        }
      },
      modal: {
        ondismiss: () => {
          if (paymentOutcomeReceived) return;
          checkoutStatus.textContent = 'Checkout closed. No purchase was confirmed by this page.';
          updatePurchaseControls();
          void alertModern({
            title: 'Payment cancelled',
            message: 'You closed Razorpay checkout before completing the payment. No payment was confirmed, and no Pro access was activated.',
            confirmText: 'OK'
          });
        }
      }
    });
    checkout.on('payment.failed', event => {
      paymentOutcomeReceived = true;
      const failure = event.error || {};
      console.error('Razorpay reported a failed payment.', {
        code: failure.code,
        description: failure.description,
        reason: failure.reason,
        step: failure.step
      });
      const details = [failure.code, failure.description, failure.reason, failure.step]
        .filter(value => typeof value === 'string' && value.trim())
        .join(' — ');
      const failureMessage = razorpayFailureMessage(failure);
      checkoutStatus.textContent = details
        ? `Razorpay checkout failed: ${details}`
        : failureMessage.message;
      void alertModern({
        ...failureMessage,
        confirmText: 'Try again',
        variant: 'error'
      });
    });
    checkout.open();
    checkoutStatus.textContent = 'Complete the payment in the Razorpay checkout window.';
  } catch (error) {
    console.error('Could not start Razorpay checkout.', error);
    checkoutStatus.textContent = error.message;
    updatePurchaseControls();
    await alertModern({
      title: 'Could not start checkout',
      message: error.message || 'Razorpay checkout could not be started. Please try again.',
      confirmText: 'OK',
      variant: 'error'
    });
  }
}

monthlyButton.addEventListener('click', () => entitlement?.status === 'active'
  ? window.location.assign('/billing.html')
  : startCheckout('monthly'));
yearlyButton.addEventListener('click', () => {
  if (entitlement?.status === 'active' && entitlement.billingPlan === 'monthly') {
    return scheduleYearlySwitch();
  }
  if (entitlement?.status === 'active') {
    window.location.assign('/billing.html');
    return;
  }
  return startCheckout('yearly');
});

$('#pricingVoucherForm').addEventListener('submit', async event => {
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
  if (!code) return;

  voucherButton.disabled = true;
  voucherStatus.dataset.state = '';
  voucherStatus.textContent = 'Checking voucher…';
  try {
    const result = await redeemBillingVoucher(currentUser, code);
    entitlement = result.entitlement;
    entitlementResolved = true;
    voucherInput.value = '';
    updatePurchaseControls();
    updateVoucherControls();
    voucherStatus.dataset.state = 'success';
    voucherStatus.textContent = result.entitlement.lifetime
      ? 'Voucher redeemed. Lifetime Pro access is active.'
      : `Voucher redeemed. Pro is active through ${new Date(result.entitlement.validUntil).toLocaleDateString('en-IN')}.`;
  } catch (error) {
    console.error('Could not redeem voucher from the Plans page.', error);
    voucherStatus.dataset.state = 'error';
    voucherStatus.textContent = error.message || 'Could not redeem this voucher.';
  } finally {
    updateVoucherControls();
  }
});

loadBillingConfig().then(config => {
  billingConfig = config;
  if (!config.checkoutEnabled) {
    checkoutStatus.textContent = 'Pro checkout is temporarily unavailable. Please try again later.';
  }
  updatePurchaseControls();
  updateVoucherControls();
}).catch(error => {
  console.error('Could not load checkout configuration.', error);
  checkoutStatus.textContent = error.message;
  updateVoucherControls();
});

if (!cloudConfigured) {
  void refreshPricingState(null);
  checkoutStatus.textContent = 'Google sign-in is not configured on this site. Purchases are unavailable.';
  updateVoucherControls();
} else {
  observeAuth((user, error) => {
    if (error) {
      console.error('Could not observe Firebase sign-in state.', error);
      currentUser = null;
      entitlement = null;
      entitlementResolved = false;
      entitlementResolved = false;
      checkoutStatus.textContent = 'Sign-in could not be initialized. Paid purchases are unavailable.';
      updatePurchaseControls();
      updateVoucherControls();
      return;
    }
    refreshPricingState(user);
  });
}
