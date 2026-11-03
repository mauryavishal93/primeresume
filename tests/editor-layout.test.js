import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const styles = readFileSync(new URL('../frontend/src/style.css', import.meta.url), 'utf8');

test('editor base layout keeps panels beside the resume and templates in a grid', () => {
  assert.match(styles, /\.layout\{display:grid;grid-template-columns:var\(--lw\) minmax\(360px,1fr\) var\(--rw\)/);
  assert.match(styles, /\.left-scroll,#inspector\{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden\}/);
  assert.match(styles, /\.templates\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\);gap:8px;min-width:0\}/);
  assert.match(styles, /\.template-card\{min-width:0\}/);
  assert.match(styles, /\.mini\{height:78px;background:#f8f9fc/);
});

test('sections panel restores its section rows and action button layout', () => {
  assert.match(styles, /\.section-list\{display:flex;flex-direction:column;gap:5px\}/);
  assert.match(styles, /\.section-row\{display:flex;align-items:center;gap:7px/);
  assert.match(styles, /\.section-row \.sect-name\{font-size:11px;font-weight:700;flex:1/);
  assert.match(styles, /\.vis\{border:0;background:transparent/);
  assert.match(styles, /\.add-grid\{display:grid;grid-template-columns:1fr 1fr/);
  assert.match(styles, /\.add\{padding:8px 4px;background:#fff;border:1px dashed/);
});

test('editor toolbar controls have compact icons and responsive grid positions', () => {
  assert.match(styles, /\.toolbar\{[^}]*justify-content:center/);
  assert.match(styles, /\.toolbar-btn svg\{width:16px;height:16px;flex:0 0 16px/);
  assert.match(styles, /@container \(max-width:800px\)\{\.toolbar\{display:flex;align-items:center;justify-content:center;gap:6px\}/);
  assert.match(styles, /@container \(max-width:440px\)/);
});

test('editor hint text is centered in the canvas', () => {
  assert.match(styles, /\.hint\{text-align:center;[^}]*margin:0 auto 12px/);
});

test('mobile PDF preview opens the native document viewer instead of embedding the PDF', () => {
  const html = readFileSync(new URL('../frontend/editor.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(html, /id="openPdfPreview" target="_blank" rel="noopener"/);
  assert.match(source, /\$\('openPdfPreview'\)\.href=pdfPreviewUrl/);
  assert.match(styles, /@media\(max-width:600px\)\{[\s\S]*?\.pdf-preview-mobile-link\{display:inline-flex/);
  assert.match(styles, /\.pdf-preview-frame\{display:none\}/);
});

test('PDF export captures the rendered resume and keeps its text layer searchable', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  const pdfSource = readFileSync(new URL('../frontend/src/resume-pdf.js', import.meta.url), 'utf8');
  assert.match(source, /await html2canvas\(sheet,\{scale:2,backgroundColor:'#ffffff',logging:false,useCORS:true,onclone:normalizePdfCaptureColors\}\)/);
  assert.match(source, /function normalizePdfCaptureColors\(clonedDocument\)\{[\s\S]*?querySelectorAll\('\.sheet \[contenteditable\]'\)/);
  assert.match(source, /removeAttribute\('contenteditable'\)/);
  assert.match(source, /querySelectorAll\('\.sheet \.selected'\)\.forEach/);
  assert.match(source, /querySelectorAll\('\.sheet \[style\]'\)\.forEach/);
  assert.match(source, /stripUnsupportedColors\(stylesheet\.cssRules\)/);
  assert.match(source, /style\.removeProperty\(property\)/);
  assert.match(source, /renderedPages\.push\(\{sheet,image:canvas\.toDataURL\('image\/jpeg',\.94\)\}\)/);
  assert.match(source, /doc\.addImage\(image,'JPEG',0,0,210,297/);
  assert.match(pdfSource, /addSelectableText\(doc, sheet, \{ renderingMode: 'invisible' \}\)/);
});

test('mobile editor provides view tabs and shows one full-width panel above the canvas', () => {
  const html = readFileSync(new URL('../frontend/editor.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(html, /class="mobile-editor-nav"[^>]*aria-label="Mobile editor views"/);
  for (const panel of ['resume', 'templates', 'sections', 'design']) {
    assert.match(html, new RegExp(`class="mobile-editor-tab"[^>]*data-mobile-panel="${panel}"`));
  }
  assert.match(source, /function setMobilePanel\(panel\)/);
  assert.match(source, /document\.querySelectorAll\('\.mobile-editor-tab'\)\.forEach/);
  assert.match(source, /if\(next!=='resume'\)\{leftCollapsed=false;collapsed=false;applyPanels\(\)\}/);
  assert.match(source, /function fitMobileZoom\(\)/);
  assert.match(source, /fitMobileZoom\(\);\s*updateBrowserPersistenceUI\(\)/);
  assert.match(styles, /grid-template-areas:"mobile-panel" "mobile-canvas"/);
  assert.match(styles, /#layout\[data-mobile-panel=resume\] #leftPanel,#layout\[data-mobile-panel=resume\] #rightPanel/);
  assert.match(styles, /#layout\[data-mobile-panel=design\] #leftPanel\{display:none\}/);
  assert.match(styles, /#importResumeBtn svg\{width:16px;height:16px;flex:0 0 16px/);
});

test('resume editing tools collapse vertically on mobile only', () => {
  const html = readFileSync(new URL('../frontend/editor.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(html, /class="toolbar"[^>]*data-collapsed="true"/);
  assert.match(html, /id="toggleResumeTools"[^>]*aria-expanded="false" aria-controls="resumeToolbarControls"/);
  assert.match(html, /class="toolbar-content" id="resumeToolbarControls"/);
  assert.match(styles, /\.toolbar-toggle\{display:none\}/);
  assert.match(styles, /@media\(max-width:800px\)\{[\s\S]*?\.toolbar-toggle\{display:flex/);
  assert.match(styles, /\.toolbar\[data-collapsed=true\] \.toolbar-content\{display:none\}/);
  assert.match(styles, /\.toolbar #undoBtn,\.toolbar #loadBtn,\.toolbar #saveBtn\{grid-area:auto\}/);
  assert.match(source, /setResumeToolbarCollapsed\(mobileToolbarQuery\.matches\)/);
  assert.match(source, /resumeToolbarToggle\.addEventListener\('click'/);
  assert.match(source, /mobileToolbarQuery\.addEventListener\('change'/);
});

test('typography popup is hidden only on mobile and positions using its rendered size', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(styles, /@media\(max-width:800px\)\{[\s\S]*?#sectionTypographyCallout\{display:none!important\}/);
  assert.match(source, /callout\.hidden=false;\s*const calloutRect=callout\.getBoundingClientRect\(\),width=calloutRect\.width,height=calloutRect\.height/);
  assert.match(source, /const placeAtBottom=targetMiddle<\(mobileVisibleTop\+mobileVisibleBottom\)\/2/);
  assert.match(source, /x=Math\.max\(padding,Math\.min\(x,window\.innerWidth-width-padding\)\)/);
});
