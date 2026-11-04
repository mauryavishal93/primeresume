import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseResumeText } from '../frontend/src/resume-import-structure.js';
import { readEmbeddedResumeProject, RESUME_PDF_METADATA_NAMESPACE } from '../frontend/src/resume-import-metadata.js';
import { splitContentIntoBullets, splitSummaryIntoBullets } from '../frontend/src/resume-summary.js';
import { parseResumeProjectJson } from '../frontend/src/resume-import-json.js';

test('resume import maps common contact details and section headings', () => {
  const parsed = parseResumeText([
    'Alex Morgan',
    'Product Engineer',
    'alex@example.com',
    '+1 (415) 555-0134',
    'San Francisco, CA',
    'SUMMARY',
    'Product engineer focused on accessible web applications.',
    'EXPERIENCE',
    'Senior Engineer',
    'Example Labs',
    '2021 - Present',
    '• Led a platform migration.',
    'EDUCATION',
    'B.S. Computer Science',
    'Example University',
    '2017 - 2021',
    'SKILLS',
    'JavaScript, Accessibility, Testing'
  ].join('\n'), 'alex-morgan.pdf');

  assert.equal(parsed.docName, 'alex-morgan');
  assert.deepEqual(parsed.profile, {
    name: 'Alex Morgan',
    headline: 'Product Engineer',
    email: 'alex@example.com',
    phone: '+1 (415) 555-0134',
    location: 'San Francisco, CA',
    website: ''
  });
  assert.deepEqual(parsed.sections.map(section => section.type), ['summary', 'experience', 'education', 'skills']);
  assert.deepEqual(parsed.sections[1].entries[0], {
    role: 'Senior Engineer',
    company: 'Example Labs',
    date: '2021 - Present',
    details: 'Led a platform migration.'
  });
  assert.equal(parsed.sections[1].listStyle, 'none');
  assert.deepEqual(parsed.sections[2].entries[0], {
    role: 'B.S. Computer Science',
    company: 'Example University',
    date: '2017 - 2021',
    details: ''
  });
  assert.equal(parsed.sections[3].content, 'JavaScript, Accessibility, Testing');
});

test('resume import preserves role, company, date, and bullets on combined lines', () => {
  const parsed = parseResumeText([
    'Alex Morgan',
    'WORK EXPERIENCE',
    'Senior Engineer | Example Labs | 2021 - Present',
    '• Built accessible products.',
    '• Mentored a team of five.'
  ].join('\n'), 'alex-morgan.pdf');

  assert.deepEqual(parsed.sections[0].entries[0], {
    role: 'Senior Engineer',
    company: 'Example Labs',
    date: '2021 - Present',
    details: 'Built accessible products. Mentored a team of five.'
  });
});

test('resume import keeps unbulleted experience descriptions with their jobs', () => {
  const parsed = parseResumeText([
    'Alex Morgan',
    'WORK HISTORY',
    'Senior Software Engineer at Northwind | Jan 2022 – Present',
    'Leading a platform team and shipping customer-facing services.',
    'Reduced response times by 40%.',
    'Product Engineer - Contoso | 2019 - 2021',
    'Developed accessible interfaces used by thousands of customers.'
  ].join('\n'), 'alex-morgan.pdf');

  assert.equal(parsed.sections[0].entries.length, 2);
  assert.deepEqual(parsed.sections[0].entries[0], {
    role: 'Senior Software Engineer',
    company: 'Northwind',
    date: 'Jan 2022 – Present',
    details: 'Leading a platform team and shipping customer-facing services. Reduced response times by 40%.'
  });
  assert.deepEqual(parsed.sections[0].entries[1], {
    role: 'Product Engineer',
    company: 'Contoso',
    date: '2019 - 2021',
    details: 'Developed accessible interfaces used by thousands of customers.'
  });
});

