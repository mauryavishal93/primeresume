import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAccountPhotoUrl, getAccountPhotoUrls } from '../frontend/src/account-avatar.js';

const page = readFileSync(new URL('../frontend/my-account.html', import.meta.url), 'utf8');
const authNavigation = readFileSync(new URL('../frontend/src/auth-nav.js', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../frontend/editor.html', import.meta.url), 'utf8');
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
  assert.match(authNavigation, /getAccountPhotoUrls\(user\)/);
  assert.match(readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8'), /getAccountPhotoUrls\(user\)/);
});

test('account page exposes editable name and mobile fields with a read-only email', () => {
  assert.match(page, /id="accountName"[^>]*type="text"[^>]*required/);
  assert.match(page, /id="accountEmail"[^>]*type="email"[^>]*readonly/);
  assert.match(page, /id="accountMobile"[^>]*type="tel"/);
  assert.match(page, /id="accountPhoto"[^>]*type="file"[^>]*accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(page, /id="accountPhotoPreview"/);
  assert.match(page, /id="saveAccount"[^>]*type="submit"/);
  assert.match(page, /Sign in with Google/);
});

test('account profile rules scope mobile data to its owner and reject extra fields', () => {
  assert.match(rules, /match \/users\/\{userId\}\/profile\/account/);
  assert.match(rules, /allow get: if request\.auth != null && request\.auth\.uid == userId/);
  assert.match(rules, /keys\(\)\.hasOnly\(\['mobileNumber', 'photoDataUrl', 'updatedAt'\]\)/);
  assert.match(rules, /photoDataUrl\.size\(\) <= 140000/);
  assert.match(rules, /allow delete: if false/);
});
