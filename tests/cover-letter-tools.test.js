import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCoverLetterDraft } from '../frontend/src/cover-letter.js';

const resume = {
  name: 'Alex Morgan',
  headline: 'QA Engineer',
  email: 'alex@example.com',
  jobTitle: 'QA Engineer',
  company: 'Acme',
  jobDescription: 'Playwright TypeScript automation API testing',
  summary: 'Quality engineer with a track record of reliable releases.',
  skills: ['Playwright', 'TypeScript', 'API Testing', 'Unrelated skill'],
  experience: [{
    role: 'QA Engineer',
    company: 'Example Co',
    details: 'Built Playwright suites.\nImproved API test coverage.\nReduced manual regression effort.'
  }],
  date: 'January 1, 2026'
};

test('cover-letter tone choices change phrasing without changing resume evidence', () => {
  const professional = buildCoverLetterDraft(resume);
  const confident = buildCoverLetterDraft({ ...resume, tone: 'confident' });
  const warm = buildCoverLetterDraft({ ...resume, tone: 'warm' });

  assert.match(professional, /I am writing to apply/);
  assert.match(confident, /I am pleased to apply/);
  assert.match(warm, /I am excited to apply/);
  assert.match(confident, /Playwright, TypeScript, API Testing/);
  assert.doesNotMatch(confident, /Unrelated skill/);
});

test('cover-letter length choices use concise and expanded existing details', () => {
  const concise = buildCoverLetterDraft({ ...resume, length: 'concise' });
  const detailed = buildCoverLetterDraft({ ...resume, length: 'detailed' });

  assert.doesNotMatch(concise, /track record of reliable releases/);
  assert.match(concise, /Built Playwright suites/);
  assert.doesNotMatch(concise, /Improved API test coverage/);
  assert.match(detailed, /track record of reliable releases/);
  assert.match(detailed, /Reduced manual regression effort/);
});
