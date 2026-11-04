import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  canUseFeature,
  FEATURE_IDS,
  isProTemplate,
  PLAN_CONFIG,
  PRICING_FEATURES,
  shouldPromptForJobDescriptionAtsUpgrade,
  TEMPLATE_IDS
} from '../frontend/src/plan-access.js';
import { formatCurrencyPrice, preferredPricingCurrency } from '../frontend/src/pricing-currency.js';

test('templates are allocated without overlap and match the published plan counts', () => {
  const templateRoot = new URL('../Templates/', import.meta.url);
  const templateModules = readdirSync(templateRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const source = readFileSync(new URL(`${entry.name}/template.js`, templateRoot), 'utf8');
      return {
        id: source.match(/id:\s*'([^']+)'/)?.[1],
        hasStyles: existsSync(new URL(`${entry.name}/style.css`, templateRoot))
      };
    });
  const templates = templateModules.map(template => template.id).filter(Boolean);
  const registry = readFileSync(new URL('../Templates/index.js', import.meta.url), 'utf8');
  assert.equal(TEMPLATE_IDS.FREE.length, 6);
  assert.equal(TEMPLATE_IDS.PRO.length, 16);
  assert.equal(new Set([...TEMPLATE_IDS.FREE, ...TEMPLATE_IDS.PRO]).size, 22);
  assert.equal(templates.length, 25);
  assert.equal(new Set(templates).size, 25);
  assert.equal(templateModules.every(template => template.hasStyles), true);
  assert.equal((registry.match(/^import .* from '\.\/[^']+\/template\.js';$/gm) || []).length, 25);
  assert.match(registry, /export const templateDefs = Object\.freeze/);
  assert.equal(PRICING_FEATURES.find(feature => feature.label === 'Resume templates')?.pro, 'All 25 templates');
  assert.equal(TEMPLATE_IDS.FREE.some(isProTemplate), false);
  assert.equal(TEMPLATE_IDS.PRO.every(isProTemplate), true);
});

test('new resume templates stay behind existing Pro entitlement controls', () => {
  for (const templateId of [
    'interio-designer',
    'profile-split',
    'peach-mint',
    'teal-modern',
    'brian-baxter'
  ]) {
    assert.equal(isProTemplate(templateId), true);
  }
});

test('new resume templates have dedicated editor markup and styles', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  for (const [templateId, styleName, markupClass] of [
    ['interio-designer', 'layout-interio-designer', 'interio-layout'],
    ['profile-split', 'layout-profile-split', null],
    ['peach-mint', 'layout-peach-mint', 'pm-sheet'],
    ['teal-modern', 'layout-teal-modern', 'tr-sheet'],
    ['brian-baxter', 'layout-brian-baxter', 'br-sheet']
  ]) {
    const templateDirectory = new URL(`../Templates/${templateId}/`, import.meta.url);
    if (markupClass) {
      assert.match(source, new RegExp(`tmpl\\.id==='${templateId}'`));
      assert.match(source, new RegExp(`class="sheet-inner ${markupClass}"`));
    }
    assert.match(readFileSync(new URL('style.css', templateDirectory), 'utf8'), new RegExp(`\\.${styleName}`));
  }
});

test('homepage demo uses the animated editor walkthrough on both landing pages', () => {
  for (const page of ['home.html', 'index.html']) {
    const html = readFileSync(new URL(`../frontend/${page}`, import.meta.url), 'utf8');
    assert.match(html, /src="\/images\/homepage-demo\.svg"/);
    assert.match(html, /Cursor-guided preview of the resume editor/);
  }
  assert.match(readFileSync(new URL('../frontend/public/images/homepage-demo.svg', import.meta.url), 'utf8'), /resume editor walkthrough/);
});

test('essential Free features are included and future Pro features remain unavailable', () => {
  for (const label of [
    'Resume editor',
    'Standard PDF export',
    'Resume-only ATS checks',
    'Basic cover-letter tools',
    'JSON import and export',
    'Browser autosave'
  ]) {
    assert.equal(PRICING_FEATURES.find(feature => feature.label === label)?.free, 'Included');
  }
  assert.equal(PRICING_FEATURES.find(feature => feature.label === 'Tailored resume versions')?.pro, 'Not available yet');
});

