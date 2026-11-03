import { RESUME_PDF_METADATA_NAMESPACE } from './resume-import-metadata.js';

export function drawPdfText(doc, text, x, y, { font, style, size, color, renderingMode = 'fill' }) {
  doc.setFont(font, style);
  doc.setFontSize(size);
  doc.setTextColor(...color);
  doc.text(text, x, y, { renderingMode });
}

export function buildResumePdf(jsPDF, pages, { addSelectableText, addPDFLinks, addPdfDecorations, resumeState }) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });

  if (resumeState) {
    doc.addMetadata(JSON.stringify({
      format: 'PersonaCraftProResume',
      version: 1,
      resume: resumeState
    }), RESUME_PDF_METADATA_NAMESPACE);
  }

  pages.forEach(({sheet, image}, index) => {
    if (index > 0) doc.addPage('a4', 'portrait');
    addPdfDecorations(doc, sheet, image);
    addSelectableText(doc, sheet, { renderingMode: 'invisible' });
    addPDFLinks(doc, sheet);
  });

  return { blob: doc.output('blob') };
}
