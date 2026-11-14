import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAccountPhotoUrl, getAccountPhotoUrls, setAccountAvatar } from '../frontend/src/account-avatar.js';
import { formatNationalPhoneNumber, formatPhoneInput, getDefaultPhoneCountry, getPhoneCountryLabel, getPhoneCountryOptions, parseAccountPhoneNumber, splitAccountPhoneNumber } from '../frontend/src/phone-number.js';
import viteConfigDefault from '../vite.config.js';

const page = readFileSync(new URL('../frontend/my-account.html', import.meta.url), 'utf8');
const authNavigation = readFileSync(new URL('../frontend/src/auth-nav.js', import.meta.url), 'utf8');
const aboutStyles = readFileSync(new URL('../frontend/src/about.css', import.meta.url), 'utf8');
const myAccountStyles = readFileSync(new URL('../frontend/src/my-account.css', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../frontend/editor.html', import.meta.url), 'utf8');
const aboutPage = readFileSync(new URL('../frontend/about.html', import.meta.url), 'utf8');
const supportPage = readFileSync(new URL('../frontend/support.html', import.meta.url), 'utf8');
const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
const vite = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');

test('my account is available from the account menu on shared pages and in the editor', () => {
  assert.match(authNavigation, /'My account', '\/my-account\.html'/);
  assert.match(authNavigation, /accountLink\.hidden = true/);
  assert.match(authNavigation, /accountMenu\.accountLink\.hidden = true/);
  assert.match(authNavigation, /accountMenu\.accountLink\.hidden = false/);
  const accountLink = editor.indexOf('<a class="account-menu-item" id="myAccountLink" href="/my-account.html" hidden>My account</a>');
  const firstFollowingMenuLink = editor.indexOf('<button class="account-menu-item" id="cloudResumesBtn"', accountLink);
  assert.ok(accountLink >= 0 && firstFollowingMenuLink > accountLink, 'My account should be the first Editor account-menu link');
  assert.match(editor, /id="myAccountLink" href="\/my-account\.html" hidden/);
  assert.ok(
    authNavigation.indexOf("'My account', '/my-account.html'") < authNavigation.indexOf("'My posts', '/my-posts.html'"),
    'My account should be the first shared account-menu link'
  );
  assert.match(editor, /href="\/about\.html">About<\/a>\s*<a class="account-menu-item" href="\/support\.html">Support<\/a>/);
  assert.match(authNavigation, /const about = addMenuItem\(panel, 'a', 'account-menu-item', 'About', '\/about\.html'\);\s*const supportLink = addMenuItem\(panel, 'a', 'account-menu-item', 'Support', '\/support\.html'\)/);
  assert.match(readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8'), /\$\('myAccountLink'\)\.hidden=!user/);
  assert.match(vite, /myAccount: fileURLToPath\(new URL\('\.\/frontend\/my-account\.html'/);
});

test('guest account menu offers Google sign-in instead of a Guest profile', () => {
  assert.match(authNavigation, /account-menu-signin', 'Sign in with Google'/);
  assert.match(authNavigation, /accountMenu\.profile\.hidden = !user/);
  assert.match(authNavigation, /accountMenu\.menuSignInButton\.hidden = Boolean\(user\)/);
  assert.match(authNavigation, /accountMenu\?\.menuSignInButton\.addEventListener\('click', handleGoogleSignIn\)/);
});

test('shared auth controls stay hidden until Firebase restores the account state', () => {
  assert.match(aboutStyles, /body:not\(\.auth-state-ready\) \.auth-actions \[data-auth-sign-in\],body:not\(\.auth-state-ready\) \.site-account-menu:not\(\[data-auth-shell-visible\]\)\{visibility:hidden\}/);
  assert.match(authNavigation, /function updateAuthControls\(user, error\)\s*\{\s*document\.body\.classList\.add\('auth-state-ready'\)/);
});

test('cached account avatar is visible during auth restore without revealing guest controls', () => {
  assert.match(page, /<details class="account-menu site-account-menu" data-account-menu-shell>[\s\S]*?localStorage\.getItem\('resumeout:session-cache:v1:account-avatar-hint'\)[\s\S]*?menu\.dataset\.authShellVisible = 'true'/);
  assert.match(authNavigation, /const menu = nav\.querySelector\('\[data-account-menu-shell\]'\) \|\| document\.createElement\('details'\)/);
  assert.match(authNavigation, /document\.body\.classList\.remove\('account-avatar-cached'\)/);
  assert.match(aboutStyles, /body:not\(\.auth-state-ready\) \.site-account-menu:not\(\[data-auth-shell-visible\]\)\{visibility:hidden\}/);
  const editorStyles = readFileSync(new URL('../frontend/src/style.css', import.meta.url), 'utf8');
  assert.match(editorStyles, /auth-state-pending #accountMenu:not\(\[data-auth-shell-visible\]\)/);
});

test('all pages hydrate the account icon from cache before auth modules execute', () => {
  const viteConfigSource = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.match(viteConfigSource, /function cachedAccountAvatarPlugin\(\)/);
  const transform = viteConfigDefault.plugins.find(plugin => plugin.name === 'cached-account-avatar').transformIndexHtml;
  const transformedPage = transform(aboutPage);
  const transformedAccountPage = transform(page);
  const transformedEditor = transform(editor);
  assert.match(transformedPage, /data-account-menu-shell/);
  assert.match(transformedPage, /menu\.dataset\.authShellVisible = 'true'/);
  assert.ok(transformedPage.indexOf('data-account-menu-shell') < transformedPage.indexOf('src="/src/auth-nav.js"'));
  assert.match(transformedAccountPage, /data-account-menu-shell/);
  assert.match(transformedEditor, /menu\.dataset\.authShellVisible = 'true'/);
  assert.ok(transformedEditor.indexOf('id="accountMenu"') < transformedEditor.indexOf('menu.dataset.authShellVisible'));
});

test('cached Pro badge stays visible for the matching account during auth and entitlement refresh', () => {
  assert.match(authNavigation, /const initialProBadgeHint = getCachedProBadgeHint\(\);[\s\S]*?proBadge\.hidden = false/);
  assert.match(authNavigation, /hintMatchesUser = hint && \([\s\S]*?currentUser\?\.uid === hint\.uid/);
  assert.match(authNavigation, /updateProBadge\(null\);[\s\S]*?loadBillingEntitlement\(user, \{ forceRefresh: true \}\)/);
  assert.match(authNavigation, /clearBillingEntitlementCache\(user\);\s*updateProBadge\(null\)/);
  assert.doesNotMatch(authNavigation, /catch \(error\) \{\s*if \(requestId === entitlementRequest\) \{\s*clearCachedProBadgeHint\(user\.uid\)/);
  const editorSource = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(editorSource, /updateProLabel\(\);[\s\S]*?async function refreshEditorBillingStatus/);
  assert.match(editorSource, /canUseFeature\(FEATURE_IDS\.ALL_TEMPLATES,verifiedEntitlement\)\|\|cachedBadgeIsCurrent/);
  assert.match(editorSource, /const cachedBadgeIsCurrent=\(proBadgeHint\?\.lifetime===true\|\|proBadgeHint\?\.validUntil>Date\.now\(\)\)&&\(!authStateResolved\|\|cloudUser\?\.uid===proBadgeHint\.uid\)/);
  assert.match(editorSource, /verifiedEntitlement=config\.entitlementEnabled\?await loadBillingEntitlement\(user,\{forceRefresh:true\}\):null/);
  assert.match(editorSource, /verifiedEntitlement=null;\s*updateProLabel\(\);\s*renderTemplates\(\)/);
  assert.match(editorSource, /clearBillingEntitlementCache\(user\);\s*proBadgeHint=getCachedProBadgeHint\(\)/);
});

test('shared auth controls stay hidden until logout navigation completes', () => {
  assert.match(aboutStyles, /body\.auth-signout-pending \.auth-actions \[data-auth-sign-in\],body\.auth-signout-pending \.site-account-menu\{visibility:hidden\}/);
  assert.match(authNavigation, /document\.body\.classList\.add\('auth-signout-pending'\);\s*await signOutUser\(\);\s*window\.location\.assign\('\/home\.html'\)/);
  assert.match(authNavigation, /catch \(error\) \{\s*document\.body\.classList\.remove\('auth-signout-pending'\)/);
});

test('all shared-navigation pages use the same sign-out transition', () => {
  const pages = ['about', 'admin', 'billing', 'community', 'home', 'index', 'my-account', 'my-posts', 'pricing', 'privacy', 'refunds', 'resume-wizard', 'support', 'terms'];
  for (const page of pages) {
    const html = readFileSync(new URL(`../frontend/${page}.html`, import.meta.url), 'utf8');
    assert.match(html, /<body class="[^"]*about-page/, `${page} should use the shared page auth styles`);
    assert.match(html, /src="\/src\/auth-nav\.js"/, `${page} should use the shared auth and sign-out handler`);
  }
});

test('account avatars use the Google provider photo when the Firebase user photo is unavailable', () => {
  assert.equal(getAccountPhotoUrl({
    photoURL: '',
    providerData: [{ providerId: 'google.com', photoURL: 'https://google.test/profile.png' }]
  }), 'https://google.test/profile.png');
  assert.deepEqual(getAccountPhotoUrls({
    photoURL: 'https://firebase.test/profile.png',
    providerData: [
      { providerId: 'google.com', photoURL: 'https://google.test/profile.png' },
      { providerId: 'other.com', photoURL: 'https://other.test/profile.png' }
    ]
  }, 'data:image/jpeg;base64,abc'), [
    'data:image/jpeg;base64,abc',
    'https://google.test/profile.png',
    'https://firebase.test/profile.png',
    'https://other.test/profile.png'
  ]);
  assert.equal(getAccountPhotoUrl({
    photoURL: 'https://firebase.test/profile.png',
    providerData: [{ providerId: 'google.com', photoURL: 'https://google.test/profile.png' }]
  }), 'https://google.test/profile.png');
  assert.match(authNavigation, /getAccountPhotoUrls\(user, cachedPhoto \?\? ''\)/);
  assert.match(readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8'), /getAccountPhotoUrls\(user,cachedPhoto\?\?'\'\)/);
});

test('setting the same account avatar twice keeps the existing image element', () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const attributes = new Map();
  const image = {
    addEventListener() {},
    getAttribute: name => attributes.get(name) || null,
    set src(value) { attributes.set('src', value); }
  };
  let replacementCount = 0;
  const children = [];
  globalThis.document = { createElement: () => image };
  const avatar = {
    querySelector: () => children[0] || null,
    replaceChildren(...nextChildren) {
      replacementCount++;
      children.splice(0, children.length, ...nextChildren);
    },
    append(child) { children.push(child); },
    set textContent(value) { this.text = value; }
  };
  try {
    setAccountAvatar(avatar, 'V', 'data:image/jpeg;base64,avatar');
    setAccountAvatar(avatar, 'V', 'data:image/jpeg;base64,avatar');
    assert.equal(replacementCount, 1);
    assert.equal(children[0], image);
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  }
});

test('shared pages and editor render cached account photos before fetching profile data', () => {
  const editorSource = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(authNavigation, /const initialAccountAvatar = getCachedAccountAvatarHint\(\);[\s\S]*?setAccountAvatar\(accountMenu\.avatar, 'U', initialAccountAvatar\.photoDataUrl\)/);
  assert.match(editorSource, /const initialAccountAvatarHint=getCachedAccountAvatarHint\(\);[\s\S]*?setAccountAvatar\(initialAvatar,'U',initialAccountAvatarHint\.photoDataUrl\)/);
  assert.match(authNavigation, /const cachedPhoto = getCachedAccountPhoto\(accountUid\);[\s\S]*?const photos = getAccountPhotoUrls\(user, cachedPhoto \?\? ''\);[\s\S]*?if \(cachedPhoto === null && location\.pathname !== '\/my-account\.html'\)/);
  assert.match(editorSource, /const cachedPhoto=getCachedAccountPhoto\(accountUid\);[\s\S]*?const photos=getAccountPhotoUrls\(user,cachedPhoto\?\?'\'\);[\s\S]*?if\(cachedPhoto===null\)/);
});

test('auth refresh updates profile labels without clearing the existing profile image', () => {
  const editorSource = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(authNavigation, /accountMenu\.(?:avatar|largeAvatar)\.textContent = initial/);
  assert.doesNotMatch(editorSource, /\$\('(?:accountAvatar|accountAvatarLarge)'\)\.textContent=initial/);
  assert.match(editorSource, /const cachedPhoto=getCachedAccountPhoto\(user\.uid\);\s*const photos=getAccountPhotoUrls\(user,cachedPhoto\?\?'\'\);\s*setAccountAvatar\(\$\('accountAvatar'\),initial,photos\)/);
});

test('account page exposes editable name and mobile fields with a read-only email', () => {
  assert.match(page, /id="accountName"[^>]*type="text"[^>]*required/);
  assert.match(page, /id="accountEmail"[^>]*type="email"[^>]*readonly/);
  assert.match(page, /id="accountCountry"[^>]*autocomplete="country"[^>]*aria-label="Country and calling code"/);
  assert.match(page, /id="accountMobile"[^>]*type="tel"[^>]*autocomplete="tel-national"/);
  assert.match(page, /international calling code/);
  assert.match(page, /id="accountPhoto"[^>]*type="file"[^>]*accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(page, /id="accountPhotoPreview"/);
  assert.match(page, /id="saveAccount"[^>]*type="submit"/);
  assert.ok(page.indexOf('id="accountMobile"') < page.indexOf('id="accountReferralPanel"'));
  assert.ok(page.indexOf('id="accountReferralPanel"') < page.indexOf('id="saveAccount"'));
  assert.match(page, /id="saveAccount"[^>]*form="accountForm"/);
  assert.match(page, /Sign in with Google/);
  assert.match(page, /id="accountReferralPanel"/);
  assert.match(page, /id="accountReferralCode"[^>]*maxlength="40"/);
  assert.match(page, /within 30 days of creating your account/);
  const accountClient = readFileSync(new URL('../frontend/src/my-account.js', import.meta.url), 'utf8');
  assert.match(accountClient, /\/api\/referrals\/claim-status/);
  assert.match(accountClient, /\/api\/referrals\/register/);
  assert.match(accountClient, /const pendingCode = getPendingReferralCode\(\);[\s\S]*?referralCodeInput\.value = pendingCode/);
  assert.match(accountClient, /Your referral link code is ready/);
  assert.match(accountClient, /function clearReferralCodeFromUrl\(\)/);
  assert.match(authNavigation, /if \(user && !error\) void processReferralRegistration\(user\)/);
  assert.match(authNavigation, /if \(getPendingReferralCode\(\)\) return/);
  const firebaseCloud = readFileSync(new URL('../frontend/src/firebase-cloud.js', import.meta.url), 'utf8');
  assert.match(firebaseCloud, /navigate\(`\/my-account\.html\$\{referralQuery\}`\)/);
  assert.ok(myAccountStyles.includes('grid-template-columns: max-content minmax(0, 1fr);'));
  assert.match(myAccountStyles, /\.account-referral-code\[hidden\][\s\S]*display: none !important/);
  assert.ok(readFileSync(new URL('../frontend/src/my-account.js', import.meta.url), 'utf8').includes('measureContext.measureText(selectedLabel).width + 48'));
});

test('account phone selection formats and saves country-aware international numbers', () => {
  assert.equal(getDefaultPhoneCountry('en-IN'), 'IN');
  assert.ok(getPhoneCountryOptions('en').some(option => option.country === 'US' && option.callingCode === '1'));
  assert.equal(getPhoneCountryLabel('US', '1'), 'US +1');
  assert.equal(formatNationalPhoneNumber('4155550134', 'US'), '(415) 555-0134');
  assert.deepEqual(formatPhoneInput('+14155550134', 'IN'), {
    country: 'US',
    value: '(415) 555-0134'
  });
  assert.equal(formatPhoneInput('+', 'IN').country, 'IN');
  assert.equal(parseAccountPhoneNumber('(415) 555-0134', 'US').number, '+14155550134');
  assert.equal(parseAccountPhoneNumber('020 7946 0018', 'GB').number, '+442079460018');
  assert.deepEqual(splitAccountPhoneNumber('+14155550134', 'IN'), {
    country: 'US',
    nationalNumber: '(415) 555-0134'
  });
  assert.throws(() => parseAccountPhoneNumber('123', 'US'), /valid phone number for the selected country/);
});

test('account profile rules scope mobile data to its owner and reject extra fields', () => {
  assert.match(rules, /match \/users\/\{userId\}\/profile\/account/);
  assert.match(rules, /allow get: if request\.auth != null && request\.auth\.uid == userId/);
  assert.match(rules, /keys\(\)\.hasOnly\(\['mobileNumber', 'photoDataUrl', 'highestEducation', 'company', 'designation', 'updatedAt'\]\)/);
  assert.match(rules, /highestEducation\.size\(\) <= 100/);
  assert.match(rules, /company\.size\(\) <= 100/);
  assert.match(rules, /designation\.size\(\) <= 100/);
  assert.match(rules, /photoDataUrl\.size\(\) <= 140000/);
  assert.match(rules, /allow delete: if false/);
});

test('my account exposes highest education, company, and designation inputs', () => {
  assert.match(page, /id="accountHighestEducation" name="highestEducation"/);
  assert.match(page, /id="accountCompany" name="company"/);
  assert.match(page, /id="accountDesignation" name="designation"/);
});

test('About page omits personal phone, LinkedIn, and company website details', () => {
  // assert.doesNotMatch(aboutPage, /8800640825|linkedin\.com\/in\/vimaurya|mvtechnology-games\.onrender\.com/);
});

test('Support email stays on one line', () => {
  assert.match(supportPage, /class="about-page support-page site-mobile-header"/);
  assert.match(aboutStyles, /\.support-page \.contact-list\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(aboutStyles, /\.support-page \.contact-list dd,\.support-page \.contact-list a\{white-space:nowrap;overflow-wrap:normal\}/);
  assert.match(aboutStyles, /\.support-page \.contact-list dd\{font-size:clamp\(14px,2vw,18px\)\}/);
});