test('resume import maps project details and certification bullets to their own sections', () => {
  const parsed = parseResumeText([
    'Alex Morgan',
    'PROJECT HIGHLIGHTS',
    'Customer Portal | 2024',
    'Created a self-service portal for account management.',
    '• Reduced support requests by 25%.',
    '',
    'Data Pipeline - 2022',
    'Built an automated data ingestion workflow.',
    '',
    'Open Source Monitor',
    'Created a community tool for tracking service health.',
    'CERTIFICATION',
    '• AWS Certified Developer, 2023',
    '• Professional Scrum Master, 2022',
    'AWARDS AND RECOGNITION',
    '• Engineering Excellence Award, 2021'
  ].join('\n'), 'alex-morgan.pdf');

  assert.equal(parsed.sections[0].type, 'projects');
  assert.deepEqual(parsed.sections[0].entries, [
    { role: 'Customer Portal', company: '', date: '2024', details: 'Created a self-service portal for account management. Reduced support requests by 25%.' },
    { role: 'Data Pipeline', company: '', date: '2022', details: 'Built an automated data ingestion workflow.' },
    { role: 'Open Source Monitor', company: '', date: '', details: 'Created a community tool for tracking service health.' }
  ]);
  assert.equal(parsed.sections[1].type, 'certifications');
  assert.equal(parsed.sections[1].content, 'AWS Certified Developer, 2023 Professional Scrum Master, 2022');
  assert.equal(parsed.sections[2].title, 'Awards');
  assert.equal(parsed.sections[2].content, 'Engineering Excellence Award, 2021');
});

test('resume import extracts profile fields sharing a single contact line', () => {
  const parsed = parseResumeText([
    'Alex Morgan | Product Engineer | alex@example.com | +1 (415) 555-0134 | San Francisco, CA',
    'PROFESSIONAL SUMMARY',
    'Builds accessible web applications.'
  ].join('\n'), 'alex-morgan.pdf');

  assert.deepEqual(parsed.profile, {
    name: 'Alex Morgan',
    headline: 'Product Engineer',
    email: 'alex@example.com',
    phone: '+1 (415) 555-0134',
    location: 'San Francisco, CA',
    website: ''
  });
  assert.equal(parsed.sections[0].content, 'Builds accessible web applications.');
});

test('resume project JSON import keeps the complete editor project shape', () => {
  const project = {
    version: 4,
    docName: 'Alex Resume',
    template: 'modern',
    layout: 'two',
    profile: { name: 'Alex Morgan' },
    design: { accent: '#31547a' },
    sections: [{ type: 'summary', title: 'Professional Summary', content: 'Engineer.' }]
  };
  assert.deepEqual(parseResumeProjectJson(JSON.stringify(project)), project);
  assert.throws(() => parseResumeProjectJson('{invalid'), /not valid/);
  assert.throws(() => parseResumeProjectJson('{}'), /valid ResumeOut.com resume project/);
});

test('resume import keeps unclassified text in a single summary paragraph', () => {
  const source = 'Taylor Example\nCloud Engineer\nSpecialized in resilient systems.\nA unique detail that should remain.';
  const parsed = parseResumeText(source, 'resume.txt');
  assert.equal(parsed.profile.name, 'Taylor Example');
  assert.equal(parsed.profile.headline, 'Cloud Engineer');
  assert.equal(parsed.sections[0].content, 'Specialized in resilient systems. A unique detail that should remain.');
  assert.equal(parsed.sourceText, source);
});

test('resume import maps professional summary to a single editable paragraph by default', () => {
  const parsed = parseResumeText([
    'Alex Morgan',
    'alex@example.com',
    '## Professional Summary',
    '• Product engineer focused on accessible web applications',
    'with a track record of shipping reliable products.',
    'EXPERIENCE',
    'Senior Engineer'
  ].join('\n'), 'alex-morgan.pdf');
  const summary = parsed.sections[0];

  assert.equal(summary.type, 'summary');
  assert.equal(summary.title, 'Professional Summary');
  assert.equal(summary.listStyle, 'none');
  assert.equal(summary.content, 'Product engineer focused on accessible web applications with a track record of shipping reliable products.');
});

test('resume import keeps other section content out of the professional summary', () => {
  const parsed = parseResumeText([
    'Alex Morgan',
    'alex@example.com',
    'PROFESSIONAL SUMMARY: Product engineer focused on accessible applications.',
    'CORE COMPETENCIES',
    'Accessibility, design systems, and testing.',
    'WORK EXPERIENCE',
    'Senior Engineer',
    'Example Labs'
  ].join('\n'), 'alex-morgan.pdf');

  assert.equal(parsed.sections[0].content, 'Product engineer focused on accessible applications.');
  assert.deepEqual(parsed.sections.map(section => section.type), ['summary', 'skills', 'experience']);
  assert.equal(parsed.sections[1].content, 'Accessibility, design systems, and testing.');
  assert.equal(parsed.sections[2].entries[0].role, 'Senior Engineer');
});

