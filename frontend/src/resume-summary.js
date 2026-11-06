export function joinContentAsParagraph(content) {
  return String(content ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizePastedText(content) {
  return String(content ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n+$/, '');
}

export function splitContentIntoBullets(content) {
  return String(content ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=\.)\s+/)
    .map(sentence => sentence.trim())
    .filter(Boolean)
    .join('\n');
}

export function splitSummaryIntoBullets(content) {
  return splitContentIntoBullets(content);
}
