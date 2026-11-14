import { clearPendingReferralCode, cloudConfigured, getAccountProfile, getFirebaseIdToken, getPendingReferralCode, observeAuth, saveAccountProfile } from './firebase-cloud.js';
import { getAccountPhotoUrl, setAccountAvatar } from './account-avatar.js';
import { cacheAccountPhoto, clearCachedAccountAvatar } from './session-cache.js';
import { formatNationalPhoneNumber, formatPhoneInput, getDefaultPhoneCountry, getPhoneCountryCallingCode, getPhoneCountryLabel, getPhoneCountryOptions, parseAccountPhoneNumber, splitAccountPhoneNumber } from './phone-number.js';

const form = document.querySelector('#accountForm');
const fields = document.querySelector('#accountFields');
const nameInput = document.querySelector('#accountName');
const highestEducationInput = document.querySelector('#accountHighestEducation');
const companyInput = document.querySelector('#accountCompany');
const designationInput = document.querySelector('#accountDesignation');
const emailInput = document.querySelector('#accountEmail');
const mobileInput = document.querySelector('#accountMobile');
const countrySelect = document.querySelector('#accountCountry');
const photoInput = document.querySelector('#accountPhoto');
const photoPreview = document.querySelector('#accountPhotoPreview');
const removePhotoButton = document.querySelector('#removeAccountPhoto');
const saveButton = document.querySelector('#saveAccount');
const status = document.querySelector('#accountStatus');
const signInPrompt = document.querySelector('#accountSignIn');
const referralPanel = document.querySelector('#accountReferralPanel');
const referralForm = document.querySelector('#accountReferralForm');
const referralCodeInput = document.querySelector('#accountReferralCode');
const applyReferralCodeButton = document.querySelector('#applyReferralCode');
const referralStatus = document.querySelector('#accountReferralStatus');
let currentUser = null;
let requestId = 0;
let photoDataUrl = '';
let fallbackPhotoUrl = '';
const defaultPhoneCountry = getDefaultPhoneCountry();
const phoneCountryOptions = getPhoneCountryOptions();

for (const option of phoneCountryOptions) {
  const element = document.createElement('option');
  element.value = option.country;
  element.textContent = getPhoneCountryLabel(option.country, option.callingCode);
  element.title = `${option.name} (+${option.callingCode})`;
  countrySelect.append(element);
}
countrySelect.value = defaultPhoneCountry;

function sizeCountrySelect() {
  const selectedCountry = phoneCountryOptions.find(option => option.country === countrySelect.value);
  const selectedLabel = getPhoneCountryLabel(countrySelect.value, getPhoneCountryCallingCode(countrySelect.value));
  const measureContext = document.createElement('canvas').getContext('2d');
  if (!measureContext) throw new Error('Your browser could not measure the country selector text.');
  measureContext.font = getComputedStyle(countrySelect).font;
  countrySelect.style.width = `${Math.ceil(measureContext.measureText(selectedLabel).width + 48)}px`;
  countrySelect.title = selectedCountry ? `${selectedCountry.name} (+${selectedCountry.callingCode})` : selectedLabel;
}

sizeCountrySelect();

function showStatus(message, state = '') {
  status.textContent = message;
  if (state) status.dataset.state = state;
  else delete status.dataset.state;
}

function showReferralStatus(message, state = '') {
  referralStatus.textContent = message;
  if (state) referralStatus.dataset.state = state;
  else delete referralStatus.dataset.state;
}

function clearReferralCodeFromUrl() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('ref')) return;
  url.searchParams.delete('ref');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

async function updateReferralCodeStatus(user, currentRequest) {
  referralForm.hidden = true;
  showReferralStatus('Checking referral-code eligibility…');
  let referralsUnavailable = false;
  try {
    const response = await fetch('/api/referrals/claim-status', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { authorization: `Bearer ${await getFirebaseIdToken(user)}` }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      referralsUnavailable = response.status === 404;
      throw new Error(result.error || 'Could not check referral-code eligibility.');
    }
    if (currentRequest !== requestId || currentUser?.uid !== user.uid) return;
    if (result.claimed) {
      clearPendingReferralCode();
      clearReferralCodeFromUrl();
      showReferralStatus('A referral code has already been used by this account. Referral codes can only be used once.');
      return;
    }
    if (result.eligible) {
      const pendingCode = getPendingReferralCode();
      if (pendingCode) referralCodeInput.value = pendingCode;
      referralForm.hidden = false;
      showReferralStatus(pendingCode
        ? 'Your referral link code is ready. Apply it before the 30-day claim period ends.'
        : 'Enter a valid code before the 30-day claim period ends.');
      return;
    }
    clearPendingReferralCode();
    clearReferralCodeFromUrl();
    showReferralStatus('Referral-code entry is available only within 30 days of creating your account.');
  } catch (error) {
    if (currentRequest !== requestId || currentUser?.uid !== user.uid) return;
    referralForm.hidden = referralsUnavailable;
    showReferralStatus(error instanceof Error ? error.message : 'Could not check referral-code eligibility.', 'error');
  }
}

