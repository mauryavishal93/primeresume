import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun
} from 'docx';

function text(value) {
  return String(value || '').trim();
}

function plainParagraph(value) {
  return new Paragraph({ children: [new TextRun(text(value))] });
}

export async function buildResumeDocx(state) {
  const accent = /^#[0-9a-f]{6}$/i.test(state.design?.accent || '') ? state.design.accent.slice(1) : '31547A';
  const paragraphs = [];
  const profile = state.profile || {};
  const name = text(profile.name);
  if (name) paragraphs.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    heading: HeadingLevel.TITLE,
    children: [new TextRun({ text: name, bold: true, color: accent, size: 36 })]
  }));
  if (profile.headline) paragraphs.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: text(profile.headline), bold: true, size: 24 })]
  }));
  const contact = [profile.email, profile.phone, profile.location, profile.website].map(text).filter(Boolean);
  if (contact.length) paragraphs.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 240 },
    children: [new TextRun({ text: contact.join(' | '), size: 18 })]
  }));

  for (const section of (state.sections || []).filter(item => item.visible !== false)) {
    paragraphs.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      border: { bottom: { color: accent, size: 6, space: 4, style: 'single' } },
      spacing: { before: 240, after: 100 },
      children: [new TextRun({ text: text(section.title), bold: true, color: accent })]
    }));

    if (Array.isArray(section.entries)) {
      for (const entry of section.entries) {
        const heading = [entry.role, entry.company].map(text).filter(Boolean).join(' | ');
        if (heading) paragraphs.push(new Paragraph({
          spacing: { before: 100, after: 40 },
          children: [new TextRun({ text: heading, bold: true }), ...(entry.date ? [new TextRun({ text: `  ${text(entry.date)}`, italics: true })] : [])]
        }));
        for (const detail of String(entry.details || '').split(/\r?\n/).map(text).filter(Boolean)) {
          paragraphs.push(new Paragraph({ text: detail, bullet: { indent: 360 }, spacing: { after: 40 } }));
        }
      }
    } else {
      for (const line of String(section.content || '').split(/\r?\n/).map(text).filter(Boolean)) {
        paragraphs.push(plainParagraph(line));
      }
    }
  }

  const document = new Document({
    sections: [{
      properties: { page: { margin: { top: 850, right: 850, bottom: 850, left: 850 } } },
      children: paragraphs
    }]
  });
  return Packer.toBlob(document);
}
