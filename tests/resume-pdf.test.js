import test from 'node:test';
import assert from 'node:assert/strict';
import { jsPDF } from 'jspdf';
import { buildResumePdf, drawPdfText, pdfPagePlacement, RESUME_PDF_FORMATS } from '../frontend/src/resume-pdf.js';
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

test('supports Letter pages, outer margins, page numbers, and aligned page content', async () => {
  const sheet = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 794, height: 1122 }) };
  const placements = [];
  const result = buildResumePdf(UncompressedJsPDF, [{ sheet, image: null }, { sheet, image: null }], {
    format: 'letter',
    margin: 10,
    pageNumbers: true,
    addPdfDecorations: (_doc, _sheet, _image, placement) => placements.push(placement),
    addSelectableText: (_doc, _sheet, { placement }) => placements.push(placement),
    addPDFLinks: (_doc, _sheet, { placement }) => placements.push(placement)
  });
  const pdf = Buffer.from(await result.blob.arrayBuffer()).toString('latin1');
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'letter' });

  assert.equal(RESUME_PDF_FORMATS.letter.label, 'US Letter');
  assert.ok(Math.abs(doc.internal.pageSize.getWidth() - 215.9) < 0.001);
  assert.ok(Math.abs(doc.internal.pageSize.getHeight() - 279.4) < 0.001);
  assert.equal(placements.length, 6);
  assert.equal(placements[0], placements[1]);
  assert.ok(placements[0].x >= 10);
  assert.ok(placements[0].y >= 10);
  assert.ok(placements[0].y + placements[0].height <= 269.4);
  assert.match(pdf, /\(1 \/ 2\) Tj/);
  assert.match(pdf, /\(2 \/ 2\) Tj/);
});
