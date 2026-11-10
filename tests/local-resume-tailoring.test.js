import test from 'node:test';
import assert from 'node:assert/strict';
import { tailorResumeLocally } from '../frontend/src/local-resume-tailoring.js';

function resumeFixture() {
  return {
    docName: 'Original resume',
    profile: { name: 'Alex Morgan' },
    sections: [
      {
        id: 'skills',
        type: 'skills',
        title: 'Skills',
        visible: true,
        content: 'Communication, Playwright, SQL, TypeScript'
      },
      {
        id: 'experience',
        type: 'experience',
        title: 'Experience',
        visible: true,
        entries: [
          { role: 'Support Specialist', company: 'First Co', details: 'Resolved customer questions.\nDocumented recurring issues.' },
          { role: 'QA Engineer', company: 'Second Co', details: 'Coordinated team updates.\nBuilt TypeScript Playwright tests.\nMaintained SQL test data.' }
        ]
      }
    ]
  };
}

test('local tailoring puts matching existing skills, roles, and bullets first without rewriting them', () => {
  const source = resumeFixture();
  const result = tailorResumeLocally(source, {
    name: 'QA Automation',
    jobTitle: 'QA Engineer',
    jobDescription: 'Build automated tests with Playwright, TypeScript, and SQL.'
  });
  const tailoredSkills = result.resume.sections[0].content;
  const tailoredEntries = result.resume.sections[1].entries;

  assert.equal(result.analyzed, true);
  assert.match(tailoredSkills, /^Playwright, SQL, TypeScript, Communication$/);
  assert.equal(tailoredEntries[0].role, 'QA Engineer');
  assert.match(tailoredEntries[0].details, /^Built TypeScript Playwright tests\.\nMaintained SQL test data\.\nCoordinated team updates\.$/);
  assert.ok(result.changes.length >= 3);
  assert.ok(result.matchedSkills.includes('Playwright'));
  assert.deepEqual(source, resumeFixture());
  assert.equal(result.resume.tailoredFor.jobDescription, 'Build automated tests with Playwright, TypeScript, and SQL.');
});

test('local tailoring preserves all text and order when role details do not match', () => {
  const source = resumeFixture();
  const result = tailorResumeLocally(source, {
    name: 'Product Designer',
    jobTitle: 'Product Designer',
    jobDescription: 'Create visual design systems.'
  });

  assert.equal(result.changes.length, 0);
  assert.equal(result.resume.sections[0].content, source.sections[0].content);
  assert.deepEqual(result.resume.sections[1].entries, source.sections[1].entries);
  assert.match(result.message, /No clear matches were found/);
});

test('job description and role are optional; without either, content remains unchanged', () => {
  const source = resumeFixture();
  const result = tailorResumeLocally(source, { name: 'Resume copy', company: 'Example' });

  assert.equal(result.analyzed, false);
  assert.equal(result.resume.tailoredFor.company, 'Example');
  assert.deepEqual(result.resume.sections, source.sections);
  assert.match(result.message, /Add a job description or target role/);
});
