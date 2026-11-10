import test from 'node:test';
import assert from 'node:assert/strict';
import { createTailoredResumeCopy, resumeStateForPdfExport } from '../frontend/src/tailored-resume.js';

test('tailored copies clone resume content and retain bounded job metadata', () => {
  const source = { docName: 'Base resume', sections: [{ title: 'Experience' }] };
  const copy = createTailoredResumeCopy(source, {
    name: 'QA Engineer - Acme',
    jobTitle: 'QA Engineer',
    company: 'Acme',
    jobDescription: 'Build reliable software',
    sourceResumeId: 'resume-123'
  });

  assert.notEqual(copy, source);
  assert.notEqual(copy.sections, source.sections);
  assert.equal(source.docName, 'Base resume');
  assert.equal(copy.docName, 'QA Engineer - Acme');
  assert.deepEqual(copy.tailoredFor, {
    jobTitle: 'QA Engineer',
    company: 'Acme',
    jobDescription: 'Build reliable software',
    sourceResumeId: 'resume-123'
  });
});

test('tailored copy names are required and metadata is length-limited', () => {
  assert.throws(() => createTailoredResumeCopy({ sections: [] }, { name: '  ' }), /Enter a name/);
  const copy = createTailoredResumeCopy({ sections: [] }, {
    name: 'R'.repeat(140),
    jobDescription: 'J'.repeat(12_100)
  });
  assert.equal(copy.docName.length, 120);
  assert.equal(copy.tailoredFor.jobDescription.length, 12_000);
});

test('job descriptions stay out of exported PDF resume metadata', () => {
  const copy = createTailoredResumeCopy({ sections: [] }, {
    name: 'QA Engineer',
    jobDescription: 'Confidential target role'
  });
  const exported = resumeStateForPdfExport(copy);

  assert.equal(Object.hasOwn(exported, 'tailoredFor'), false);
  assert.equal(copy.tailoredFor.jobDescription, 'Confidential target role');
});
