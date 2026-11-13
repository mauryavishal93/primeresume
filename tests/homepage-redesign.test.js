import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const homepageStyles = readFileSync(new URL('../frontend/src/homepage.css', import.meta.url), 'utf8');
const aboutStyles = readFileSync(new URL('../frontend/src/about.css', import.meta.url), 'utf8');
const homepageTemplates = readFileSync(new URL('../frontend/src/homepage-templates.js', import.meta.url), 'utf8');

test('homepage redesign sections and existing walkthrough stay consistent on both entry points', () => {
  for (const page of ['home.html', 'index.html']) {
    const html = readFileSync(new URL(`../frontend/${page}`, import.meta.url), 'utf8');

    assert.match(html, /<body class="about-page landing-page site-mobile-header">/);
    assert.match(html, /href="\/src\/homepage\.css"/);
    assert.match(html, /src="\/images\/homepage-demo\.svg"/);
    assert.match(html, /<script type="module" src="\/src\/homepage-templates\.js"><\/script>/);
    assert.match(html, /class="landing-template-grid" data-template-carousel/);
    assert.match(html, /<script type="module" src="\/src\/theme\.js"><\/script>/);
    assert.match(html, /<div class="hero-actions landing-hero-actions">\s*<a class="btn primary landing-create-btn" href="\/editor\.html">Create my free resume <span aria-hidden="true">→<\/span><\/a>\s*<a class="btn outline landing-explore-btn" href="#templates">Explore templates<\/a>\s*<\/div>\s*<a class="landing-import-link" href="\/editor\.html\?open=import">Already have a resume\? Import it<\/a>/);
    assert.match(html, /<a class="landing-scratch-cta" href="\/resume-wizard\.html">\s*<span class="landing-scratch-title">Build my resume from scratch <span aria-hidden="true">→<\/span><\/span>\s*<span class="landing-scratch-subtitle">Guided step-by-step resume creation<\/span>\s*<\/a>/);
    assert.match(html, /<a class="btn outline landing-import-button" href="\/editor\.html\?open=import"><svg class="landing-import-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4"\/><path d="m7 9 5-5 5 5"\/><path d="M4 15v3a2 2 0 0 0 2 2h14"\/><\/svg>Import resume<\/a>/);
    assert.match(html, /<div class="landing-header-actions">\s*<a class="btn outline" href="\/pricing\.html">Plans<\/a>\s*<a class="btn outline landing-support-link" href="\/support\.html">Support<\/a>\s*<a class="btn outline landing-import-button" href="\/editor\.html\?open=import">[\s\S]*?<\/a>\s*<a class="btn soft about-editor" href="\/editor\.html">Open editor<\/a>\s*<\/div>/);
    for (const section of ['templates', 'how-it-works', 'features', 'pricing', 'faq']) {
      assert.match(html, new RegExp(`id="${section}"`));
      assert.match(html, new RegExp(`href="#${section}">`));
    }
    for (const [id, name] of [['modern', 'Modern'], ['classic', 'Classic'], ['minimal', 'Minimal'], ['tech', 'Tech']]) {
      assert.match(html, new RegExp(`<a class="landing-template-card" href="/editor\\.html\\?template=${id}" aria-label="Use the ${name} resume template">[\\s\\S]*?<span class="landing-template-link">Use template →</span>[\\s\\S]*?<\\/a>`));
      const card = html.match(new RegExp(`<a class="landing-template-card" href="/editor\\.html\\?template=${id}"[\\s\\S]*?<\\/a>`))?.[0];
      assert.ok(card, `${name} template card should exist`);
      assert.match(card, new RegExp(`<div class="landing-resume-paper" data-layout="${id}">`));
      assert.match(card, /class="landing-resume-header"/);
      assert.match(card, /class="landing-resume-section"/);
      assert.match(card, /Jordan Taylor/);
    }
    const modernCard = html.match(/<a class="landing-template-card" href="\/editor\.html\?template=modern"[\s\S]*?<\/a>/)?.[0];
    assert.match(modernCard, /landing-resume-two-column/);
    assert.match(modernCard, /landing-resume-secondary/);
    assert.match(html, /<div class="hero-actions landing-pricing-actions">\s*<a class="btn primary" href="\/editor\.html">Start free<\/a>\s*<\/div>/);
    assert.match(html, /<div class="hero-actions landing-pricing-actions">\s*<a class="btn outline" href="\/pricing\.html">Compare all plans<\/a>\s*<\/div>/);
    assert.match(html, /href="\/community\.html">Community<\/a>/);
    assert.match(html, /<div class="landing-faq">[\s\S]*?<details>[\s\S]*?<summary>/);
  }
  assert.match(homepageStyles, /\.landing-header-actions\s*\{[\s\S]*?display:\s*flex;[\s\S]*?gap:\s*6px/);
  assert.match(aboutStyles, /@media\(max-width:640px\)\{[\s\S]*?\.about-header\{display:grid;grid-template-columns:minmax\(0,1fr\) 42px;grid-template-areas:"brand account" "nav nav";grid-template-rows:42px auto/);
  assert.match(aboutStyles, /\.about-nav\{grid-area:nav;display:flex;width:100%;min-width:0;flex-wrap:wrap;align-items:center;justify-content:flex-start;gap:6px;margin:0\}/);
  assert.match(aboutStyles, /\.about-nav>\.site-account-menu\{position:absolute;top:8px;right:12px;margin:0\}/);
  assert.match(aboutStyles, /\.landing-page \.about-nav\{display:grid;grid-template-columns:40px minmax\(0,auto\) minmax\(0,1fr\);grid-template-areas:"auth community actions"/);
  assert.match(aboutStyles, /\.landing-page \.about-nav>\.auth-actions \.google-signin\{width:40px;max-width:40px\}/);
  assert.match(aboutStyles, /\.about-nav \.google-signin \[data-auth-sign-in-label\]\{position:absolute;width:1px;height:1px/);
  assert.match(aboutStyles, /\.about-nav>a\[href="\/support\.html"\],\.about-nav>\.landing-header-actions \.landing-import-button,\.landing-page \.about-nav>\.landing-header-actions \.landing-support-link\{display:none\}/);
  assert.match(aboutStyles, /\.landing-page \.about-nav>\.landing-header-actions\{display:grid;grid-area:actions;grid-template-columns:repeat\(2,minmax\(0,1fr\)\);justify-self:stretch;flex:initial;width:100%;min-width:0;max-width:none;gap:6px\}/);
  assert.match(aboutStyles, /\.landing-page \.about-nav>\.landing-header-actions \.btn\{width:100%;min-width:0;min-height:40px;padding:6px 4px;font-size:11px\}/);
  assert.match(aboutStyles, /\.about-page:not\(\.landing-page\):not\(\.admin-page\) \.about-nav\{display:grid;grid-template-columns:40px minmax\(0,auto\) repeat\(2,minmax\(0,1fr\)\);grid-template-areas:"auth community plans editor"/);
  assert.match(aboutStyles, /\.about-page:not\(\.landing-page\):not\(\.admin-page\) \.about-nav>a\[href="\/community\.html"\]\{grid-area:community/);
  assert.match(aboutStyles, /\.about-page:not\(\.landing-page\):not\(\.admin-page\) \.about-nav>a\[href="\/pricing\.html"\]\{grid-area:plans/);
  assert.match(aboutStyles, /\.about-page:not\(\.landing-page\):not\(\.admin-page\) \.about-nav>\.about-editor\{grid-area:editor/);
  assert.match(aboutStyles, /body\.site-mobile-header:not\(\.admin-page\) \.about-nav\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\);grid-template-areas:"community plans editor" "auth theme \."/);
  assert.match(aboutStyles, /body\.site-mobile-header\.auth-user-signed-in:not\(\.admin-page\) \.about-nav\{grid-template-areas:"community plans editor"\}/);
  assert.match(aboutStyles, /body\.site-mobile-header:not\(\.admin-page\) \.about-nav \.google-signin::after\{content:"Google"/);
  for (const page of ['about', 'admin', 'billing', 'community', 'home', 'index', 'my-account', 'my-posts', 'pricing', 'privacy', 'refunds', 'resume-wizard', 'support', 'terms']) {
    const html = readFileSync(new URL(`../frontend/${page}.html`, import.meta.url), 'utf8');
    assert.match(html, /<header class="about-header"/, `${page} should use the shared responsive header`);
    assert.match(html, /src="\/src\/auth-nav\.js"/, `${page} should show the shared account menu`);
  }
});

test('homepage footer Contact Us links to Support on both entry points', () => {
  for (const page of ['home.html', 'index.html']) {
    const html = readFileSync(new URL(`../frontend/${page}`, import.meta.url), 'utf8');
    assert.match(html, /<footer class="landing-footer">[\s\S]*?<a href="\/support\.html">Contact Us<\/a>/);
  }
});

test('home and Plans pages explain the Google sign-in Pro-template PDF allowance', () => {
  for (const page of ['home.html', 'index.html']) {
    const html = readFileSync(new URL(`../frontend/${page}`, import.meta.url), 'utf8');
    assert.match(html, /Pro-template PDF downloads<\/span><span>2 after Google sign-in<\/span>/);
    assert.match(html, /Sign in with Google for first 2 free Pro-template PDF downloads per account/);
    assert.match(html, /Sign in with Google to get 2 lifetime downloads using Pro templates per account/);
  }
  const pricing = readFileSync(new URL('../frontend/pricing.html', import.meta.url), 'utf8');
  const features = readFileSync(new URL('../frontend/src/plan-access.js', import.meta.url), 'utf8');
  assert.match(pricing, /First 2 free Pro-template PDF downloads after Google sign-in, per account/);
  assert.match(features, /label: 'Pro-template PDF downloads', free: '2 lifetime after Google sign-in', pro: 'Unlimited'/);
});

test('homepage navigation links to Support beside Plans on both entry points', () => {
  for (const page of ['home.html', 'index.html']) {
    const html = readFileSync(new URL(`../frontend/${page}`, import.meta.url), 'utf8');
    assert.match(html, /href="\/pricing\.html">Plans<\/a>\s*<a class="btn outline landing-support-link" href="\/support\.html">Support<\/a>/);
  }
  assert.match(aboutStyles, /\.landing-page \.about-nav>\.landing-header-actions \.landing-support-link\{display:none\}/);
});

test('Community, Billing, and My posts pages link to Support beside Plans', () => {
  for (const page of ['community.html', 'billing.html', 'my-posts.html']) {
    const html = readFileSync(new URL(`../frontend/${page}`, import.meta.url), 'utf8');
    assert.match(html, /href="\/pricing\.html">Plans<\/a>\s*<a class="btn outline" href="\/support\.html">Support<\/a>/);
  }
});

test('editor applies homepage template links to the loaded resume and preserves free-template access', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(source, /requestedHomepageTemplateId=new URLSearchParams\(location\.search\)\.get\('template'\)/);
  assert.match(source, /item=>item\.id===requestedHomepageTemplateId&&TEMPLATE_IDS\.FREE\.includes\(item\.id\)/);
  assert.match(source, /state\.template=template\.id;\s*state\.layout=template\.layout;\s*state\.design\.accent=template\.accent/);
  assert.match(source, /cloudDraftDirty=applyHomepageTemplate\(\)/);
  assert.match(source, /params\.delete\('template'\)/);
  assert.match(source, /window\.history\.replaceState\(null,'',/);
});

test('homepage template carousel renders the catalog with actual template layouts, Free and Pro labels, and accessible controls', () => {
  assert.match(homepageTemplates, /import \{ templateDefs \} from '\.\.\/\.\.\/Templates\/index\.js'/);
  assert.match(homepageTemplates, /templateDefs\.map\(template =>/);
  assert.match(homepageTemplates, /class="sheet \$\{cls\} landing-resume-paper"/);
  assert.match(homepageTemplates, /template\.id === 'peach-mint'[\s\S]*?pm-sidebar/);
  assert.match(homepageTemplates, /template\.id === 'teal-modern'[\s\S]*?tr-header/);
  assert.match(homepageTemplates, /template\.id === 'interio-designer'[\s\S]*?interio-sidebar/);
  assert.match(homepageTemplates, /template\.id === 'brian-baxter'[\s\S]*?br-yellow-panel/);
  assert.match(homepageTemplates, /--mx:32px;--mt:32px;--mb:32px;--resume-size:18px;--resume-heading:22px/);
  assert.match(homepageTemplates, /landing-template-description">\$\{escapeHtml\(template\.sub\)\}/);
  assert.match(homepageTemplates, /isProTemplate\(template\.id\)/);
  assert.match(homepageTemplates, /Show previous templates/);
  assert.match(homepageTemplates, /Show next templates/);
  assert.match(homepageTemplates, /prefers-reduced-motion: reduce/);
  assert.match(homepageTemplates, /offset \+ visibleCount\(\)/);
  assert.match(homepageTemplates, /manualPauseUntil/);
  assert.match(homepageTemplates, /pointerenter/);
  assert.match(homepageTemplates, /focusin/);
});

test('homepage redesign follows the existing theme and adapts its content to mobile', () => {
  assert.match(homepageStyles, /\.landing-anchor-nav-wrap\s*\{[^}]*background: rgba\(7, 14, 23, \.92\)/);
  assert.match(homepageStyles, /\.landing-anchor-nav a\s*\{[^}]*color: #d3deec/);
  assert.match(homepageStyles, /:root\[data-theme="light"\] \.landing-anchor-nav a\s*\{[^}]*color: #4a5568/);
  assert.match(homepageStyles, /:root\[data-theme="light"\] \.landing-page/);
  assert.match(homepageStyles, /\.landing-hero \.hero-actions \.landing-create-btn \{[\s\S]*min-height: 46px;[\s\S]*font-size: 15px/);
  assert.match(homepageStyles, /:root\[data-theme="light"\] \.landing-page \.landing-hero \.hero-actions \.landing-create-btn \{[\s\S]*background: #b89456/);
  assert.match(homepageStyles, /\.landing-hero-actions \.landing-explore-btn[\s\S]*background: transparent/);
  assert.match(homepageStyles, /\.landing-scratch-cta \{[\s\S]*min-height: 96px/);
  assert.match(homepageStyles, /:root\[data-theme="light"\] \.landing-page \.landing-scratch-cta \{[\s\S]*#f4f0e7/);
  assert.match(homepageStyles, /@media \(max-width: 640px\)[\s\S]*\.landing-create-btn,[\s\S]*width: min\(100%, 260px\);[\s\S]*min-height: 44px/);
  assert.match(homepageStyles, /@media \(max-width: 640px\)[\s\S]*\.landing-scratch-cta \{[\s\S]*min-height: 82px/);
  assert.match(homepageStyles, /\.landing-template-track \.landing-template-card\s*\{[^}]*flex: 0 0 calc\(\(100% - 48px\) \/ 4\)/);
  assert.match(homepageStyles, /@media \(max-width: 980px\)[\s\S]*\.landing-template-track \.landing-template-card\s*\{[^}]*flex-basis: calc\(\(100% - 16px\) \/ 2\)/);
  assert.match(homepageStyles, /@media \(max-width: 640px\)[\s\S]*\.landing-template-track \.landing-template-card\s*\{[^}]*flex-basis: 100%/);
  assert.match(homepageStyles, /\.landing-template-controls\s*\{[^}]*justify-content: center/);
  assert.match(homepageStyles, /\.landing-template-preview\s*\{[^}]*min-height: 350px/);
  assert.match(homepageStyles, /\.landing-resume-frame\s*\{[^}]*width: 230px;[^}]*height: 325px/);
  assert.match(homepageStyles, /\.landing-resume-paper\s*\{[^}]*transform: scale\(\.28967\)/);
  assert.match(homepageStyles, /\.landing-template-preview \.landing-resume-paper,[\s\S]*?\.landing-template-preview \.landing-resume-paper \.sheet-inner\s*\{[^}]*background-color: #fff !important;[^}]*background-image: none !important/);
  assert.match(homepageStyles, /\.landing-template-preview \.landing-resume-paper\.layout-interio-designer::before\s*\{[^}]*display: none/);
  assert.match(homepageStyles, /\.landing-template-description\s*\{[^}]*color: var\(--about-muted\)/);
  assert.match(homepageStyles, /@media \(max-width: 640px\)[\s\S]*\.landing-pricing-card[\s\S]*grid-template-columns: 1fr/);
  assert.match(homepageStyles, /\.landing-pricing-actions \{\s*gap: 10px;\s*margin-top: 16px;/);
  assert.match(homepageStyles, /\.landing-resume-paper \.section-columns\s*\{[\s\S]*grid-template-columns: minmax\(0, var\(--c1\)\) minmax\(0, var\(--c2\)\)/);
});
