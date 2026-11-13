import { cloudConfigured, getAccountProfile, googleSignInErrorMessage, isGoogleSignInCancellation, observeAuth, signInWithGoogle, signOutUser } from './firebase-cloud.js';
import { clearBillingEntitlementCache, loadBillingConfig, loadBillingEntitlement } from './billing-client.js';
import { canUseFeature, FEATURE_IDS } from './plan-access.js';
import { confirmModern } from './modern-modal.js';
import { getAccountPhotoUrls, setAccountAvatar } from './account-avatar.js';
import { cacheAccountPhoto, cacheAccountPhotoFromUrls, cacheProBadgeHint, clearCachedProBadgeHint, clearUserSessionCache, getCachedAccountAvatarHint, getCachedAccountPhoto, getCachedProBadgeHint } from './session-cache.js';

const nav = document.querySelector('.about-nav');
const signInButton = document.querySelector('[data-auth-sign-in]');
let signOutButton = document.querySelector('[data-auth-sign-out]');
const status = document.querySelector('[data-auth-status]');
const brand = document.querySelector('.about-brand');
const originalTitle = document.title;
const proBadge = brand ? document.createElement('span') : null;
const standaloneTheme = nav?.querySelector(':scope > [data-theme-toggle]');
let currentUser = null;
let entitlementRequest = 0;
let signOutPending = false;

if (proBadge) {
  proBadge.className = 'about-pro-brand-badge';
  proBadge.textContent = 'Pro';
  proBadge.hidden = true;
  brand.append(proBadge);
}

const initialProBadgeHint = getCachedProBadgeHint();
if (proBadge && initialProBadgeHint) {
  proBadge.hidden = false;
  document.title = `${originalTitle} | Pro`;
}

function addMenuItem(panel, tag, className, text, href) {
  const item = document.createElement(tag);
  item.className = className;
  item.textContent = text;
  if (href) item.href = href;
  panel.append(item);
  return item;
}

