import test, { after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../backend/server.js';

const records = new Map();
const previousAdmin = app.locals.firebaseAdmin;
let nextId = 0;
let server;
let origin;

function documentReference(id) {
  const key = `sharedResumes/${id}`;
  return {
    id,
    get: async () => ({
      exists: records.has(key),
      data: () => records.get(key)
    }),
    set: async value => records.set(key, value),
    delete: async () => records.delete(key)
  };
}

before(async () => {
  app.locals.firebaseAdmin = {
    auth: {
      verifyIdToken: async token => {
        if (token === 'account-one') return { uid: 'account-1' };
        if (token === 'account-two') return { uid: 'account-2' };
        throw new Error('Invalid test token');
      }
    },
    db: {
      collection: name => ({
        where: (field, operator, value) => ({
          limit: count => ({
            get: async () => {
              const docs = [...records.entries()]
                .filter(([key, data]) => key.startsWith(`${name}/`) && operator === '==' && data[field] === value)
                .slice(0, count)
                .map(([key, data]) => ({
                  id: key.split('/').at(-1),
                  data: () => data
                }));
              return { docs, size: docs.length };
            }
          })
        }),
        doc: id => documentReference(id || `share-${++nextId}`)
      })
    }
  };
  records.clear();
  nextId = 0;
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  if (previousAdmin) app.locals.firebaseAdmin = previousAdmin;
  else delete app.locals.firebaseAdmin;
  records.clear();
});

afterEach(() => {
  records.clear();
  nextId = 0;
});

async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return {
    response,
    data: response.status === 204 ? null : await response.json()
  };
}

test('shared resume API creates unlisted links and serves the resume snapshot publicly', async () => {
  const resumeState = {
    version: 4,
    docName: 'Alex Resume',
    template: 'modern',
    profile: { name: 'Alex', email: 'alex@example.com', phone: '+1 555 0100' },
    design: { accent: '#31547a', sectionTitleColor: '#223344' },
    sections: [
      {
        id: 'experience',
        type: 'experience',
        title: 'Experience',
        entries: [
          { role: 'Engineer', company: 'Example Co.', date: '2022—Present', details: 'First full detail.\nSecond full detail.' }
        ]
      },
      { id: 'skills', type: 'skills', title: 'Skills', content: 'JavaScript, TypeScript, SQL' }
    ],
    importedSourceText: 'Complete original resume text'
  };
  const body = {
    name: 'Alex Resume',
    sourceResumeId: 'original-1',
    state: resumeState
  };
  assert.equal((await request('/api/shared-resumes', { method: 'POST', body })).response.status, 401);

  const created = await request('/api/shared-resumes', {
    method: 'POST',
    token: 'account-one',
    body
  });
  assert.equal(created.response.status, 201);
  assert.match(created.data.id, /^share-/);
  assert.deepEqual(records.get(`sharedResumes/${created.data.id}`), {
    ...body,
    ownerUid: 'account-1',
    active: true,
    createdAt: records.get(`sharedResumes/${created.data.id}`).createdAt
  });

  const publicResume = await request(`/api/shared-resumes/${created.data.id}`);
  assert.equal(publicResume.response.status, 200);
  assert.deepEqual(publicResume.data, { name: body.name, state: resumeState });
  assert.equal(publicResume.response.headers.get('cache-control'), 'no-store');

  const ownerList = await request('/api/shared-resumes', { token: 'account-one' });
  assert.equal(ownerList.response.status, 200);
  assert.equal(ownerList.data.shares[0].id, created.data.id);
  assert.equal(ownerList.data.shares[0].sourceResumeId, body.sourceResumeId);
  assert.deepEqual((await request('/api/shared-resumes', { token: 'account-two' })).data.shares, []);
});

test('shared resume API limits creation, validates payloads, and restricts revocation to the owner', async () => {
  const invalid = await request('/api/shared-resumes', {
    method: 'POST',
    token: 'account-one',
    body: { name: ' ', state: {} }
  });
  assert.equal(invalid.response.status, 400);

  const tooLarge = await request('/api/shared-resumes', {
    method: 'POST',
    token: 'account-one',
    body: { name: 'Large resume', state: { data: 'x'.repeat(800 * 1024) } }
  });
  assert.equal(tooLarge.response.status, 413);

  for (let index = 0; index < 50; index++) {
    records.set(`sharedResumes/active-${index}`, {
      ownerUid: 'account-1',
      name: `Resume ${index}`,
      state: {},
      active: true,
      createdAt: new Date()
    });
  }
  const capped = await request('/api/shared-resumes', {
    method: 'POST',
    token: 'account-one',
    body: { name: 'Resume 51', state: {} }
  });
  assert.equal(capped.response.status, 409);

  records.set('sharedResumes/foreign-link', {
    ownerUid: 'account-1',
    name: 'Owner resume',
    state: {},
    active: true,
    createdAt: new Date()
  });
  const forbidden = await request('/api/shared-resumes/foreign-link', {
    method: 'DELETE',
    token: 'account-two'
  });
  assert.equal(forbidden.response.status, 403);
  assert.equal(records.has('sharedResumes/foreign-link'), true);

  const invalidId = await request('/api/shared-resumes/bad%20id');
  assert.equal(invalidId.response.status, 400);
});

test('shared resume API deletes an owner link and makes the old URL unavailable', async () => {
  const created = await request('/api/shared-resumes', {
    method: 'POST',
    token: 'account-one',
    body: { name: 'Owner resume', state: { sections: [] } }
  });
  const revoke = await request(`/api/shared-resumes/${created.data.id}`, {
    method: 'DELETE',
    token: 'account-one'
  });
  assert.equal(revoke.response.status, 204);
  assert.equal((await request(`/api/shared-resumes/${created.data.id}`)).response.status, 404);
});

test('Drive-style public resume URLs serve the editor and preserve the share token query', async () => {
  const response = await fetch(`${origin}/file/d/share-token-123/view?resourcekey=share-token-123`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(await response.text(), /pdfPreviewModalBg/);
});
