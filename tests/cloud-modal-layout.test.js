import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const styles = readFileSync(new URL('../frontend/src/style.css', import.meta.url), 'utf8');
const main = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');

test('cloud resumes modal keeps controls visible and confines scrolling to the resume list', () => {
  assert.match(styles, /\.cloud-modal\{[^}]*width:min\(620px,calc\(100vw - 32px\)\)[^}]*max-height:calc\(100dvh - 32px\)[^}]*overflow:hidden/);
  assert.match(styles, /\.cloud-resume-list\{[^}]*min-height:0[^}]*overflow-x:hidden[^}]*overflow-y:auto/);
  assert.match(styles, /\.cloud-modal>\.modal-actions\{[^}]*flex:none[^}]*flex-wrap:wrap/);
  assert.match(styles, /@media\(max-width:480px\)\{\.cloud-modal\{padding:14px\}/);
  assert.match(styles, /\.cloud-modal>\.modal-actions \.btn\{width:100%\}/);
});

test('cloud resume share and delete actions are accessible icon buttons', () => {
  assert.ok(main.includes('class="btn outline cloud-icon-btn"'));
  assert.ok(main.includes('class="btn danger cloud-icon-btn"'));
  assert.ok(main.includes("aria-label=\"Share ${$esc(item.name||'Untitled resume')}\""));
  assert.ok(main.includes("aria-label=\"Delete ${$esc(item.name||'Untitled resume')}\""));
  assert.match(styles, /\.cloud-resume-item \.cloud-icon-btn svg\{[^}]*stroke:currentColor/);
});

test('toolbar share click opens the dialog without passing its click event as a link', () => {
  assert.match(main, /\$\('shareResumeBtn'\)\.addEventListener\('click',\(\)=>openShareResumeModal\(\)\)/);
});

test('active share list copies editable links from an icon instead of navigating from its label', () => {
  assert.match(main, /editCopy\.append\(document\.createTextNode\('Open editable copy'\)\)/);
  assert.match(main, /copyEdit\.dataset\.copyEditShare=share\.id/);
  assert.match(main, /if\(copyEdit\)\{const link=resumeEditUrl\(copyEdit\.dataset\.copyEditShare\);void copyResumeShareLink\(link\)\}/);
  assert.match(main, /const resumeEditUrl=\(id\)=>|function resumeEditUrl\(id\)/);
  assert.match(main, /editCopy\.append\(copyEdit\)/);
  assert.match(styles, /\.resume-share-edit-copy-button\{[^}]*width:24px[^}]*cursor:pointer/);
});