function createAccountMenu() {
  if (!nav) return null;
  const menu = nav.querySelector('[data-account-menu-shell]') || document.createElement('details');
  menu.className = 'account-menu site-account-menu';
  menu.hidden = false;

  const summary = menu.querySelector('summary') || document.createElement('summary');
  summary.className = 'account-menu-trigger';
  summary.setAttribute('aria-label', 'Open account menu');
  const avatar = summary.querySelector('.account-avatar') || document.createElement('span');
  avatar.className = 'account-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  if (!avatar.querySelector('img')) avatar.textContent = 'U';
  if (!avatar.parentElement) summary.append(avatar);

  const panel = document.createElement('div');
  panel.className = 'account-menu-panel';
  const profile = document.createElement('div');
  profile.className = 'account-menu-profile';
  const largeAvatar = document.createElement('span');
  largeAvatar.className = 'account-avatar account-avatar-large';
  largeAvatar.setAttribute('aria-hidden', 'true');
  largeAvatar.textContent = 'U';
  const identity = document.createElement('span');
  identity.className = 'account-menu-identity';
  const name = document.createElement('strong');
  const email = document.createElement('span');
  identity.append(name, email);
  profile.append(largeAvatar, identity);
  panel.append(profile);
  const menuSignInButton = addMenuItem(panel, 'button', 'account-menu-item account-menu-signin', 'Sign in with Google');
  menuSignInButton.type = 'button';
  menuSignInButton.hidden = true;

  const accountLink = addMenuItem(panel, 'a', 'account-menu-item', 'My account', '/my-account.html');
  accountLink.hidden = true;
  if (location.pathname === '/my-account.html') accountLink.setAttribute('aria-current', 'page');
  const myPostsLink = addMenuItem(panel, 'a', 'account-menu-item', 'My posts', '/my-posts.html');
  myPostsLink.hidden = true;
  if (location.pathname === '/my-posts.html') myPostsLink.setAttribute('aria-current', 'page');
  const billingLink = addMenuItem(panel, 'a', 'account-menu-item', 'Billing', '/billing.html');
  if (location.pathname === '/billing.html') billingLink.setAttribute('aria-current', 'page');
  const communityLink = addMenuItem(panel, 'a', 'account-menu-item', 'Community', '/community.html');
  if (location.pathname === '/community.html') communityLink.setAttribute('aria-current', 'page');
  const about = addMenuItem(panel, 'a', 'account-menu-item', 'About', '/about.html');
  const supportLink = addMenuItem(panel, 'a', 'account-menu-item', 'Support', '/support.html');
  if (location.pathname === '/support.html') supportLink.setAttribute('aria-current', 'page');

  const appearance = document.createElement('div');
  appearance.className = 'account-menu-theme';
  const appearanceLabel = document.createElement('span');
  appearanceLabel.textContent = 'Appearance';
  const themeButton = standaloneTheme || document.createElement('button');
  if (!standaloneTheme) {
    themeButton.type = 'button';
    themeButton.className = 'theme-switch';
    themeButton.setAttribute('role', 'switch');
    themeButton.setAttribute('data-theme-toggle', '');
    const dark = document.documentElement.dataset.theme === 'dark';
    themeButton.setAttribute('aria-checked', String(dark));
    themeButton.setAttribute('aria-label', `${dark ? 'Dark' : 'Light'} theme`);
    themeButton.innerHTML = '<span class="theme-switch-track" aria-hidden="true"><span class="theme-switch-thumb"></span></span><span class="theme-switch-label"></span>';
    themeButton.querySelector('.theme-switch-label').textContent = dark ? 'Dark' : 'Light';
  }
  appearance.append(appearanceLabel, themeButton);
  panel.append(appearance);

  if (!signOutButton) {
    signOutButton = document.createElement('button');
    signOutButton.type = 'button';
    signOutButton.textContent = 'Sign out';
  }
  signOutButton.className = 'account-menu-item account-menu-signout';
  signOutButton.hidden = true;
  panel.append(signOutButton);
  if (!panel.parentElement) menu.append(panel);
  if (!summary.parentElement) menu.append(summary);
  if (!menu.parentElement) nav.append(menu);

  const positionMobilePanel = () => {
    if (!menu.open || !window.matchMedia('(max-width:640px)').matches) {
      panel.style.position = '';
      panel.style.top = '';
      panel.style.right = '';
      return;
    }
    const triggerBounds = summary.getBoundingClientRect();
    panel.style.position = 'fixed';
    panel.style.top = `${triggerBounds.bottom + 8}px`;
    panel.style.right = '8px';
  };
  menu.addEventListener('toggle', positionMobilePanel);
  window.addEventListener('resize', positionMobilePanel);

  document.addEventListener('click', event => {
    if (!menu.contains(event.target)) menu.open = false;
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu.open) {
      menu.open = false;
      summary.focus();
    }
  });

  return { menu, summary, avatar, largeAvatar, profile, name, email, menuSignInButton, about, accountLink, billingLink, myPostsLink };
}

const accountMenu = createAccountMenu();
const initialAccountAvatar = getCachedAccountAvatarHint();
if (accountMenu && initialAccountAvatar) {
  document.body.classList.add('account-avatar-cached');
  accountMenu.profile.hidden = true;
  setAccountAvatar(accountMenu.avatar, 'U', initialAccountAvatar.photoDataUrl);
  setAccountAvatar(accountMenu.largeAvatar, 'U', initialAccountAvatar.photoDataUrl);
}

window.addEventListener('account-profile-updated', event => {
  const { uid, displayName, photoDataUrl } = event.detail || {};
  if (!accountMenu || !currentUser || currentUser.uid !== uid) return;
  const accountName = displayName || currentUser.email?.split('@')[0] || 'Google user';
  const initial = Array.from(accountName)[0]?.toLocaleUpperCase() || 'U';
  accountMenu.name.textContent = accountName;
  accountMenu.summary.setAttribute('aria-label', `Account menu for ${accountName}`);
  const cachedPhoto = photoDataUrl || getCachedAccountPhoto(uid) || '';
  const photos = getAccountPhotoUrls(currentUser, cachedPhoto);
  if (photoDataUrl) cacheAccountPhoto(uid, photoDataUrl);
  setAccountAvatar(accountMenu.avatar, initial, photos);
  setAccountAvatar(accountMenu.largeAvatar, initial, photos);
  void cacheAccountPhotoFromUrls(uid, getAccountPhotoUrls(currentUser));
});

