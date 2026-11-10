import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');

test('education details can be added or removed independently for each entry', () => {
  assert.match(source, /function renderEntryDetailsField\(section,entry,index\)[\s\S]*?data-add-entry-details="\$\{index\}"[\s\S]*?data-remove-entry-details="\$\{index\}"/);
  assert.match(source, /data-add-entry-details[\s\S]*?x\.entries\[i\]\.details='';x\.entries\[i\]\.detailsEnabled=true/);
  assert.match(source, /data-remove-entry-details[\s\S]*?x\.entries\[i\]\.details='';x\.entries\[i\]\.detailsEnabled=false/);
  assert.match(source, /entry\.detailsEnabled=e\.detailsEnabled===false\?false:e\.detailsEnabled===true\|\|Boolean\(entry\.details\.trim\(\)\)/);
  assert.match(source, /type==='education'\?\{role:'',company:'',date:'',details:'',detailsEnabled:false\}/);
  assert.match(source, /x\.type==='education'\?\{role:'',company:'',date:'',details:'',detailsEnabled:false\}/);
});

test('blank entry details and empty entries are not rendered in the resume', () => {
  assert.match(source, /detailLines\(e\.details\)\.map\(\(text,index\)=>\(\{text:text\.trim\(\),index\}\)\)\.filter\(line=>line\.text\)/);
  assert.match(source, /if\(!\[e\.role,e\.company,e\.date\]\.some\(value=>String\(value\|\|''\)\.trim\(\)\)&&!ls\.length\)continue/);
  assert.match(source, /if\(!a\.length&&!s\.entries\)/);
  assert.match(source, /if\(!sectionAtoms\(section\)\.length\)return/);
});
