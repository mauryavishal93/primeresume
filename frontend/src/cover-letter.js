function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim();
}

function isPlaceholder(value) {
  const text = String(value || '').trim();
  return !text || /^(?:name surname|name and surname|your name|professional title|university name|example(?:\s+.*)?|previous company|organization|add\b.*|job title|skill one|skill two)$/i.test(text);
}

export function buildCoverLetterDraft({
  name = '',
  headline = '',
  email = '',
  phone = '',
  location = '',
  jobTitle = '',
  company = '',
  jobDescription = '',
  summary = '',
  skills = [],
  experience = [],
  tone = 'professional',
  length = 'standard',
  date = new Date().toLocaleDateString()
} = {}) {
  const detailed = length === 'detailed';
  const concise = length === 'concise';
  const relevantSkills = [...new Set(skills
    .map(skill => String(skill || '').trim())
    .filter(skill => skill && !isPlaceholder(skill) && normalizeText(jobDescription).includes(normalizeText(skill))))].slice(0, detailed ? 8 : concise ? 3 : 5);
  const realSummary = isPlaceholder(summary) ? '' : String(summary).trim();
  const recentRole = experience.find(entry => !isPlaceholder(entry?.role) && !isPlaceholder(entry?.details));
  const details = String(recentRole?.details || '').split(/\n+/).map(line => line.trim()).filter(line => line && !isPlaceholder(line)).slice(0, detailed ? 3 : concise ? 1 : 2);
  const role = String(jobTitle || '').trim() || 'the open position';
  const companyName = String(company || '').trim();
  const headlineText = isPlaceholder(headline) ? '' : String(headline).trim();
  const recipient = companyName ? ` at ${companyName}` : '';
  const openings = {
    professional: `I am writing to apply for ${role}${recipient}.`,
    confident: `I am pleased to apply for ${role}${recipient}.`,
    warm: `I am excited to apply for ${role}${recipient}.`
  };
  const closings = {
    professional: 'Thank you for your consideration. I would welcome the opportunity to discuss how my experience could contribute to your team.',
    confident: 'Thank you for your consideration. I would welcome a conversation about how my experience can contribute to your team.',
    warm: 'Thank you for your time and consideration. I would be glad to discuss how my experience could support your team.'
  };
  const paragraphs = [`${openings[tone] || openings.professional}${headlineText ? ` My background is in ${headlineText}.` : ''}`];

  if (realSummary && !concise) paragraphs.push(realSummary);
  if (recentRole && details.length) {
    const employer = isPlaceholder(recentRole.company) ? '' : ` at ${recentRole.company}`;
    paragraphs.push(`In my role as ${recentRole.role}${employer}, my work included:\n${details.map(detail => `- ${detail}`).join('\n')}`);
  }
  if (relevantSkills.length) {
    paragraphs.push(`The role's listed skills also align with my experience in ${relevantSkills.join(', ')}.`);
  }
  paragraphs.push(closings[tone] || closings.professional);

  const contact = [email, phone, location].map(value => String(value || '').trim()).filter(Boolean);
  const header = [String(name || '').trim(), ...contact, String(date || '').trim()].filter(Boolean);
  const signoff = String(name || '').trim();
  return [...header, '', 'Dear Hiring Team,', '', ...paragraphs, '', 'Sincerely,', signoff].join('\n');
}