function updateProBadge(entitlement) {
  const hasVerifiedPro = canUseFeature(FEATURE_IDS.ALL_TEMPLATES, entitlement);
  const hint = getCachedProBadgeHint();
  const hintMatchesUser = hint && (
    !document.body.classList.contains('auth-state-ready')
    || currentUser?.uid === hint.uid
  );
  const hasPro = hasVerifiedPro || Boolean(
    hintMatchesUser && hint.validUntil > Date.now()
  );
  if (proBadge) proBadge.hidden = !hasPro;
  document.title = hasPro ? `${originalTitle} | Pro` : originalTitle;
}

async function refreshProBadge(user) {
  const requestId = ++entitlementRequest;
  currentUser = user;
  if (!user) {
    clearCachedProBadgeHint();
    updateProBadge(null);
    return;
  }

  const savedBadgeHint = getCachedProBadgeHint();
  if (savedBadgeHint && savedBadgeHint.uid !== user.uid) clearCachedProBadgeHint(savedBadgeHint.uid);
  updateProBadge(null);
  try {
    const config = await loadBillingConfig();
    const entitlement = config.entitlementEnabled
      ? await loadBillingEntitlement(user, { forceRefresh: true })
      : null;
    if (requestId === entitlementRequest) {
      if (config.entitlementEnabled) cacheProBadgeHint(user.uid, entitlement);
      else clearCachedProBadgeHint(user.uid);
      updateProBadge(entitlement);
    }
  } catch (error) {
    if (requestId === entitlementRequest) {
      clearBillingEntitlementCache(user);
      updateProBadge(null);
    }
    console.error('Could not load the account Pro status.', error);
  }
}

function updateAuthControls(user, error) {
  document.body.classList.add('auth-state-ready');
  document.body.classList.remove('account-avatar-cached');
  accountMenu?.menu.removeAttribute('data-auth-shell-visible');
  const previousUser = currentUser;
  if (previousUser && previousUser.uid !== user?.uid) {
    clearUserSessionCache(previousUser.uid);
    clearBillingEntitlementCache(previousUser);
  }
  if (error) {
    void refreshProBadge(null);
    console.error('Could not initialize account controls.', error);
    if (signInButton) {
      signInButton.hidden = false;
      signInButton.disabled = true;
      signInButton.querySelector('[data-auth-sign-in-label]').textContent = 'Cloud setup needed';
      signInButton.title = error.message;
    }
    if (signOutButton) signOutButton.hidden = true;
    if (status) {
      status.textContent = error.message;
      status.classList.add('auth-error');
    }
    if (accountMenu) {
      accountMenu.menu.hidden = false;
      accountMenu.profile.hidden = true;
      accountMenu.menuSignInButton.hidden = false;
      accountMenu.menuSignInButton.disabled = true;
      accountMenu.menuSignInButton.textContent = 'Cloud setup needed';
      accountMenu.name.textContent = 'Guest';
      accountMenu.email.textContent = '';
      accountMenu.avatar.textContent = 'G';
      accountMenu.largeAvatar.textContent = 'G';
      accountMenu.summary.setAttribute('aria-label', 'Account menu');
      accountMenu.accountLink.hidden = true;
      accountMenu.myPostsLink.hidden = true;
    }
    if (signOutButton) signOutButton.hidden = true;
    return;
  }

  if (status) status.classList.remove('auth-error');
  void refreshProBadge(user);
  if (signInButton) {
    signInButton.hidden = Boolean(user);
    signInButton.disabled = false;
    signInButton.querySelector('[data-auth-sign-in-label]').textContent = 'Sign in with Google';
    signInButton.title = '';
  }
  if (signOutButton) {
    signOutButton.hidden = !user;
    signOutButton.disabled = false;
    signOutButton.textContent = 'Sign out';
    signOutButton.title = user?.email || user?.displayName || 'Signed-in account';
  }
  if (status) status.textContent = user ? `Signed in as ${user.email || user.displayName || 'Google user'}.` : 'You are signed out.';
  if (accountMenu) {
    accountMenu.menu.hidden = false;
    accountMenu.myPostsLink.hidden = !user;
    accountMenu.profile.hidden = !user;
    accountMenu.menuSignInButton.hidden = Boolean(user);
    accountMenu.menuSignInButton.disabled = false;
    accountMenu.menuSignInButton.textContent = 'Sign in with Google';
    if (user) {
      accountMenu.menu.open = false;
      const accountName = user.displayName?.trim() || user.email?.split('@')[0] || 'Google user';
      const initial = Array.from(accountName)[0]?.toLocaleUpperCase() || 'U';
      accountMenu.avatar.textContent = initial;
      accountMenu.largeAvatar.textContent = initial;
      accountMenu.name.textContent = accountName;
      accountMenu.email.textContent = user.email || '';
      accountMenu.summary.setAttribute('aria-label', `Account menu for ${accountName}`);
      accountMenu.accountLink.hidden = false;
      if (location.pathname === '/about.html') accountMenu.about.setAttribute('aria-current', 'page');
      else accountMenu.about.removeAttribute('aria-current');
      if (location.pathname === '/billing.html') accountMenu.billingLink.setAttribute('aria-current', 'page');
      else accountMenu.billingLink.removeAttribute('aria-current');
      if (location.pathname === '/my-posts.html') accountMenu.myPostsLink.setAttribute('aria-current', 'page');
      else accountMenu.myPostsLink.removeAttribute('aria-current');
      if (location.pathname === '/my-account.html') accountMenu.accountLink.setAttribute('aria-current', 'page');
      else accountMenu.accountLink.removeAttribute('aria-current');
      const accountUid = user.uid;
      const cachedPhoto = getCachedAccountPhoto(accountUid);
      const photos = getAccountPhotoUrls(user, cachedPhoto ?? '');
      setAccountAvatar(accountMenu.avatar, initial, photos);
      setAccountAvatar(accountMenu.largeAvatar, initial, photos);
      void cacheAccountPhotoFromUrls(accountUid, getAccountPhotoUrls(user));
      if (cachedPhoto === null && location.pathname !== '/my-account.html') {
        void getAccountProfile(user).then(profile => {
          if (currentUser?.uid !== accountUid || !accountMenu) return;
          cacheAccountPhoto(accountUid, profile.photoDataUrl);
          const photos = getAccountPhotoUrls(user, profile.photoDataUrl);
          setAccountAvatar(accountMenu.avatar, initial, photos);
          setAccountAvatar(accountMenu.largeAvatar, initial, photos);
        }).catch(profileError => {
          if (currentUser?.uid === accountUid) console.error('Could not load the account profile image.', profileError);
        });
      }
    } else {
      accountMenu.name.textContent = 'Guest';
      accountMenu.email.textContent = '';
      accountMenu.avatar.textContent = 'G';
      accountMenu.largeAvatar.textContent = 'G';
      setAccountAvatar(accountMenu.avatar, 'G');
      setAccountAvatar(accountMenu.largeAvatar, 'G');
      accountMenu.summary.setAttribute('aria-label', 'Account menu');
      accountMenu.accountLink.hidden = true;
      accountMenu.myPostsLink.hidden = true;
    }
  }
}

