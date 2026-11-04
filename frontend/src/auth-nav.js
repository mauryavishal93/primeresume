import { cloudConfigured, googleSignInErrorMessage, observeAuth, signInWithGoogle, signOutUser } from './firebase-cloud.js';
import { loadBillingConfig, loadBillingEntitlement } from './billing-client.js';
import { canUseFeature, FEATURE_IDS } from './plan-access.js';
import { confirmModern } from './modern-modal.js';

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
  const menu = document.createElement('details');
  menu.className = 'account-menu site-account-menu';
  menu.hidden = false;

  const summary = document.createElement('summary');
  summary.className = 'account-menu-trigger';
  summary.setAttribute('aria-label', 'Open account menu');
  const avatar = document.createElement('span');
  avatar.className = 'account-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = 'U';
  summary.append(avatar);

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

  const cloudLink = addMenuItem(panel, 'a', 'account-menu-item', 'My cloud resumes', '/editor.html?open=cloud');
  cloudLink.hidden = true;
  const myPostsLink = addMenuItem(panel, 'a', 'account-menu-item', 'My posts', '/my-posts.html');
  myPostsLink.hidden = true;
  if (location.pathname === '/my-posts.html') myPostsLink.setAttribute('aria-current', 'page');
  const billingLink = addMenuItem(panel, 'a', 'account-menu-item', 'Billing', '/billing.html');
  if (location.pathname === '/billing.html') billingLink.setAttribute('aria-current', 'page');
  const communityLink = addMenuItem(panel, 'a', 'account-menu-item', 'Community', '/community.html');
  if (location.pathname === '/community.html') communityLink.setAttribute('aria-current', 'page');
  const about = addMenuItem(panel, 'a', 'account-menu-item', 'About', '/about.html');

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
  menu.append(summary, panel);
  nav.append(menu);

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

  return { menu, summary, avatar, largeAvatar, name, email, about, billingLink, cloudLink, myPostsLink };
}

const accountMenu = createAccountMenu();

function updateProBadge(entitlement) {
  const hasPro = canUseFeature(FEATURE_IDS.ALL_TEMPLATES, entitlement);
  if (proBadge) proBadge.hidden = !hasPro;
  document.title = hasPro ? `${originalTitle} | Pro` : originalTitle;
}

async function refreshProBadge(user) {
  const requestId = ++entitlementRequest;
  currentUser = user;
  if (!user) {
    updateProBadge(null);
    return;
  }

  try {
    const config = await loadBillingConfig();
    const entitlement = config.entitlementEnabled ? await loadBillingEntitlement(user) : null;
    if (requestId === entitlementRequest) updateProBadge(entitlement);
  } catch (error) {
    if (requestId === entitlementRequest) updateProBadge(null);
    console.error('Could not load the account Pro status.', error);
  }
}

function updateAuthControls(user, error) {
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
      accountMenu.name.textContent = 'Guest';
      accountMenu.email.textContent = '';
      accountMenu.avatar.textContent = 'G';
      accountMenu.largeAvatar.textContent = 'G';
      accountMenu.summary.setAttribute('aria-label', 'Account menu');
      accountMenu.myPostsLink.hidden = true;
      accountMenu.cloudLink.hidden = true;
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
    accountMenu.cloudLink.hidden = !user;
    accountMenu.myPostsLink.hidden = !user;
    if (user) {
      const accountName = user.displayName?.trim() || user.email?.split('@')[0] || 'Google user';
      const initial = Array.from(accountName)[0]?.toLocaleUpperCase() || 'U';
      accountMenu.avatar.textContent = initial;
      accountMenu.largeAvatar.textContent = initial;
      accountMenu.name.textContent = accountName;
      accountMenu.email.textContent = user.email || '';
      accountMenu.summary.setAttribute('aria-label', `Account menu for ${accountName}`);
      if (location.pathname === '/about.html') accountMenu.about.setAttribute('aria-current', 'page');
      else accountMenu.about.removeAttribute('aria-current');
      if (location.pathname === '/billing.html') accountMenu.billingLink.setAttribute('aria-current', 'page');
      else accountMenu.billingLink.removeAttribute('aria-current');
      if (location.pathname === '/my-posts.html') accountMenu.myPostsLink.setAttribute('aria-current', 'page');
      else accountMenu.myPostsLink.removeAttribute('aria-current');
    } else {
      accountMenu.name.textContent = 'Guest';
      accountMenu.email.textContent = '';
      accountMenu.avatar.textContent = 'G';
      accountMenu.largeAvatar.textContent = 'G';
      accountMenu.summary.setAttribute('aria-label', 'Account menu');
      accountMenu.myPostsLink.hidden = true;
    }
  }
}

signInButton?.addEventListener('click', async () => {
  try {
    await signInWithGoogle();
  } catch (error) {
    console.error('Google sign-in failed.', error);
    if (status) {
      status.textContent = googleSignInErrorMessage(error);
      status.classList.add('auth-error');
    }
  }
});

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
    await signOutUser();
    window.location.assign('/home.html');
  } catch (error) {
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
