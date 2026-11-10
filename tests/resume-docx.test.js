import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResumeDocx } from '../frontend/src/resume-docx.js';

test('creates a valid editable DOCX archive from resume sections', async () => {
  const blob = await buildResumeDocx({
    docName: 'Alex Morgan',
    profile: { name: 'Alex Morgan', headline: 'QA Engineer', email: 'alex@example.com' },
    design: { accent: '#31547a' },
    sections: [
      { title: 'Summary', type: 'summary', visible: true, content: 'Quality engineer.' },
      { title: 'Experience', type: 'experience', visible: true, entries: [{ role: 'QA Engineer', company: 'Acme', date: '2022—Present', details: 'Built test automation.' }] }
    ]
  });

  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.ok(blob.size > 1000);
  assert.equal(Buffer.from(await blob.arrayBuffer()).subarray(0, 2).toString(), 'PK');
});
