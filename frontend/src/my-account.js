import { cloudConfigured, observeAuth, getAccountProfile, saveAccountProfile } from './firebase-cloud.js';
import { getAccountPhotoUrl, setAccountAvatar } from './account-avatar.js';

const form = document.querySelector('#accountForm');
const fields = document.querySelector('#accountFields');
const nameInput = document.querySelector('#accountName');
const emailInput = document.querySelector('#accountEmail');
const mobileInput = document.querySelector('#accountMobile');
const photoInput = document.querySelector('#accountPhoto');
const photoPreview = document.querySelector('#accountPhotoPreview');
const removePhotoButton = document.querySelector('#removeAccountPhoto');
const saveButton = document.querySelector('#saveAccount');
const status = document.querySelector('#accountStatus');
const signInPrompt = document.querySelector('#accountSignIn');
let currentUser = null;
let requestId = 0;
let photoDataUrl = '';
let fallbackPhotoUrl = '';

function showStatus(message, state = '') {
  status.textContent = message;
  if (state) status.dataset.state = state;
  else delete status.dataset.state;
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
  signInPrompt.hidden = Boolean(user) || Boolean(error);
  setFormEnabled(false);

  if (error) {
    showStatus(error.message || 'Could not load your account details.', 'error');
    console.error('Could not initialize account details.', error);
    return;
  }
  if (!user) {
    showStatus(cloudConfigured ? 'Sign in to manage your account.' : 'Account sign-in is not configured.');
    return;
  }

  nameInput.value = user.displayName?.trim() || '';
  emailInput.value = user.email || '';
  fallbackPhotoUrl = getAccountPhotoUrl(user);
  showStatus('Loading your account details…');
  try {
    const profile = await getAccountProfile(user);
    if (currentRequest !== requestId || currentUser?.uid !== user.uid) return;
    mobileInput.value = profile.mobileNumber;
    photoDataUrl = profile.photoDataUrl;
    updatePhotoPreview();
    showStatus('');
    setFormEnabled(true);
  } catch (loadError) {
    if (currentRequest !== requestId) return;
    showStatus(loadError.message || 'Could not load your account details. Try again.', 'error');
    console.error('Could not load the account profile.', loadError);
  }
}

nameInput.addEventListener('input', () => updatePhotoPreview());

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
    const profile = await saveAccountProfile(user, nameInput.value, mobileInput.value, photoDataUrl);
    if (currentUser?.uid !== user.uid) return;
    nameInput.value = profile.name;
    mobileInput.value = profile.mobile;
    photoDataUrl = profile.photo;
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
