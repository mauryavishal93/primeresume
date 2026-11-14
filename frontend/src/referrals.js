import { getFirebaseIdToken, observeAuth } from './firebase-cloud.js';
import { buildReferralShareMessage, buildReferralShareUrl } from './referral-sharing.js';

const $ = selector => document.querySelector(selector);
const content = $('[data-referrals-content]');
const status = $('[data-referrals-status]');
const signInPanel = $('[data-referrals-sign-in]');
const historyBody = $('[data-referral-history]');
const ledgerBody = $('[data-reward-ledger]');
const historyMore = $('[data-history-more]');
const rewardsMore = $('[data-rewards-more]');
let currentUser = null;
let historyCursor = null;
let rewardsCursor = null;
let historyLoaded = false;
let rewardsLoaded = false;
let referralUrl = 'https://www.resumeout.com/';
let referralCode = '';

function setStatus(message, state = 'ready') {
  status.textContent = message;
  status.dataset.state = state;
}

async function api(path, user) {
  const token = await getFirebaseIdToken(user);
  const response = await fetch(path, {
    cache: 'no-store',
    headers: { authorization: `Bearer ${token}` }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Referral request failed (HTTP ${response.status}).`);
  return body;
}

function formatDate(timestamp) {
  const numeric = Number(timestamp);
  return Number.isFinite(numeric) && numeric > 0
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(numeric))
    : '—';
}

function addCell(row, value) {
  const cell = document.createElement('td');
  cell.textContent = value == null || value === '' ? '—' : String(value);
  row.append(cell);
}

function renderMetrics(summary) {
  const paidConversions = (Number(summary.monthlyConversions) || 0) + (Number(summary.yearlyConversions) || 0);
  const metrics = [
    ['Friends joined', summary.successfulRegistrations],
    ['Upgraded to paid', paidConversions],
    ['Pro days earned', summary.totalPromotionalDaysEarned]
  ];
  const container = $('[data-referral-metrics]');
  container.replaceChildren(...metrics.map(([label, value]) => {
    const card = document.createElement('article');
    card.className = 'referral-metric';
    const name = document.createElement('span');
    name.textContent = label;
    const total = document.createElement('strong');
    total.textContent = String(Number(value) || 0);
    card.append(name, total);
    return card;
  }));
}

function renderHistory(items, append) {
  if (!append) historyBody.replaceChildren();
  if (!items.length && !append) {
    const row = historyBody.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 7;
    cell.className = 'referral-list-info';
    cell.setAttribute('role', 'status');
    cell.textContent = 'No referral history.';
    return;
  }
  for (const referral of items) {
    const row = historyBody.insertRow();
    addCell(row, referral.referredIdentity);
    addCell(row, formatDate(referral.referralDate || referral.registeredAt || referral.createdAt));
    addCell(row, referral.registrationStatus || (referral.status === 'registered' || referral.status === 'converted' ? 'Registered' : referral.status));
    addCell(row, referral.qualifyingPlanType || '—');
    addCell(row, referral.verifiedPaymentStatus === 'verified' ? 'Verified' : 'Not paid');
    addCell(row, referral.conversionRewardDays ? `${referral.conversionRewardDays} days` : '—');
    addCell(row, referral.currentStatus || referral.status || '—');
  }
}

function renderLedger(items, append) {
  if (!append) ledgerBody.replaceChildren();
  if (!items.length && !append) {
    const row = ledgerBody.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 7;
    cell.className = 'referral-list-info';
    cell.setAttribute('role', 'status');
    cell.textContent = 'No promotional rewards have been recorded yet.';
    return;
  }
  for (const reward of items) {
    const row = ledgerBody.insertRow();
    addCell(row, formatDate(reward.createdAt));
    addCell(row, reward.rewardSource === 'admin_manual' ? 'Admin adjustment' : reward.rewardType);
    addCell(row, reward.description);
    addCell(row, reward.rewardType === 'reversal' ? `−${reward.durationDays}` : reward.durationDays);
    addCell(row, reward.status);
    addCell(row, formatDate(reward.startsAt || reward.activatedAt));
    addCell(row, formatDate(reward.expiresAt));
  }
}

function renderListError(body, message) {
  body.replaceChildren();
  const row = body.insertRow();
  const cell = row.insertCell();
  cell.colSpan = 7;
  cell.className = 'referral-list-error';
  cell.setAttribute('role', 'status');
  cell.textContent = message;
}

async function loadHistory(append = false) {
  const query = new URLSearchParams({ limit: '20' });
  if (append && historyCursor) query.set('cursor', historyCursor);
  const result = await api(`/api/referrals/history?${query}`, currentUser);
  historyCursor = result.nextCursor;
  historyLoaded = true;
  historyMore.hidden = !historyCursor;
  renderHistory(result.items || [], append);
}

async function loadRewards(append = false) {
  const query = new URLSearchParams({ limit: '20' });
  if (append && rewardsCursor) query.set('cursor', rewardsCursor);
  const result = await api(`/api/referrals/rewards?${query}`, currentUser);
  rewardsCursor = result.nextCursor;
  rewardsLoaded = true;
  rewardsMore.hidden = !rewardsCursor;
  renderLedger(result.items || [], append);
}

async function loadDashboard(user) {
  currentUser = user;
  content.hidden = true;
  signInPanel.hidden = Boolean(user);
  referralUrl = 'https://www.resumeout.com/';
  referralCode = '';
  $('#referral-url').value = referralUrl;
  $('[data-referral-code]').textContent = user ? 'Loading…' : 'Sign in to view';
  $('[data-copy-code]').disabled = true;
  $('[data-referral-hint]').textContent = user
    ? 'Loading your tracked referral link…'
    : 'Sign in to get your personal referral link. This general link does not track referrals.';
  $('[data-referral-message]').value = referralShareMessage();
  updateShareLinks();
  if (!user) {
    setStatus('');
    return;
  }
  setStatus('Loading referral rewards…', 'loading');
  let data;
  try {
    data = await api('/api/referrals/me', user);
    if (typeof data.code !== 'string' || !data.code.trim() || typeof data.url !== 'string' || !data.url.trim()) {
      throw new Error('The server did not return a valid referral code and link.');
    }
  } catch (error) {
    if (currentUser?.uid !== user.uid) return;
    content.hidden = true;
    signInPanel.hidden = true;
    $('[data-referral-code]').textContent = 'Unavailable';
    $('[data-referral-hint]').textContent = 'Your personal referral link could not be loaded. You can still share this general ResumeOut link.';
    setStatus(error instanceof Error ? error.message : 'Could not load referral rewards.', 'error');
    return;
  }

  if (currentUser?.uid !== user.uid) return;
  referralUrl = data.url;
  referralCode = data.code.trim();
  $('#referral-url').value = referralUrl;
  $('[data-referral-code]').textContent = referralCode;
  $('[data-copy-code]').disabled = false;
  $('[data-referral-hint]').textContent = 'Share this personal link so your referrals are tracked to your account.';
  $('[data-referral-message]').value = referralShareMessage();
  updateShareLinks();
  content.hidden = false;
  signInPanel.hidden = true;
  if (data.summary) renderMetrics(data.summary);

  historyCursor = null;
  rewardsCursor = null;
  const dashboardResults = await Promise.allSettled([loadHistory(), loadRewards()]);
  if (currentUser?.uid !== user.uid) return;
  if (dashboardResults[0].status === 'rejected') {
    renderListError(historyBody, 'Referral history could not be loaded right now. Please try again later.');
  }
  if (dashboardResults[1].status === 'rejected') {
    renderListError(ledgerBody, 'Reward history could not be loaded right now. Please try again later.');
  }
  setStatus(
    data.summaryError || 'Referral dashboard loaded.',
    data.summaryError ? 'error' : 'ready'
  );
}

async function copyReferralLink() {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(referralUrl);
    } else {
      const input = $('#referral-url');
      input.focus();
      input.select();
      if (!document.execCommand('copy')) throw new Error('Copy is not supported in this browser.');
    }
    $('[data-share-feedback]').textContent = 'Referral link copied.';
  } catch (error) {
    $('[data-share-feedback]').textContent = error instanceof Error ? error.message : 'Could not copy the referral link.';
  }
}

function referralShareMessage() {
  return buildReferralShareMessage(referralUrl, referralCode);
}

function shareUrlFor(service) {
  return buildReferralShareUrl(service, referralShareMessage(), referralUrl);
}

function updateShareLinks() {
  for (const [selector, service] of [
    ['[data-whatsapp]', 'whatsapp'],
    ['[data-telegram]', 'telegram'],
    ['[data-facebook]', 'facebook'],
    ['[data-x-social]', 'x'],
    ['[data-linkedin]', 'linkedin']
  ]) {
    $(selector).href = shareUrlFor(service);
  }
  const subject = 'ResumeOut – Your Next Career Move Starts Here!';
  $('[data-email]').href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(referralShareMessage())}`;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to the selection-based copy path when clipboard permissions are unavailable.
    }
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  let copied = false;
  try {
    input.select();
    copied = document.execCommand('copy');
  } finally {
    input.remove();
  }
  if (!copied) throw new Error('Copy is not supported in this browser.');
}

$('[data-copy-link]').addEventListener('click', copyReferralLink);
$('[data-copy-code]').addEventListener('click', async () => {
  try {
    await copyText(referralCode);
    $('[data-share-feedback]').textContent = 'Referral code copied.';
  } catch (error) {
    $('[data-share-feedback]').textContent = error instanceof Error ? error.message : 'Could not copy the referral code.';
  }
});
$('[data-copy-message]').addEventListener('click', async () => {
  try {
    await copyText(referralShareMessage());
    $('[data-share-feedback]').textContent = 'Referral message copied.';
  } catch (error) {
    $('[data-share-feedback]').textContent = error instanceof Error ? error.message : 'Could not copy the referral message.';
  }
});
$('[data-share-invite]').addEventListener('click', async () => {
  const message = referralShareMessage();
  if (navigator.share) {
    try {
      await navigator.share({ title: 'ResumeOut – Your Next Career Move Starts Here!', text: message });
    } catch (error) {
      if (error?.name !== 'AbortError') $('[data-share-feedback]').textContent = 'Could not open the share sheet.';
    }
  } else {
    try {
      await copyText(message);
      $('[data-share-feedback]').textContent = 'Invite message copied. Paste it into your favorite app.';
    } catch (error) {
      $('[data-share-feedback]').textContent = error instanceof Error ? error.message : 'Could not copy the invite message.';
    }
  }
});
for (const [selector, service] of [
  ['[data-whatsapp]', 'whatsapp'],
  ['[data-telegram]', 'telegram'],
  ['[data-x-social]', 'x'],
  ['[data-linkedin]', 'linkedin']
]) {
  $(selector).addEventListener('click', event => {
    event.currentTarget.href = shareUrlFor(service);
  });
}
const facebookShareLink = $('[data-facebook]');
const facebookShareDialog = $('[data-facebook-share-dialog]');
const facebookShareMessage = $('[data-facebook-share-message]');
const facebookShareStatus = $('[data-facebook-share-status]');
const facebookContinueLink = $('[data-facebook-continue]');
function setFacebookShareStatus(message, state = '') {
  facebookShareStatus.textContent = message;
  if (state) facebookShareStatus.dataset.state = state;
  else delete facebookShareStatus.dataset.state;
}

facebookShareLink.addEventListener('click', event => {
  event.preventDefault();
  facebookShareMessage.value = referralShareMessage();
  facebookContinueLink.href = shareUrlFor('facebook');
  setFacebookShareStatus('Copy the message, then open Facebook and paste it into the post.');
  if (facebookShareDialog.open) facebookShareDialog.close();
  facebookShareDialog.showModal();
  void copyText(facebookShareMessage.value).then(() => {
    setFacebookShareStatus('Message copied. Click “Open Facebook”, then paste it into “What’s on your mind?”');
  }).catch(error => {
    setFacebookShareStatus(error instanceof Error ? error.message : 'Copy failed. Select the message above and copy it manually.', 'error');
  });
});
$('[data-facebook-copy]').addEventListener('click', async () => {
  try {
    await copyText(facebookShareMessage.value);
    setFacebookShareStatus('Message copied. Click “Open Facebook”, then paste it into “What’s on your mind?”');
  } catch (error) {
    setFacebookShareStatus(error instanceof Error ? error.message : 'Copy failed. Select the message above and copy it manually.', 'error');
  }
});
$('[data-facebook-continue]').addEventListener('click', () => facebookShareDialog.close());
$('[data-facebook-close]').addEventListener('click', () => facebookShareDialog.close());
$('[data-referral-message]').value = referralShareMessage();
updateShareLinks();
$('[data-email]').addEventListener('click', event => {
  const subject = 'ResumeOut – Your Next Career Move Starts Here!';
  event.currentTarget.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(referralShareMessage())}`;
});
historyMore.addEventListener('click', async () => {
  historyMore.disabled = true;
  try {
    await loadHistory(true);
  } catch (error) {
    setStatus(error.message || 'Could not load more referrals.', 'error');
  } finally {
    historyMore.disabled = false;
  }
});
rewardsMore.addEventListener('click', async () => {
  rewardsMore.disabled = true;
  try {
    await loadRewards(true);
  } catch (error) {
    setStatus(error.message || 'Could not load more rewards.', 'error');
  } finally {
    rewardsMore.disabled = false;
  }
});

fetch('/api/referrals/config', { cache: 'no-store' })
  .then(async response => {
    const config = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(config.error || 'Referral rewards are unavailable.');
    if (!config.enabled) {
      setStatus('Referral rewards are not available yet.');
      return;
    }
    observeAuth((user, error) => {
      if (error) {
        setStatus('Sign-in could not be verified. Reload the page and sign in again.', 'error');
        return;
      }
      if (user?.uid !== currentUser?.uid || !historyLoaded || !rewardsLoaded) {
        void loadDashboard(user);
      }
    });
  })
  .catch(error => setStatus(error instanceof Error ? error.message : 'Referral rewards are unavailable.', 'error'));
