import test from 'node:test';
import assert from 'node:assert/strict';
import { jsPDF } from 'jspdf';
import { buildResumePdf, drawPdfText } from '../frontend/src/resume-pdf.js';
import { readEmbeddedResumeProject } from '../frontend/src/resume-import-metadata.js';

class UncompressedJsPDF extends jsPDF {
  constructor(options) {
    super({ ...options, compress: false });
  }
}

test('preserves rendered pages and keeps text searchable in the PDF', async () => {
  const resumeState = { version: 4, template: 'classic', profile: { name: 'Alex Morgan' }, sections: [] };
  const image = { data: new Uint8ClampedArray([255, 255, 255, 255]), width: 1, height: 1 };
  const result = buildResumePdf(UncompressedJsPDF, [
    { sheet: { text: 'Vector resume page one' }, image },
    { sheet: { text: 'Vector resume page two' }, image }
  ], {
    addPdfDecorations: (doc, _sheet, pageImage) => doc.addImage(pageImage, 'PNG', 0, 0, 1, 1),
    addSelectableText: (doc, sheet, options) => drawPdfText(doc, sheet.text, 24, 36, {
      font: 'helvetica',
      style: 'normal',
      size: 12,
      color: [24, 42, 58],
      ...options
    }),
    addPDFLinks: () => {},
    resumeState
  });
  const pdf = Buffer.from(await result.blob.arrayBuffer()).toString('latin1');

  assert.match(pdf, /^%PDF-/);
  assert.match(pdf, /\(Vector resume page one\) Tj/);
  assert.match(pdf, /\(Vector resume page two\) Tj/);
  assert.match(pdf, /ResumeOut.comResume/);
  assert.match(pdf, /Alex Morgan/);
  assert.match(pdf, /\/Subtype\s*\/Image/);
  assert.match(pdf, /3 Tr/);
});

test('reads structured resume data back from an exported PDF', async () => {
  globalThis.DOMMatrix ||= class DOMMatrix {};
  globalThis.Path2D ||= class Path2D {};
  globalThis.ImageData ||= class ImageData {};
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const resumeState = { version: 4, template: 'modern', docName: 'Alex & Taylor', profile: { name: 'Alex Morgan' }, sections: [] };
  const result = buildResumePdf(jsPDF, [{ sheet: { text: 'PDF resume' } }], {
    addPdfDecorations: () => {},
    addSelectableText: (doc, sheet) => drawPdfText(doc, sheet.text, 24, 36, {
      font: 'helvetica',
      style: 'normal',
      size: 12,
      color: [24, 42, 58]
    }),
    addPDFLinks: () => {},
    resumeState
  });
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await result.blob.arrayBuffer()) }).promise;
  try {
    const { metadata } = await pdf.getMetadata();
    assert.deepEqual(readEmbeddedResumeProject(metadata), resumeState);
  } finally {
    await pdf.destroy();
  }
});

test('exports large text resumes without a raster-based file size limit', async () => {
  const result = buildResumePdf(UncompressedJsPDF, [{ sheet: { text: 'R'.repeat(520_000) } }], {
    addPdfDecorations: () => {},
    addSelectableText: (doc, sheet) => drawPdfText(doc, sheet.text, 24, 36, {
      font: 'helvetica',
      style: 'normal',
      size: 12,
      color: [24, 42, 58]
    }),
    addPDFLinks: () => {}
  });

  assert.ok(result.blob.size > 500_000);
});

test('draws resume text with visible vector PDF text operators', () => {
  const doc = new UncompressedJsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  drawPdfText(doc, 'Sharp Vector Resume Text', 24, 36, {
    font: 'helvetica',
    style: 'bold',
    size: 12,
    color: [24, 42, 58]
  });

  const pdf = doc.output();
  assert.match(pdf, /\(Sharp Vector Resume Text\) Tj/);
  assert.doesNotMatch(pdf, /3 Tr/);
  assert.doesNotMatch(pdf, /\/Subtype\s*\/Image/);
});
