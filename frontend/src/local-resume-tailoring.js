import { createTailoredResumeCopy } from './tailored-resume.js';

const STOP_WORDS = new Set(
  'about after again against all also am an and any are as at be because been before being between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves experience work role company job required preferred responsibilities qualifications skills skill ability team candidate position'.split(/\s+/)
);

function words(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .split(/\s+/)
    .map(word => word.replace(/^\.+|\.+$/g, ''))
    .filter(word => word.length > 2 && !STOP_WORDS.has(word));
}

function relevanceScore(value, targetWords) {
  const found = new Set(words(value));
  let score = 0;
  for (const word of targetWords) {
    if (found.has(word)) score += 1;
  }
  return score;
}

function sortByRelevance(items, getText, targetWords) {
  return items
    .map((item, index) => ({ item, index, score: relevanceScore(getText(item), targetWords) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
}

function reorderDetails(details, targetWords) {
  const lines = String(details || '').split(/\r?\n/);
  return sortByRelevance(lines, line => line, targetWords).map(result => result.item).join('\n');
}

function reorderSkills(content, targetWords) {
  const skills = String(content || '').split(/[,;|]/).map(skill => skill.trim()).filter(Boolean);
  return sortByRelevance(skills, skill => skill, targetWords).map(result => result.item).join(', ');
}

export function tailorResumeLocally(resume, {
  name,
  jobTitle = '',
  company = '',
  jobDescription = '',
  sourceResumeId = ''
} = {}) {
  const copy = createTailoredResumeCopy(resume, {
    name,
    jobTitle,
    company,
    jobDescription,
    sourceResumeId
  });
  const targetText = `${jobTitle}\n${jobDescription}`.trim();
  const targetWords = [...new Set(words(targetText))];
  const changes = [];
  const matchedSkills = [];

  if (!targetWords.length) {
    return {
      resume: copy,
      changes: [],
      matchedSkills: [],
      analyzed: false,
      message: 'Add a job description or target role to get local relevance suggestions. This copy will otherwise keep your content and order unchanged.'
    };
  }

  for (const section of copy.sections || []) {
    if (section.visible === false) continue;
    if (section.type === 'skills' && section.content) {
      const oldContent = String(section.content);
      const newContent = reorderSkills(oldContent, targetWords);
      if (newContent !== oldContent) {
        section.content = newContent;
        changes.push(`Moved role-relevant skills toward the beginning of “${section.title}”.`);
      }
      for (const skill of newContent.split(/[,;|]/).map(item => item.trim()).filter(Boolean)) {
        if (relevanceScore(skill, targetWords) > 0) matchedSkills.push(skill);
      }
    }

    if (Array.isArray(section.entries)) {
      const sortedEntries = sortByRelevance(
        section.entries,
        entry => `${entry.role}\n${entry.company}\n${entry.date}\n${entry.details}`,
        targetWords
      ).map(result => result.item);
      if (sortedEntries.some((entry, index) => entry !== section.entries[index])) {
        section.entries = sortedEntries;
        changes.push(`Prioritized relevant experience in “${section.title}”.`);
      }
      for (const entry of section.entries) {
        const oldDetails = String(entry.details || '');
        const newDetails = reorderDetails(oldDetails, targetWords);
        if (newDetails !== oldDetails) {
          entry.details = newDetails;
          changes.push(`Moved relevant existing bullet points first in “${section.title}”.`);
        }
      }
    }
  }

  return {
    resume: copy,
    changes: [...new Set(changes)],
    matchedSkills: [...new Set(matchedSkills)],
    analyzed: true,
    message: changes.length
      ? 'Suggestions only reorder your existing resume content. No wording or facts were generated.'
      : 'No clear matches were found. Your content and order are unchanged.'
  };
}
