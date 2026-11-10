import { RESUME_PDF_METADATA_NAMESPACE } from './resume-import-metadata.js';

export function drawPdfText(doc, text, x, y, { font, style, size, color, renderingMode = 'fill' }) {
  doc.setFont(font, style);
  doc.setFontSize(size);
  doc.setTextColor(...color);
  doc.text(text, x, y, { renderingMode });
}

export const RESUME_PDF_FORMATS = Object.freeze({
  a4: Object.freeze({ label: 'A4', width: 210, height: 297 }),
  letter: Object.freeze({ label: 'US Letter', width: 215.9, height: 279.4 })
});

export function pdfPagePlacement(sheet, doc, margin = 0, reservedBottom = 0) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  if (typeof sheet?.getBoundingClientRect !== 'function') {
    return {
      bounds: null,
      scale: 1,
      x: margin,
      y: margin,
      width: pageWidth - margin * 2,
      height: pageHeight - margin * 2 - reservedBottom
    };
  }
  const bounds = sheet.getBoundingClientRect();
  const availableHeight = pageHeight - margin * 2 - reservedBottom;
  const scale = Math.min((pageWidth - margin * 2) / bounds.width, availableHeight / bounds.height);
  const width = bounds.width * scale;
  const height = bounds.height * scale;
  return { bounds, scale, x: (pageWidth - width) / 2, y: margin + (availableHeight - height) / 2, width, height };
}

export function buildResumePdf(jsPDF, pages, {
  addSelectableText,
  addPDFLinks,
  addPdfDecorations,
  resumeState,
  format = 'a4',
  margin = 0,
  pageNumbers = false
}) {
  const pageFormat = Object.hasOwn(RESUME_PDF_FORMATS, format) ? format : 'a4';
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: pageFormat, compress: true });

  if (resumeState) {
    doc.addMetadata(JSON.stringify({
      format: 'ResumeOut.comResume',
      version: 1,
      resume: resumeState
    }), RESUME_PDF_METADATA_NAMESPACE);
  }

  pages.forEach(({sheet, image}, index) => {
    if (index > 0) doc.addPage(pageFormat, 'portrait');
    const placement = pdfPagePlacement(sheet, doc, margin, pageNumbers ? 10 : 0);
    addPdfDecorations(doc, sheet, image, placement);
    addSelectableText(doc, sheet, { renderingMode: 'invisible', placement });
    addPDFLinks(doc, sheet, { placement });
    if (pageNumbers) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(100, 108, 120);
      doc.text(`${index + 1} / ${pages.length}`, doc.internal.pageSize.getWidth() / 2, doc.internal.pageSize.getHeight() - Math.max(4, margin / 2), { align: 'center' });
    }
  });

  return { blob: doc.output('blob') };
}
