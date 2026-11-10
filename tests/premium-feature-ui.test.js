import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('editor exposes controls and dialogs for the three Pro features', () => {
  const html = readFileSync(new URL('../frontend/editor.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../frontend/src/style.css', import.meta.url), 'utf8');
  for (const id of [
    'tailorResumeBtn',
    'tailoredVersionModalBg',
    'createTailoredVersion',
    'previewTailoredVersion',
    'tailoredSuggestionPreview',
    'coverLetterTone',
    'coverLetterLength',
    'saveCoverLetterDraft',
    'loadCoverLetterDraft',
    'premiumExportBtn',
    'downloadResumeDocx',
    'premiumPdfFormat',
    'premiumPdfMargin',
    'premiumPdfPageNumbers',
    'tailoredProgress',
    'coverLetterProgress',
    'premiumExportProgress',
    'pdfPreviewProgress'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const id of ['tailoredProgress', 'coverLetterProgress', 'premiumExportProgress', 'pdfPreviewProgress']) {
    assert.match(html, new RegExp(`id="${id}" role="status" aria-live="polite" aria-busy="false" hidden`));
  }
  assert.match(source, /FEATURE_IDS\.TAILORED_VERSIONS/);
  assert.match(source, /tailorResumeLocally\(state/);
  assert.match(html, /Analysis runs in this browser/);
  assert.match(html, /company <span class="field-optional">optional<\/span>/i);
  assert.match(html, /Job description <span class="field-optional">optional, recommended for better suggestions<\/span>/);
  assert.match(html, /does not rewrite, add, or remove resume facts/);
  assert.match(source, /FEATURE_IDS\.ENHANCED_COVER_LETTERS/);
  assert.match(source, /FEATURE_IDS\.PREMIUM_EXPORTS/);
  assert.match(source, /resumeState:resumeStateForPdfExport\(state\)/);
  assert.match(styles, /\.feature-modal\{[^}]*max-height:min\(88dvh,880px\)[^}]*overflow:auto/);
  assert.match(styles, /\.cover-letter-modal \.cover-letter-actions\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}/);
  assert.match(styles, /@media\(max-width:600px\)\{[\s\S]*?\.feature-footer\{grid-template-columns:1fr\}/);
  assert.match(styles, /\.feature-progress-spinner[^}]*animation:featureSpin/);
});