async function handleGoogleSignIn() {
  try {
    await signInWithGoogle();
  } catch (error) {
    if (isGoogleSignInCancellation(error)) return;
    console.error('Google sign-in failed.', error);
    if (status) {
      status.textContent = googleSignInErrorMessage(error);
      status.classList.add('auth-error');
    }
  }
}

signInButton?.addEventListener('click', handleGoogleSignIn);
accountMenu?.menuSignInButton.addEventListener('click', handleGoogleSignIn);

signOutButton?.addEventListener('click', async () => {
  if (signOutPending) return;
  signOutPending = true;
  try {
    const confirmed = await confirmModern({
      title: 'Sign out?',
      message: 'Are you sure you want to sign out of your account?',
      confirmText: 'Sign out',
      cancelText: 'Stay signed in',
      variant: 'danger'
    });
    if (!confirmed) return;
    signOutButton.disabled = true;
    signOutButton.textContent = 'Signing out…';
    if (status) {
      status.textContent = 'Signing out…';
      status.classList.remove('auth-error');
    }
    document.body.classList.add('auth-signout-pending');
    await signOutUser();
    window.location.assign('/home.html');
  } catch (error) {
    document.body.classList.remove('auth-signout-pending');
    console.error('Could not sign out.', error);
    if (status) {
      status.textContent = error.message || 'Could not sign out.';
      status.classList.add('auth-error');
    }
  } finally {
    signOutPending = false;
    signOutButton.disabled = false;
    signOutButton.textContent = 'Sign out';
  }
});

if (cloudConfigured) observeAuth(updateAuthControls);
else updateAuthControls(null, new Error('Google sign-in is not configured on this site.'));

window.addEventListener('focus', () => {
  if (currentUser) void refreshProBadge(currentUser);
});
