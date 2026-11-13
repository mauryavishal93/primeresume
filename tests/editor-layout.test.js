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
  assert.match(styles, /#pageLayout\{width:126px;max-width:126px\}/);
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
  assert.doesNotMatch(source, /\.sheet \*, \.sheet \*::before, \.sheet \*::after \{ color: inherit !important; background: transparent !important/);
  assert.match(source, /renderedPages\.push\(\{sheet,image:canvas\.toDataURL\('image\/jpeg',\.94\)\}\)/);
  assert.match(source, /doc\.addImage\(image,'JPEG',0,0,210,297/);
  assert.match(pdfSource, /addSelectableText\(doc, sheet, \{ renderingMode: 'invisible' \}\)/);
});

test('PDF preview status summarizes the selectable page and free-download info concisely', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(source, /Selectable, searchable text · \$\{pageCount\} A4 page/);
  assert.match(source, /Sign in for 2 free Pro PDFs/);
  assert.match(source, /\$\{proTemplateDownloadsRemaining\} free Pro PDF\$\{proTemplateDownloadsRemaining===1\?'':'s'\} left/);
  assert.doesNotMatch(source, /Review before downloading — the button is ready when you are/);
});

test('mobile editor provides view tabs and shows one full-width panel above the canvas', () => {
  const html = readFileSync(new URL('../frontend/editor.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(html, /class="mobile-editor-nav"[^>]*aria-label="Mobile editor views"/);
  for (const panel of ['resume', 'templates', 'design']) {
    assert.match(html, new RegExp(`class="mobile-editor-tab"[^>]*data-mobile-panel="${panel}"`));
  }
  assert.doesNotMatch(html, /data-mobile-panel="sections"/);
  assert.match(source, /function setMobilePanel\(panel\)/);
  assert.match(source, /document\.querySelectorAll\('\.mobile-editor-tab'\)\.forEach/);
  assert.match(source, /if\(next!=='resume'\)\{leftCollapsed=false;collapsed=false;applyPanels\(\)\}/);
  assert.match(source, /function fitMobileZoom\(\)/);
  assert.match(source, /fitMobileZoom\(\);[\s\S]*?fitHomepageDemoZoom\(\);[\s\S]*?updateBrowserPersistenceUI\(\)/);
  assert.match(styles, /grid-template-areas:"mobile-panel" "mobile-canvas"/);
  assert.match(styles, /\.mobile-editor-nav\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(styles, /#layout\[data-mobile-panel=resume\] #leftPanel,#layout\[data-mobile-panel=resume\] #rightPanel/);
  assert.match(styles, /#layout\[data-mobile-panel=design\] #leftPanel\{display:none\}/);
  assert.match(styles, /#importResumeBtn svg\{width:16px;height:16px;flex:0 0 16px/);
  assert.match(html, /id="importResumeBtn"[^>]*aria-label="Import an existing resume"[\s\S]*?<span>Import<\/span>/);
  assert.match(html, /id="pdfBtn"><svg[^>]*aria-hidden="true"[\s\S]*?<span>Export PDF<\/span><\/button>/);
  assert.match(html, /id="googleSignInLabel">Sign in with Google<\/span>\s*<span class="google-signin-compact" aria-hidden="true">Google<\/span>/);
});

test('mobile resume canvas aligns A4 pages and fits them below the desktop zoom floor', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(styles, /#sheets,\.sheets\{width:100%;height:auto;min-height:auto;align-items:flex-start;overflow-x:auto;overflow-y:visible;padding:12px\}/);
  assert.match(source, /const root=\$\('sheets'\),style=getComputedStyle\(root\),width=root\.clientWidth-parseFloat\(style\.paddingLeft\)-parseFloat\(style\.paddingRight\)/);
  assert.match(source, /const fitted=Math\.max\(\.3,Math\.min\(1,width\/PAGE_W\)\)/);
  assert.match(source, /matches \? \.3 : \.45/);
});

test('editor account menu links to Community and My posts', () => {
  const html = readFileSync(new URL('../frontend/editor.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(html, /<body class="auth-state-pending">/);
  assert.match(styles, /body\.auth-state-pending:not\(\.account-avatar-cached\) #googleSignInBtn,body\.auth-state-pending #accountMenu:not\(\[data-auth-shell-visible\]\),body\.auth-signout-pending #googleSignInBtn,body\.auth-signout-pending #accountMenu\{visibility:hidden\}/);
  assert.match(source, /async function updateCloudAccount\(user,error\)\{\s*authStateResolved=true;\s*document\.body\.classList\.remove\('auth-state-pending'\)/);
  assert.match(source, /document\.body\.classList\.add\('auth-signout-pending'\);\s*button\.disabled=true;\s*button\.textContent='Signing out…';\s*await signOutUser\(\)/);
  assert.match(source, /catch\(error\)\{document\.body\.classList\.remove\('auth-signout-pending'\)/);
  const accountMenu = html.slice(html.indexOf('id="accountMenu"'), html.indexOf('</details>', html.indexOf('id="accountMenu"')));
  const options = [
    'My cloud resumes',
    'My posts',
    'Billing',
    'Community',
    'About',
    'Support',
    'Appearance',
    'Sign out'
  ];
  let previousIndex = -1;
  for (const option of options) {
    const optionIndex = accountMenu.indexOf(option);
    assert.ok(optionIndex > previousIndex, `${option} should appear in the shared account menu order`);
    previousIndex = optionIndex;
  }
  assert.match(accountMenu, /id="myPostsLink"[^>]*hidden/);
  assert.match(accountMenu, /id="accountMenuSignInBtn"[^>]*hidden>Sign in with Google<\/button>/);
  assert.match(accountMenu, /class="account-menu-profile" id="accountMenuProfile" hidden/);
  assert.match(source, /\$\('accountMenuProfile'\)\.hidden=!user/);
  assert.match(source, /\$\('accountMenuSignInBtn'\)\.hidden=!!user/);
  assert.match(source, /\$\('accountMenuSignInBtn'\)\.addEventListener\('click',handleGoogleSignIn\)/);
  assert.match(source, /\$\('myPostsLink'\)\.hidden=true/);
  assert.match(source, /\$\('myPostsLink'\)\.hidden=!user/);
});

test('shared account menus omit cloud resumes while the editor keeps its own control', () => {
  const sharedAuth = readFileSync(new URL('../frontend/src/auth-nav.js', import.meta.url), 'utf8');
  const editor = readFileSync(new URL('../frontend/editor.html', import.meta.url), 'utf8');
  assert.doesNotMatch(sharedAuth, /My cloud resumes|cloudLink/);
  assert.match(editor, /id="cloudResumesBtn"[^>]*>My cloud resumes<\/button>/);
});

test('mobile editor header grid rules do not reposition links inside the account dropdown', () => {
  assert.match(styles, /\.topbar>#aboutLink\{grid-area:about\}/);
  assert.doesNotMatch(styles, /(?:^|})#aboutLink\{grid-area:about\}/);
  assert.match(styles, /\.topbar>\[data-theme-toggle\]\{grid-area:theme;width:100%\}/);
  assert.match(styles, /width:min\(300px,calc\(100vw - 32px\)\)/);
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(source, /window\.matchMedia\('\(max-width:640px\)'\)\.matches/);
  assert.match(source, /panel\.style\.position='fixed'/);
  assert.match(source, /panel\.style\.maxHeight=`calc\(100dvh - \$\{triggerBounds\.bottom\+16\}px\)`/);
  assert.match(source, /accountMenu'\)\.addEventListener\('toggle',positionAccountMenuPanel\)/);
});

test('mobile editor gives header actions readable, touch-friendly rows', () => {
  const html = readFileSync(new URL('../frontend/editor.html', import.meta.url), 'utf8');
  assert.match(html, /id="editorCommunityLink" href="\/community\.html">Community<\/a>/);
  assert.match(styles, /grid-template-columns:repeat\(10,minmax\(0,1fr\)\) 42px;grid-template-areas:"brand brand brand brand brand brand docname docname docname docname account" "cloud cloud community community community cover cover cover plans plans plans" "import import import import import import pdf pdf pdf pdf pdf";gap:5px/);
  assert.match(styles, /\.topbar:has\(#googleSignInBtn\[hidden\]\)\{grid-template-areas:"brand brand brand brand brand brand docname docname docname docname account" "community community community community cover cover cover plans plans plans plans" "import import import import import import pdf pdf pdf pdf pdf"\}/);
  assert.match(styles, /\.topbar:has\(#googleSignInBtn\[hidden\]\) \.cloud-actions\{display:none\}/);
  assert.match(styles, /\.topbar \.cloud-actions\{grid-area:cloud;justify-content:center;min-width:0\}/);
  assert.match(styles, /\.topbar \.cloud-actions \.btn\{box-sizing:border-box;width:40px;min-width:40px;max-width:40px;height:40px;min-height:40px;flex:0 0 40px;justify-content:center;gap:0;padding:0\}/);
  assert.match(styles, /\.topbar \.cloud-actions \.google-signin \.google-signin-compact\{display:none\}/);
  assert.match(styles, /\.topbar>\.btn,.topbar>#plansLink\{width:100%;min-width:0;min-height:40px;padding:7px 5px;font-size:12px\}/);
  assert.match(styles, /\.topbar>#importResumeBtn,\.topbar>#pdfBtn\{box-sizing:border-box;min-height:44px;gap:4px;padding-right:3px;padding-left:3px;font-size:clamp\(10px,3vw,12px\)\}/);
  assert.match(styles, /#pdfBtn svg\{width:16px;height:16px;flex:0 0 16px;fill:none;stroke:currentColor/);
  assert.match(styles, /\.topbar #editorCommunityLink\{grid-area:community\}/);
  assert.match(styles, /@media\(max-width:360px\)\{\.topbar #coverLetterBtn,.topbar #editorCommunityLink,.topbar #plansLink\{padding-right:3px;padding-left:3px;font-size:11px\}\}/);
});

test('mobile editor places the resume name immediately before the account icon', () => {
  assert.match(styles, /@media\(max-width:520px\)\{[\s\S]*?grid-template-columns:repeat\(10,minmax\(0,1fr\)\) 42px;grid-template-areas:"brand brand brand brand brand brand docname docname docname docname account"/);
  assert.match(styles, /\.topbar \.docname\{grid-area:docname;width:100%;min-width:0;padding:6px 4px;font-size:11px\}/);
  assert.match(styles, /\.topbar #accountMenu\{grid-area:account;justify-self:end\}/);
});

test('mobile editor brand gives the Pro badge room beside the resume name', () => {
  assert.match(styles, /grid-template-areas:"brand brand brand docname docname account"/);
  assert.match(styles, /@media\(max-width:520px\)\{\.topbar \.brand\{gap:7px\}/);
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

test('editor header uses icon-only sharing and concise JSON action labels', () => {
  const html = readFileSync(new URL('../frontend/editor.html', import.meta.url), 'utf8');
  assert.match(html, /id="loadBtn"[^>]*aria-label="Load JSON project" title="Load JSON"[\s\S]*?<svg[\s\S]*?<\/svg>\s*<\/button>/);
  assert.match(html, /id="saveBtn"[^>]*aria-label="Download JSON project" title="Download JSON"[\s\S]*?<svg[\s\S]*?<\/svg>\s*<\/button>/);
  assert.match(html, /id="shareResumeBtn"[^>]*aria-label="Share resume" title="Share resume"[\s\S]*?<svg[\s\S]*?<\/svg>\s*<\/button>/);
  assert.doesNotMatch(html, /id="loadBtn"[\s\S]*?<span>JSON<\/span>/);
  assert.doesNotMatch(html, /id="saveBtn"[\s\S]*?<span>JSON<\/span>/);
  assert.doesNotMatch(html, /id="shareResumeBtn"[\s\S]*?<span>Share resume<\/span>/);
});

test('editor toolbar controls provide descriptive tooltips', () => {
  const html = readFileSync(new URL('../frontend/editor.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  for (const [id, title] of [
    ['undoBtn', 'Undo'],
    ['redoBtn', 'Redo'],
    ['pageLayout', 'Choose a resume column layout'],
    ['editMode', 'Choose how to edit resume content'],
    ['atsBtn', 'ATS Check'],
    ['zoomOut', 'Zoom out'],
    ['zoomIn', 'Zoom in'],
    ['zoomLabel', 'Current zoom level']
  ]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*title="${title}"`));
  }
  assert.match(source, /\$\('zoomLabel'\)\.title=`Current zoom level: \$\{zoomPercent\}%`/);
});

test('typography popup is hidden only on mobile and positions using its rendered size', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(styles, /@media\(max-width:800px\)\{[\s\S]*?#sectionTypographyCallout\{display:none!important\}/);
  assert.match(source, /callout\.hidden=false;\s*const calloutRect=callout\.getBoundingClientRect\(\),width=calloutRect\.width,height=calloutRect\.height/);
  assert.match(source, /const placeAtBottom=targetMiddle<\(mobileVisibleTop\+mobileVisibleBottom\)\/2/);
  assert.match(source, /x=Math\.max\(padding,Math\.min\(x,window\.innerWidth-width-padding\)\)/);
});

test('free-position pages are created automatically when sections overflow', () => {
  const html = readFileSync(new URL('../frontend/editor.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /addFreePageBtn|Add page/);
  assert.match(source, /out\.freePageCount=clamp\(/);
  assert.match(source, /state\.freePageCount=1;\s*ensurePage\(0\)/);
  assert.match(source, /element\.getBoundingClientRect\(\)\.bottom>sheetBounds\.top\+bounds\.bottom\*scale/);
  assert.match(source, /state\.freePageCount=Math\.max\(state\.freePageCount\|\|1,index\+1\)/);
  assert.match(source, /createFragment\(true\)/);
  assert.match(source, /state\.positions\[section\.id\]=\{\.\.\.position,page:placed\.startPage,y:placed\.startY\}/);
  assert.match(styles, /\.sheets\{width:100%;height:auto;min-height:auto;align-items:flex-start;overflow-x:auto;overflow-y:visible/);
});

test('free-position layouts are persisted per template and first use copies structured placement', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(source, /freeLayoutsByTemplate:\{\}/);
  assert.match(source, /out\.freeLayoutsByTemplate=\{\}/);
  assert.match(source, /function saveActiveFreeLayout\(\)/);
  assert.match(source, /state\.freeLayoutsByTemplate\[state\.template\]=\{/);
  assert.match(source, /function captureStructuredFreeLayout\(\)/);
  assert.match(source, /if\(!loadFreeLayout\(state\.template\)\)captureStructuredFreeLayout\(\)/);
  assert.match(source, /function applyTemplate\(template\)/);
  assert.match(source, /if\(!loadFreeLayout\(template\.id\)\)/);
});

test('free-position sections have drag and resize controls with keyboard support', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(source, /move\.dataset\.freeAction='move'/);
  assert.match(source, /resize\.dataset\.freeAction='resize'/);
  assert.match(source, /next\.w=clamp\(start\.w\+\(ev\.clientX-startX\)\/scale/);
  assert.match(source, /document\.elementFromPoint\(ev\.clientX,ev\.clientY\)/);
  assert.match(source, /addEventListener\('keydown',e=>\{[\s\S]*?e\.key\.startsWith\('Arrow'\)/);
  assert.match(styles, /\.resume-section\.selected \.free-position-control\{display:grid\}/);
});

test('structured pages scroll smoothly and continue long text without losing editable source ranges', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(source, /a\.push\(\{k:'p',t:par,cont:false,lineIndex,textStart:0,textLength:par\.length,blank:!par\.trim\(\)\}\)/);
  assert.match(source, /textStart:0,textLength:text\.length/);
  assert.doesNotMatch(source, /splitParagraph|splitLongParagraphs/);
  assert.match(source, /el\.dataset\.textStart=String\(a\.textStart\);el\.dataset\.textLength=String\(a\.textLength\)/);
  assert.match(source, /el\.dataset\.detailStart=String\(a\.textStart\);el\.dataset\.detailLength=String\(a\.textLength\)/);
  assert.match(source, /function focusTextLine\(sectionId,lineIndex,caretOffset=0,smooth=false\)/);
  assert.match(source, /target\.focus\(\{preventScroll:true\}\)/);
  assert.match(source, /placeCaret\(\);\s*if\(!smooth\)return/);
  assert.match(source, /const behavior=window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches\?'auto':'smooth'/);
  assert.match(source, /target\.classList\.add\('structured-line-enter'\)/);
  assert.match(source, /target\.scrollIntoView\(\{behavior,block:'nearest',inline:'nearest'\}\)/);
  assert.match(source, /function renderSheets\(\)/);
  assert.match(source, /function reflowOverflowingDetail\(el,force=false,immediate=false\)/);
  assert.match(source, /if\(immediate\)reflow\(\);else requestAnimationFrame\(reflow\)/);
  assert.match(source, /focusDetailEditor\(next,\{preventScroll:true\}\)[\s\S]*?reflowOverflowingDetail\(next,false,true\)/);
  assert.match(source, /focusDetailEditor\(moved,\{preventScroll:true\}\)[\s\S]*?moved\.scrollIntoView\(\{behavior:window\.matchMedia/);
  assert.match(source, /st\.ul\.contentEditable='true'/);
  assert.match(source, /function resumeEditableField\(target\)/);
  assert.match(source, /function detailSourceOffset\(section,entryIndex,node,offset\)/);
  assert.match(source, /function replaceEntryDetailSelection\(section,entryIndex,start,end,text,el\)/);
  assert.match(source, /detailLines\(e\.details\)\.map\(\(text,index\)=>\(\{text:text\.trim\(\),index\}\)\)\.filter\(line=>line\.text\)/);
  assert.match(source, /a\.push\(\{k:'entry',e\}\);ls\.forEach/);
  assert.doesNotMatch(source, /if\(!hasDetail&&i===0\)return/);
  assert.match(source, /if\(a\.blank\)el\.classList\.add\('blank-line'\)/);
  assert.match(source, /focusTextLine\(section\.id,lineIndex\+1,0,true\)/);
  assert.match(source, /original\.slice\(0,start\)\+value\+original\.slice\(start\+length\)/);
  assert.match(source, /lines\[lineIndex\]\.slice\(start\+\(Number\.isFinite\(length\)\?length:editValue\.length\)\)/);
  assert.match(styles, /\.center\{height:calc\(100vh - 64px\);[^}]*scroll-behavior:smooth/);
  assert.match(styles, /\.structured-line-enter\{animation:structured-page-appear \.16s ease-out both\}/);
  assert.match(styles, /@keyframes structured-page-appear\{from\{opacity:\.55\}to\{opacity:1\}\}/);
  assert.match(styles, /@media screen and \(max-width:960px\)[\s\S]*?\.center\{grid-area:center;width:100%;height:auto/);
  assert.match(styles, /@media\(prefers-reduced-motion:reduce\)\{\.center\{scroll-behavior:auto\}\.structured-line-enter\{animation:none\}\}/);
});

test('all content sections share cross-line selection and preserve an editable blank line', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(source, /if\(section\?\.content!==undefined&&section\.type!=='skills'&&el\?\.dataset\.textIndex!==undefined\)return \{kind:'content',section\}/);
  assert.match(source, /scope\?\.kind==='content'\?contentTextBoundaries\(section\.id\):null/);
  assert.match(source, /scope\?\.kind==='content'&&e\.shiftKey/);
  assert.match(source, /if\(scope\.kind==='content'\|\|scope\.kind==='skills'\)replaceContentSelection\(scope\.section,selected\.start,selected\.end/);
  assert.match(source, /section\.content=content\.slice\(0,start\)\+text\+content\.slice\(end\)/);
  assert.match(source, /else String\(s\.content\|\|''\)\.replace/);
  assert.match(source, /if\(a\.blank\)\{el\.classList\.add\('blank-line'\)/);
});

test('cut writes selected resume text to the clipboard before removing it', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(source, /addEventListener\('cut',e=>\{[\s\S]*?if\(selected&&e\.clipboardData\)\{[\s\S]*?e\.clipboardData\.setData\('text\/plain',source\.slice\(selected\.start,selected\.end\)\);[\s\S]*?e\.preventDefault\(\);[\s\S]*?replaceContentSelection\(scope\.section,selected\.start,selected\.end,''/);
  assert.match(source, /else replaceEntryDetailSelection\(scope\.section,scope\.entryIndex,selected\.start,selected\.end,''/);
  assert.match(source, /if\(shortcut&&\(key==='c'\|\|key==='x'\)\)\{[\s\S]*?writeResumeClipboardText\(copiedText\)\.then\(\(\)=>\{[\s\S]*?if\(key!=='x'\)return;[\s\S]*?replaceContentSelection\(scope\.section,selected\.start,selected\.end,''/);
  assert.match(source, /function resumeSelectionText\(scope,selected\)/);
  assert.match(source, /function writeResumeClipboardText\(text\)/);
});

test('Core Skills support selecting, copying, cutting, pasting, and deleting multiple skills', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(source, /if\(section\?\.type==='skills'&&el\?\.dataset\.skillIndex!==undefined\)return \{kind:'skills',section\}/);
  assert.match(source, /function skillSourceRanges\(section\)/);
  assert.match(source, /function skillSelectionOffsets\(section,selection\)/);
  assert.match(source, /function skillTextBoundaries\(section\)/);
  assert.match(source, /skillBoundaries&&\(e\.metaKey\|\|e\.ctrlKey\)&&e\.key\.toLowerCase\(\)==='a'/);
  assert.match(source, /scope\?\.kind==='skills'\?skillSelectionOffsets\(section,selection\):null/);
  assert.match(source, /scope\?\.kind==='skills'\)\{[\s\S]*?replaceContentSelection\(scope\.section,start,end,text,el\)/);
  assert.match(source, /if\(section\.type==='skills'\)section\.content=section\.content\.split/);
});

test('Core Skills offer saved display styles in the Selected section inspector', () => {
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(source, /const SKILL_STYLES=\[\['tags','Tags'\],\['pills','Pills'\],\['outlined','Outlined'\],\['list','Simple list'\],\['inline','Inline'\],\['grid','Grid'\],\['soft','Soft color'\],\['gradient','Gradient'\],\['underline','Underline'\],\['numbered','Numbered'\],\['compact','Compact'\],\['dense','Dense \(space-saving\)'\]\]/);
  assert.match(source, /function normalizeSkillStyle\(style\)\{return style==='cards'\?'dense'/);
  assert.match(source, /if\(type==='skills'\)n\.skillStyle=normalizeSkillStyle\(s\.skillStyle\)/);
  assert.match(source, /<label for="skillStyle">Core skills display style<\/label><select id="skillStyle">/);
  assert.match(source, /\$\('skillStyle'\)\?\.addEventListener\('change'/);
  assert.match(source, /sec\.dataset\.skillStyle=normalizeSkillStyle\(s\.skillStyle\)/);
  for (const style of ['pills', 'outlined', 'list', 'inline', 'grid', 'soft', 'gradient', 'underline', 'numbered', 'compact', 'dense']) {
    assert.match(styles, new RegExp(`\\.resume-section\\[data-skill-style=${style}\\]`));
  }
  assert.doesNotMatch(source.match(/const SKILL_STYLES=\[[^\n]+\]/)[0], /cards|Skill cards/);
  assert.match(styles, /\.resume-section\[data-skill-style=dense\] \.skill\{padding:0 3px;border:0/);
});