test('pro features reject missing, client-claimed, inactive, expired, or incomplete entitlements', () => {
  const valid = {
    planId: 'pro',
    status: 'active',
    source: 'server-verified',
    validUntil: 2_000
  };

  assert.equal(canUseFeature(FEATURE_IDS.ALL_TEMPLATES, null, 1_000), false);
  assert.equal(canUseFeature(FEATURE_IDS.ALL_TEMPLATES, { ...valid, source: 'client' }, 1_000), false);
  assert.equal(canUseFeature(FEATURE_IDS.ALL_TEMPLATES, { ...valid, status: 'inactive' }, 1_000), false);
  assert.equal(canUseFeature(FEATURE_IDS.ALL_TEMPLATES, { ...valid, validUntil: 1_000 }, 1_000), false);
  assert.equal(canUseFeature(FEATURE_IDS.ALL_TEMPLATES, { ...valid, validUntil: null }, 1_000), false);
  assert.equal(canUseFeature('unknown-feature', valid, 1_000), false);
});

test('only recognized Pro features accept an active unexpired verified entitlement', () => {
  const entitlement = {
    planId: 'pro',
    status: 'active',
    source: 'server-verified',
    validUntil: 2_000
  };

  assert.equal(canUseFeature(FEATURE_IDS.ALL_TEMPLATES, entitlement, 1_000), true);
  assert.equal(canUseFeature(FEATURE_IDS.JOB_DESCRIPTION_ATS, entitlement, 1_000), true);
});

test('job-description ATS attempts prompt Free users to upgrade but not Pro users', () => {
  const activePro = {
    planId: 'pro',
    status: 'active',
    source: 'server-verified',
    validUntil: 2_000
  };
  assert.equal(shouldPromptForJobDescriptionAtsUpgrade('', null), false);
  assert.equal(shouldPromptForJobDescriptionAtsUpgrade('  \n ', null), false);
  assert.equal(shouldPromptForJobDescriptionAtsUpgrade('Frontend developer role', null), true);
  assert.equal(shouldPromptForJobDescriptionAtsUpgrade('Another job description', {
    ...activePro,
    validUntil: Number.MAX_SAFE_INTEGER
  }), false);
});