test('resume import separates standalone title-case custom headings without splitting experience entries', () => {
  const parsed = parseResumeText([
    'Alex Morgan',
    'PROFESSIONAL SUMMARY',
    'Product engineer focused on accessibility.',
    '',
    'Community Leadership',
    'Organized a volunteer mentorship program.',
    'WORK EXPERIENCE',
    'Senior Engineer',
    'Example Labs',
    '2021 - Present',
    '• Led a platform migration.'
  ].join('\n'), 'alex-morgan.pdf');

  assert.deepEqual(parsed.sections.map(section => section.title), ['Professional Summary', 'Community Leadership', 'Work Experience']);
  assert.equal(parsed.sections[1].content, 'Organized a volunteer mentorship program.');
  assert.equal(parsed.sections[2].entries[0].role, 'Senior Engineer');
});

test('resume import ends summary at an unrecognized title-case section heading', () => {
  const parsed = parseResumeText([
    'Alex Morgan',
    'PROFESSIONAL SUMMARY',
    'Product engineer focused on accessibility.',
    'Community Leadership',
    'Organized a volunteer mentorship program.'
  ].join('\n'), 'alex-morgan.pdf');

  assert.equal(parsed.sections[0].content, 'Product engineer focused on accessibility.');
  assert.equal(parsed.sections[1].title, 'Community Leadership');
  assert.equal(parsed.sections[1].content, 'Organized a volunteer mentorship program.');
});

test('switching a summary to bullets splits it into editable sentences', () => {
  assert.equal(
    splitSummaryIntoBullets('Product engineer.  Builds accessible apps.\nLeads teams.'),
    'Product engineer.\nBuilds accessible apps.\nLeads teams.'
  );
  assert.equal(splitSummaryIntoBullets('Product engineer'), 'Product engineer');
});

test('imported experience and project details stay in paragraphs until bullets are selected', () => {
  const parsed = parseResumeText([
    'Alex Morgan',
    'WORK EXPERIENCE',
    'Senior Engineer | Example Labs | 2021 - Present',
    '• Built accessible products.',
    '• Mentored a team of five.',
    'PROJECTS',
    'Resume Builder | Personal Project | 2024',
    '• Created an import workflow. Improved resume editing.'
  ].join('\n'), 'alex-morgan.pdf');

  assert.equal(parsed.sections[0].listStyle, 'none');
  assert.equal(parsed.sections[0].entries[0].details, 'Built accessible products. Mentored a team of five.');
  assert.equal(parsed.sections[1].listStyle, 'none');
  assert.equal(parsed.sections[1].entries[0].details, 'Created an import workflow. Improved resume editing.');
  assert.equal(
    splitContentIntoBullets(parsed.sections[0].entries[0].details),
    'Built accessible products.\nMentored a team of five.'
  );
  assert.equal(
    splitContentIntoBullets(parsed.sections[1].entries[0].details),
    'Created an import workflow.\nImproved resume editing.'
  );
  const editor = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(editor, /x\.listStyle==='none'&&nextStyle!=='none'/);
  assert.match(editor, /x\.entries\.forEach\(entry=>\{entry\.details=splitContentIntoBullets\(entry\.details\)\}\)/);
  assert.match(editor, /else if\(x\.type!=='skills'\)x\.content=splitContentIntoBullets\(x\.content\)/);
});

test('resume import restores structured data embedded in ResumeOut.com PDFs', () => {
  const project = { template: 'classic', docName: 'Alex Resume', profile: { name: 'Alex Morgan' }, sections: [] };
  const metadataValue = JSON.stringify({ format: 'ResumeOut.comResume', version: 1, resume: project });
  const metadata = {
    get: name => name === 'jspdf:metadata' ? metadataValue : null,
    getRaw: () => `<rdf:Description xmlns:jspdf="${RESUME_PDF_METADATA_NAMESPACE}"><jspdf:metadata>${metadataValue}</jspdf:metadata></rdf:Description>`
  };
  assert.deepEqual(readEmbeddedResumeProject(metadata), project);
  assert.equal(readEmbeddedResumeProject({ get: () => metadataValue, getRaw: () => '<xmpmeta />' }), null);
});

