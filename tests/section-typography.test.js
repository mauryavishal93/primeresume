import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applySectionTypography, normalizeSectionTypography } from '../frontend/src/section-typography.js';

test('section typography defaults to global sizes for existing resume sections', () => {
  assert.deepEqual(
    normalizeSectionTypography({}, { headingSize: 18, fontSize: 13 }),
    { headingSize: 18, bodySize: 13 }
  );
});

test('section typography preserves valid overrides and clamps invalid ranges', () => {
  assert.deepEqual(
    normalizeSectionTypography({ headingSize: '32', bodySize: 28 }, { headingSize: 15, fontSize: 12 }),
    { headingSize: 32, bodySize: 24 }
  );
  assert.deepEqual(
    normalizeSectionTypography({ headingSize: 2, bodySize: 'invalid' }, { headingSize: 15, fontSize: 12 }),
    { headingSize: 10, bodySize: 12 }
  );
});

test('section typography is applied to rendered sections and editable in the inspector', () => {
  const properties = new Map();
  applySectionTypography({ style: { setProperty: (name, value) => properties.set(name, value) } }, {
    headingSize: 20,
    bodySize: 14
  });
  assert.deepEqual([...properties], [
    ['--section-heading-size', '20px'],
    ['--section-body-size', '14px']
  ]);

  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../frontend/src/style.css', import.meta.url), 'utf8');
  assert.match(source, /id="sectionHeadingSize" type="number"/);
  assert.match(source, /id="sectionBodySize" type="number"/);
  assert.match(source, /applySectionTypography\(sec,s\)/);
  assert.match(source, /sectionTypographyCallout/);
  assert.match(source, /selectSection\(el\.dataset\.resumeSection,Boolean\(e\.target\.closest\('\[contenteditable="true"\]'\)\),el\)/);
  assert.match(source, /updateSectionTypographyCallout\(\)/);
  assert.match(source, /if\(k==='fontSize'\)state\.sections\.forEach\(section=>section\.bodySize=v\)/);
  assert.match(source, /if\(k==='headingSize'\)state\.sections\.forEach\(section=>section\.headingSize=v\)/);
  assert.match(styles, /#sheets \.resume-section>\.section-heading/);
  assert.match(styles, /#sheets \.resume-section \.section-body,#sheets \.resume-section \.section-body \*/);
  assert.match(styles, /#sectionTypographyCallout\[hidden\]\{display:none\}/);
});

test('section typography callout is opt-in and its Account setting is persisted', () => {
  const html = readFileSync(new URL('../frontend/editor.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../frontend/src/style.css', import.meta.url), 'utf8');
  assert.match(html, /Section text sizes<\/span><button class="section-typography-switch" id="sectionTypographyToggle"[^>]*aria-checked="false"/);
  const toggleMarkup = html.match(/<button class="section-typography-switch" id="sectionTypographyToggle"[\s\S]*?<\/button>/)[0];
  assert.doesNotMatch(toggleMarkup, /data-theme-toggle|theme-switch/);
  assert.match(toggleMarkup, /section-typography-label">Off/);
  assert.match(source, /sectionTypographyCalloutEnabled=false/);
  assert.match(source, /if\(!sectionTypographyCalloutEnabled\)\{if\(callout\)callout\.hidden=true;return\}/);
  assert.match(source, /rightTab,onboardingDismissed,sectionTypographyCalloutEnabled/);
  assert.match(source, /sectionTypographyCalloutEnabled=u\.sectionTypographyCalloutEnabled===true/);
  assert.match(source, /sectionTypographyCalloutEnabled=!sectionTypographyCalloutEnabled/);
  assert.match(styles, /\.section-typography-switch\[aria-checked=true\] \.section-typography-thumb\{transform:translateX\(15px\)\}/);
  assert.match(styles, /\.section-typography-thumb\{[^}]*transform:translateX\(0\)/);
});

test('editing preserves template section backgrounds and uses a visible focus ring', () => {
  const styles = readFileSync(new URL('../frontend/src/style.css', import.meta.url), 'utf8');
  const brianStyles = readFileSync(new URL('../Templates/brian-baxter/style.css', import.meta.url), 'utf8');
  assert.match(styles, /\.sheet \[contenteditable="true"\]:focus\{background:transparent;caret-color:currentColor;box-shadow:0 0 0 2px var\(--resume-accent\)/);
  assert.doesNotMatch(styles, /\.sheet \[contenteditable="true"\]:focus\{background:#fff/);
  assert.match(brianStyles, /\.br-sidebar-sections \.resume-section \.section-body \[contenteditable=true\]:focus\{background:transparent!important;color:inherit!important;caret-color:currentColor!important/);
});

test('resume design supports independent section-title and details text colors', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../frontend/src/style.css', import.meta.url), 'utf8');
  assert.match(source, /sectionTitleColor:'',detailsColor:''/);
  assert.match(source, /sectionTitleColor:\/\^#\[0-9a-f\]\{6\}\$\/i\.test\(str\(ds\.sectionTitleColor\)\)/);
  assert.match(source, /detailsColor:\/\^#\[0-9a-f\]\{6\}\$\/i\.test\(str\(ds\.detailsColor\)\)/);
  assert.match(source, /data-design="sectionTitleColor" type="color"/);
  assert.match(source, /data-design="detailsColor" type="color"/);
  assert.match(source, /data-reset-design-color="sectionTitleColor"/);
  assert.match(source, /data-reset-design-color="detailsColor"/);
  assert.match(source, /id="resetAllTextColors" type="button">Reset all text colors to template/);
  assert.match(source, /state\.design\.sectionTitleColor='';\s*state\.design\.detailsColor='';/);
  assert.match(source, /set\('--resume-title-color',d\.sectionTitleColor\)/);
  assert.match(source, /set\('--resume-details-color',d\.detailsColor\)/);
  assert.match(styles, /#sheets \.sheet\[data-custom-title-color="true"\] \.resume-section>\.section-heading\{color:var\(--resume-title-color\)!important\}/);
  assert.match(styles, /#sheets \.sheet\[data-custom-details-color="true"\] \.resume-section \.section-body \*\{color:var\(--resume-details-color\)!important\}/);
});