test('job descriptions are analyzed only after an explicit Run checks action', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(source, /function openAts\(\)\s*\{[^}]*\}/);
  assert.doesNotMatch(source.match(/function openAts\(\)\s*\{[^}]*\}/)?.[0] || '', /runAtsChecks/);
  assert.match(source, /\$\('runAtsBtn'\)\.addEventListener\('click',\(\)=>runAtsChecks\(\)\)/);
  assert.doesNotMatch(source, /\$\('jobDescription'\)\.addEventListener\('input'/);
  assert.doesNotMatch(source, /atsModalBg'\)\.classList\.contains\('show'\)\)runAtsChecks/);
  assert.match(source, /if\(lockedJobMatch&&promptUpgrade\)showUpgrade\('job-description-ats'/);
});

test('hidden sign-out controls stay hidden in both account-menu styles', () => {
  for (const stylesheet of ['style.css', 'about.css']) {
    const styles = readFileSync(new URL(`../frontend/src/${stylesheet}`, import.meta.url), 'utf8');
    assert.match(styles, /\.account-menu-item\[hidden\]\{display:none!important\}/);
  }
});

test('shared pages and editor confirm sign-out before redirecting home', () => {
  const sharedNavigation = readFileSync(new URL('../frontend/src/auth-nav.js', import.meta.url), 'utf8');
  const editor = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(sharedNavigation, /signOutButton\?\.addEventListener\('click', async \(\) => \{[\s\S]*?await confirmModern\([\s\S]*?await signOutUser\(\)/);
  assert.match(editor, /\$\('googleSignOutBtn'\)\.addEventListener\('click',async\(\)=>\{[\s\S]*?await confirmModern\([\s\S]*?await signOutUser\(\)/);
  assert.match(sharedNavigation, /await signOutUser\(\);\s*window\.location\.assign\('\/home\.html'\)/);
  assert.match(editor, /await signOutUser\(\);\s*window\.location\.assign\('\/home\.html'\)/);
});

test('site alerts and confirmations use the shared modern modal instead of browser dialogs', () => {
  const sourceDirectory = new URL('../frontend/src/', import.meta.url);
  const scripts = readdirSync(sourceDirectory).filter(file => file.endsWith('.js'));
  for (const script of scripts) {
    assert.doesNotMatch(readFileSync(new URL(script, sourceDirectory), 'utf8'), /\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/, script);
  }
  for (const script of ['admin.js', 'billing.js', 'community.js', 'main.js']) {
    assert.match(readFileSync(new URL(script, sourceDirectory), 'utf8'), /from '\.\/modern-modal\.js'/, script);
  }
  assert.match(readFileSync(new URL('modern-modal.js', sourceDirectory), 'utf8'), /import '\.\/modern-modal\.css'/);
  assert.match(readFileSync(new URL('modern-modal.css', sourceDirectory), 'utf8'), /\.modern-modal-dialog\.is-danger/);
});

test('subscription management buttons are hidden unless the user is signed in', () => {
  const source = readFileSync(new URL('../frontend/src/billing.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../frontend/src/pricing.css', import.meta.url), 'utf8');
  assert.match(source, /cancelButton\.hidden\s*=\s*!user\s*\|\|/);
  assert.match(source, /yearlyButton\.hidden\s*=\s*!user\s*\|\|/);
  assert.match(styles, /\.billing-plan-actions \.btn\[hidden\]\{display:none!important\}/);
});

test('all site pages use the ResumeOut icon and styled text wordmark', () => {
  const pages = [
    'home.html', 'index.html', 'about.html', 'admin.html', 'billing.html',
    'editor.html', 'pricing.html', 'privacy.html', 'refunds.html', 'terms.html',
    'community.html', 'my-posts.html', 'resume-wizard.html'
  ];
  for (const page of pages) {
    const html = readFileSync(new URL(`../frontend/${page}`, import.meta.url), 'utf8');
    assert.match(html, /rel="icon"[^>]+resumeout-mark\.svg/, page);
    assert.match(html, /<img class="(?:about-logo|logo)" src="\/images\/resumeout-mark\.svg"/, page);
    assert.match(html, /class="brand-resume">Resume<\/span>/, page);
    assert.match(html, /class="brand-out">Out<\/span>/, page);
    assert.match(html, /class="brand-domain">\.com<\/span>/, page);
  }
  const editor = readFileSync(new URL('../frontend/editor.html', import.meta.url), 'utf8');
  assert.doesNotMatch(editor, /id="proBrandBadge"/);
  const styles = [
    readFileSync(new URL('../frontend/src/about.css', import.meta.url), 'utf8'),
    readFileSync(new URL('../frontend/src/style.css', import.meta.url), 'utf8')
  ].join('\n');
  assert.match(styles, /\.about-brand-name \.brand-out\{[^}]*background:linear-gradient/);
  assert.match(styles, /\.brand-name \.brand-out\{[^}]*background:linear-gradient/);
  assert.match(styles, /\.about-brand-name \.brand-out::after\{[^}]*content:""/);
  assert.match(styles, /\.brand-name \.brand-out::after\{[^}]*content:""/);
  assert.match(styles, /:root\[data-theme=light\] \.brand \.logo,:root\[data-theme=dark\] \.brand \.logo\{background:none;box-shadow:none\}/);
  const logo = readFileSync(new URL('../frontend/public/images/resumeout-mark.svg', import.meta.url), 'utf8');
  assert.match(logo, /<svg/);
  assert.match(logo, /linearGradient/);
  assert.match(logo, /#123FBA/);
});

test('monthly and yearly prices match the displayed INR subscriptions', () => {
  assert.equal(PLAN_CONFIG.pro.currency, 'INR');
  assert.deepEqual(PLAN_CONFIG.pro.monthly, { price: 99, interval: 'month' });
  assert.deepEqual(PLAN_CONFIG.pro.yearly, { price: 399, interval: 'year' });
  assert.equal(PLAN_CONFIG.pro.currencies.USD.monthly.price, 3.67);
  assert.equal(PLAN_CONFIG.pro.currencies.USD.yearly.price, 49.37);
  assert.equal(preferredPricingCurrency('en-IN'), 'INR');
  assert.equal(preferredPricingCurrency('en-US'), 'USD');
  assert.equal(preferredPricingCurrency('fr-FR'), 'USD');
  assert.equal(formatCurrencyPrice(3.67, 'USD', 'en-US'), '$3.67');
  assert.equal(formatCurrencyPrice(99, 'INR', 'en-IN'), '₹99');

  const pricingPage = readFileSync(new URL('../frontend/pricing.html', import.meta.url), 'utf8');
  assert.doesNotMatch(pricingPage, /pricingCurrency|pricing-currency-picker/);
  assert.match(pricingPage, /Loading price/);
  const adminPage = readFileSync(new URL('../frontend/admin.html', import.meta.url), 'utf8');
  assert.match(adminPage, /India · INR/);
  assert.match(adminPage, /International · USD/);
  assert.doesNotMatch(adminPage, /id="(?:monthly|yearly|usd-monthly|usd-yearly)-current-price"[^>]*readonly/);
});

test('Pro template preview offers PDF export without a template-application trial modal', () => {
  const html = readFileSync(new URL('../frontend/editor.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(html, /id="previewUpgrade"/);
  assert.doesNotMatch(html, /proTemplateTrialModalBg|applyProTemplate/);
  assert.match(html, /id="templatePreviewModalBg"/);
  assert.match(html, /id="templatePreviewAllowance"/);
  assert.match(html, /id="exportProTemplatePreview"[^>]*disabled/);
  assert.doesNotMatch(source, /template-preview-btn|data-template-preview/);
});

test('Free users preview Pro templates and can render a PDF without applying the template', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(source, /pendingProTemplate=null;\s*openTemplatePreview\(templateId\)/);
  assert.match(source, /async function exportPDF\(templateId=null\)/);
  assert.match(source, /void exportPDF\(templateId\)/);
  assert.match(source, /consumeProTemplateDownload\(cloudUser\.uid\)/);
  assert.match(source, /You have used both free Pro-template PDF downloads\. Export is disabled/);
  assert.match(source, /of 2 free Pro PDF downloads remaining/);
  assert.match(source, /exportButton\.disabled=true/);
  assert.match(source, /sheet\.querySelectorAll\('\[contenteditable\]'\)\.forEach\(element=>\{[\s\S]*?removeAttribute\('contenteditable'\)/);
  assert.match(source, /if\(!cloudUser\)\{[\s\S]*?button\.disabled=true/);
  assert.match(source, /!cloudUser\|\|!Number\.isInteger\(proTemplateDownloadsRemaining\)\|\|proTemplateDownloadsRemaining<1/);
  assert.doesNotMatch(source, /applyPendingProTemplate|showProTemplateTrial/);
});

test('upgrade modal actions wrap instead of overlapping at narrow widths', () => {
  const styles = readFileSync(new URL('../frontend/src/style.css', import.meta.url), 'utf8');
  assert.match(styles, /\.upgrade-modal \.modal-actions[^}]*display:grid/);
  assert.match(styles, /@media\(max-width:560px\)[^{]*\{[^}]*grid-template-columns:1fr/s);
});

test('photo templates show an accessible avatar placeholder when no photo is uploaded', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../frontend/src/style.css', import.meta.url), 'utf8');
  assert.match(source, /const hasPhoto=!!tmpl\.photo/);
  assert.match(source, /photo-placeholder" role="img" aria-label="No profile photo uploaded"/);
  assert.match(styles, /\.photo-placeholder::before/);
  assert.match(styles, /\.photo-placeholder::after/);
});

test('flow pagination continues entry bullets without repeating the role header', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(source, /if\(!a\.continuation\)el\.innerHTML=/);
  assert.match(source, /const first=cont&&a\.k==='li'\?\{k:'entry',e:a\.e,continuation:true\}:a;/);
  assert.match(source, /if\(cont&&a\.k==='li'\)appendAtom\(placed\.shell,a,placed\.st,s\);/);
  assert.match(source, /addEventListener\('focusout',e=>\{[\s\S]*?recordHistory\(before\);saveLocal\(\);renderSheets\(\);/);
});

test('experience bullets split at the caret and keep focus for consecutive Enter presses', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(source, /const caret=Math\.min\(caretOffsetWithin\(el,true\),before\.length\),left=before\.slice\(0,caret\),right=before\.slice\(caret\+selectionLength\)/);
  assert.match(source, /details\.splice\(index,representedCount,left,right\)/);
  assert.match(source, /if\(!directEditSnapshots\.has\(el\)\)directEditSnapshots\.set\(el,deep\(state\)\)/);
  assert.match(source, /if\(editSnapshot\)directEditSnapshots\.set\(next,editSnapshot\)/);
  assert.match(source, /selection\?\.removeAllRanges\(\);selection\?\.addRange\(range\)/);
});

test('experience bullet Backspace and Delete merge adjacent points at line boundaries', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(source, /const caret=caretOffsetWithin\(el,true\),backward=e\.key==='Backspace',atBoundary=backward\?caret===0:caret===value\.length/);
  assert.match(source, /const rows=Array\.from\(document\.querySelectorAll\('#sheets \[data-entry-field="detail"\]'\)\)\.filter\(item=>item\.dataset\.sectionId===sectionId&&item\.dataset\.entry===entryIndex\)/);
  assert.match(source, /details\.splice\(priorIndex,count,joined\)/);
  assert.match(source, /itemIndex-count\+joinedCount/);
  assert.match(source, /if\(backward\)\{[\s\S]*?prior\.focus\(\)/);
});

test('experience deletion never selects an entire neighboring line or document', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(source, /const insideField=el\.contains\(selection\.anchorNode\)&&el\.contains\(selection\.focusNode\);[\s\S]*?if\(!insideField\)e\.preventDefault\(\);[\s\S]*?return;/);
  assert.match(source, /range\.collapse\(true\);selection\?\.removeAllRanges\(\);selection\?\.addRange\(range\)/);
  assert.doesNotMatch(source, /document\.execCommand\('selectAll'/);
});

test('experience content reflows to the next page while the user is typing', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(source, /function reflowOverflowingDetail\(el,force=false\)/);
  assert.match(source, /if\(!force&&el\.getBoundingClientRect\(\)\.bottom<=limit\+\.5\)return/);
  assert.match(source, /try\{renderSheets\(\)\}finally\{reflowingDetail=false\}/);
  assert.match(source, /const moved=Array\.from\(document\.querySelectorAll\('#sheets \[data-entry-field="detail"\]'\)\)/);
  assert.match(source, /reflowOverflowingDetail\(el,replacements\.length>1\)/);
});

test('billing and Plans pages expose voucher entry and label sample codes as examples', () => {
  const html = readFileSync(new URL('../frontend/billing.html', import.meta.url), 'utf8');
  const pricingHtml = readFileSync(new URL('../frontend/pricing.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../frontend/src/billing.js', import.meta.url), 'utf8');
  const pricingSource = readFileSync(new URL('../frontend/src/pricing.js', import.meta.url), 'utf8');
  assert.match(html, /id="voucherForm"/);
  assert.match(html, /id="voucherSection"[^>]*aria-labelledby="voucherTitle">/);
  assert.match(html, /Example formats only — these are not valid codes/);
  assert.match(source, /redeemBillingVoucher\(currentUser, code\)/);
  assert.match(source, /const voucherUnavailable = billingConfig\?\.entitlementEnabled === false/);
  assert.match(source, /const disabled = signInRequired \|\| voucherUnavailable/);
  assert.match(source, /Voucher availability could not be checked\. Enter a code and the server will verify it/);
  assert.match(source, /a valid voucher will start after your current access ends/i);
  assert.match(source, /result\.queued/);
  assert.match(source, /billingConfig\?\.entitlementEnabled === false/);
  assert.match(pricingHtml, /id="pricingVoucherForm"/);
  assert.match(pricingHtml, /id="pricingVoucherSection"[^>]*aria-labelledby="pricingVoucherTitle">/);
  assert.match(pricingHtml, /id="pricingVoucherCode"/);
  assert.match(pricingSource, /redeemBillingVoucher\(currentUser, code\)/);
  assert.match(pricingSource, /result\.queued/);
});

test('Firestore rules restrict the lifetime Pro-template trial to two owner-only increments', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  assert.match(rules, /match \/users\/\{userId\}\/trial\/proTemplateDownloads/);
  assert.match(rules, /request\.auth\.uid == userId/);
  assert.match(rules, /request\.resource\.data\.count == 1/);
  assert.match(rules, /request\.resource\.data\.count == resource\.data\.count \+ 1/);
  assert.match(rules, /request\.resource\.data\.count <= 2/);
  assert.match(rules, /allow delete: if false/);
});

test('Firestore rules scope the last-worked resume preference to its signed-in account', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  assert.match(rules, /match \/users\/\{userId\}\/preferences\/resumeEditor/);
  assert.match(rules, /allow get: if request\.auth != null && request\.auth\.uid == userId/);
  assert.match(rules, /request\.resource\.data\.keys\(\)\.hasOnly\(\['lastWorkedResumeId'\]\)/);
  assert.match(rules, /request\.resource\.data\.lastWorkedResumeId is string/);
});