test('resume import remains compatible with PDFs exported before the ResumeOut.com rename', () => {
  const project = { version: 4, profile: { name: 'Alex Morgan' }, sections: [] };
  const metadataValue = JSON.stringify({ format: 'PersonaCraftProResume', version: 1, resume: project });
  const metadata = {
    get: name => name === 'jspdf:metadata' ? metadataValue : null,
    getRaw: () => '<rdf:Description xmlns:jspdf="https://personacraftpro.com/ns/resume/1.0/"></rdf:Description>'
  };

  assert.deepEqual(readEmbeddedResumeProject(metadata), project);
});

test('resume import offers review, backup, and supported file choices before applying', () => {
  const html = readFileSync(new URL('../frontend/editor.html', import.meta.url), 'utf8');
  const home = readFileSync(new URL('../frontend/home.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../frontend/src/style.css', import.meta.url), 'utf8');
  const parser = readFileSync(new URL('../frontend/src/resume-import.js', import.meta.url), 'utf8');
  assert.ok(html.indexOf('id="importResumeBtn"') < html.indexOf('id="coverLetterBtn"'));
  assert.match(home, /href="\/editor\.html\?open=import">Import resume<\/a>/);
  assert.match(home, /<section class="landing-cta">[\s\S]*?<a class="btn outline" href="\/editor\.html\?open=import">Import resume<\/a>[\s\S]*?<\/section>/);
  assert.match(source, /pageParams\.get\('open'\)==='import'\)openResumeImportPrompt\(\)/);
  assert.match(source, /function openResumeImportPrompt\(\)/);
  assert.match(source, /\$\('chooseResumeImportFile'\)\.addEventListener\('click',\(\)=>\$\('resumeImportInput'\)\.click\(\)\)/);
  assert.match(html, /id="resumeImportStart" hidden/);
  assert.match(html, /id="chooseResumeImportFile"[^>]*>Choose resume file/);
  assert.match(html, /class="btn outline import-resume-btn" id="importResumeBtn"/);
  assert.match(html, /id="resumeImportInput"[^>]*\.pdf,.docx,.txt,.json/);
  assert.match(html, /id="resumeImportReview" hidden/);
  assert.match(html, /Edit extracted details here before applying\./);
  assert.match(html, /Review all extracted text/);
  assert.match(html, /id="applyResumeImport"[^>]*>Save Backup &amp; Apply/);
  assert.match(html, /id="skipBackupApplyResumeImport"[^>]*>Apply Without Backup/);
  assert.match(html, /Formatting may vary\.<\/strong> You can still edit all details in the editor\./);
  assert.match(html, /“Skip backup” applies the import without that download\./);
  assert.match(styles, /\.resume-import-modal\{[^}]*max-height:calc\(100dvh - 32px\)[^}]*overflow:hidden/);
  assert.match(styles, /\.resume-import-review:not\(\[hidden\]\)\{[^}]*overflow-y:auto/);
  assert.match(styles, /\.resume-import-section-list\{[^}]*overflow:visible/);
  assert.match(html, /id="resumeImportErrorTitle"[^>]*>Unsupport Resume format, please DOCS or PDF format/);
  assert.match(source, /extractResumeFile\(file/);
  assert.match(source, /parseResumeText\(extracted\.text,file\.name\)/);
  assert.match(source, /Original editor format detected/);
  assert.match(source, /control\.addEventListener\('input'/);
  assert.match(source, /update\(pendingResumeImport\.projectState\)/);
  assert.match(source, /createResumeImportField\('Details'/);
  assert.match(source, /before-import\.json/);
  assert.match(source, /if\(downloadBackup\)\{/);
  assert.match(source, /applyResumeImport\(\{downloadBackup:false\}\)/);
  assert.match(source, /importedSourceText:parsed\.sourceText/);
  assert.match(source, /out\.importedSourceText=str\(d\.importedSourceText\)/);
  assert.match(source, /activeCloudResumeId=null/);
  assert.match(parser, /mammoth\/mammoth\.browser/);
  assert.match(parser, /pdfjs-dist/);
  assert.match(parser, /createWorker\('eng'/);
  assert.match(parser, /MAX_FILE_BYTES = 15 \* 1024 \* 1024/);
});