function setFormEnabled(enabled) {
  fields.disabled = !enabled;
  saveButton.disabled = !enabled;
  photoInput.disabled = !enabled;
  removePhotoButton.disabled = !enabled;
}

function updatePhotoPreview(photo = photoDataUrl || fallbackPhotoUrl, user = currentUser) {
  const name = nameInput.value.trim() || user?.email?.split('@')[0] || 'User';
  const initial = Array.from(name)[0]?.toLocaleUpperCase() || 'U';
  setAccountAvatar(photoPreview, initial, photo);
  removePhotoButton.hidden = !photoDataUrl;
}

async function resizeProfilePhoto(file) {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error('Choose a JPG, PNG, or WebP image.');
  }
  if (file.size > 10 * 1024 * 1024) throw new Error('Choose an image smaller than 10 MB.');

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    let dimension = 256;
    for (let attempt = 0; attempt < 8; attempt++) {
      const scale = Math.min(1, dimension / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Your browser could not process this image.');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.82, 0.68, 0.52, 0.4]) {
        const result = canvas.toDataURL('image/jpeg', quality);
        if (result.length <= 140000) return result;
      }
      dimension = Math.floor(dimension * 0.8);
    }
    throw new Error('This image could not be resized small enough. Choose another image.');
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function updateAccountPage(user, error) {
  const currentRequest = ++requestId;
  currentUser = user;
  form.hidden = !user;
  referralPanel.hidden = !user;
  signInPrompt.hidden = Boolean(user) || Boolean(error);
  setFormEnabled(false);

  if (error) {
    showStatus(error.message || 'Could not load your account details.', 'error');
    console.error('Could not initialize account details.', error);
    return;
  }
  if (!user) {
    referralForm.hidden = true;
    showStatus(cloudConfigured ? 'Sign in to manage your account.' : 'Account sign-in is not configured.');
    return;
  }

  referralCodeInput.value = '';
  showReferralStatus('');
  void updateReferralCodeStatus(user, currentRequest);
  nameInput.value = user.displayName?.trim() || '';
  emailInput.value = user.email || '';
  fallbackPhotoUrl = getAccountPhotoUrl(user);
  showStatus('Loading your account details…');
  try {
    const profile = await getAccountProfile(user);
    if (currentRequest !== requestId || currentUser?.uid !== user.uid) return;
    const savedPhone = splitAccountPhoneNumber(profile.mobileNumber, defaultPhoneCountry);
    countrySelect.value = savedPhone.country;
    sizeCountrySelect();
    mobileInput.value = savedPhone.nationalNumber;
    highestEducationInput.value = profile.highestEducation ?? '';
    companyInput.value = profile.company ?? '';
    designationInput.value = profile.designation ?? '';
    photoDataUrl = profile.photoDataUrl;
    if (photoDataUrl) cacheAccountPhoto(user.uid, photoDataUrl);
    updatePhotoPreview();
    window.dispatchEvent(new CustomEvent('account-profile-updated', {
      detail: { uid: user.uid, displayName: nameInput.value, photoDataUrl }
    }));
    showStatus('');
    setFormEnabled(true);
  } catch (loadError) {
    if (currentRequest !== requestId) return;
    showStatus(loadError.message || 'Could not load your account details. Try again.', 'error');
    console.error('Could not load the account profile.', loadError);
  }
}

referralCodeInput.addEventListener('input', () => {
  referralCodeInput.value = referralCodeInput.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
});

referralForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentUser || applyReferralCodeButton.disabled || !referralCodeInput.value) return;
  const user = currentUser;
  applyReferralCodeButton.disabled = true;
  referralCodeInput.disabled = true;
  showReferralStatus('Verifying your referral code…');
  try {
    const response = await fetch('/api/referrals/register', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        authorization: `Bearer ${await getFirebaseIdToken(user)}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ code: referralCodeInput.value.trim() })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Could not apply this referral code.');
    if (currentUser?.uid !== user.uid) return;
    clearPendingReferralCode();
    clearReferralCodeFromUrl();
    referralForm.hidden = true;
    referralCodeInput.value = '';
    showReferralStatus(result.pendingReview
      ? 'Code submitted for review. If approved, you and your friend will each receive 7 days of Pro.'
      : 'Referral code applied! You and your friend each received 7 days of Pro.', 'success');
  } catch (error) {
    showReferralStatus(error instanceof Error ? error.message : 'Could not apply this referral code.', 'error');
  } finally {
    applyReferralCodeButton.disabled = false;
    referralCodeInput.disabled = false;
  }
});

nameInput.addEventListener('input', () => updatePhotoPreview());

mobileInput.addEventListener('input', () => {
  const caret = mobileInput.selectionStart ?? mobileInput.value.length;
  const digitsBeforeCaret = (mobileInput.value.slice(0, caret).match(/\d/g) || []).length;
  const formatted = formatPhoneInput(mobileInput.value, countrySelect.value);
  countrySelect.value = formatted.country;
  sizeCountrySelect();
  mobileInput.value = formatted.value;
  let nextCaret = 0;
  let digitsSeen = 0;
  while (nextCaret < formatted.value.length && digitsSeen < digitsBeforeCaret) {
    if (/\d/.test(formatted.value[nextCaret])) digitsSeen++;
    nextCaret++;
  }
  mobileInput.setSelectionRange(nextCaret, nextCaret);
});

countrySelect.addEventListener('change', () => {
  sizeCountrySelect();
  mobileInput.value = formatNationalPhoneNumber(mobileInput.value.replace(/\D/g, ''), countrySelect.value);
});

photoInput.addEventListener('change', async () => {
  const [file] = photoInput.files || [];
  if (!file) return;
  showStatus('Preparing your profile photo…');
  photoInput.disabled = true;
  removePhotoButton.disabled = true;
  try {
    photoDataUrl = await resizeProfilePhoto(file);
    updatePhotoPreview();
    showStatus('Photo ready. Save changes to update your account icon.');
  } catch (error) {
    showStatus(error.message || 'Could not load this image.', 'error');
  } finally {
    photoInput.value = '';
    photoInput.disabled = !currentUser || fields.disabled;
    removePhotoButton.disabled = !currentUser || fields.disabled;
  }
});

removePhotoButton.addEventListener('click', () => {
  photoDataUrl = '';
  updatePhotoPreview(fallbackPhotoUrl);
  showStatus('Profile photo removed. Save changes to apply it.');
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentUser || saveButton.disabled) return;

  const user = currentUser;
  saveButton.disabled = true;
  photoInput.disabled = true;
  removePhotoButton.disabled = true;
  saveButton.textContent = 'Saving…';
  showStatus('Saving your account details…');
  try {
    const phone = parseAccountPhoneNumber(mobileInput.value, countrySelect.value);
    const profile = await saveAccountProfile(user, nameInput.value, phone?.number || '', photoDataUrl, {
      highestEducation: highestEducationInput.value,
      company: companyInput.value,
      designation: designationInput.value
    });
    if (currentUser?.uid !== user.uid) return;
    nameInput.value = profile.name;
    highestEducationInput.value = profile.highestEducation ?? '';
    companyInput.value = profile.company ?? '';
    designationInput.value = profile.designation ?? '';
    const savedPhone = splitAccountPhoneNumber(profile.mobile, defaultPhoneCountry);
    countrySelect.value = savedPhone.country;
    sizeCountrySelect();
    mobileInput.value = savedPhone.nationalNumber;
    photoDataUrl = profile.photo;
    if (!photoDataUrl) clearCachedAccountAvatar(user.uid);
    cacheAccountPhoto(user.uid, photoDataUrl);
    updatePhotoPreview();
    window.dispatchEvent(new CustomEvent('account-profile-updated', {
      detail: { uid: user.uid, displayName: profile.name, photoDataUrl: profile.photo }
    }));
    showStatus('Your account details have been saved.', 'success');
  } catch (error) {
    showStatus(error.message || 'Could not save your account details. Try again.', 'error');
    console.error('Could not save the account profile.', error);
  } finally {
    saveButton.textContent = 'Save changes';
    saveButton.disabled = !currentUser || fields.disabled;
    photoInput.disabled = !currentUser || fields.disabled;
    removePhotoButton.disabled = !currentUser || fields.disabled;
  }
});

if (cloudConfigured) observeAuth(updateAccountPage);
else void updateAccountPage(null, new Error('Google sign-in is not configured on this site.'));
