import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { app } from '../backend/server.js';

test('Vercel rewrites nested API requests through one Express function', async () => {
  const configuration = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(configuration.rewrites, [{
    source: '/api/:path*',
    missing: [{ type: 'query', key: '__api_path' }],
    destination: '/api/handler?__api_path=:path*'
  }]);

  const { default: handler } = await import('../api/handler.js');
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(`${origin}/api/handler?__api_path=health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');

    const nestedAdmin = await fetch(
      `${origin}/api/handler?__api_path=admin%2Fforum%2Fcontent&kind=posts`
    );
    assert.equal(nestedAdmin.status, 401);
    assert.equal(nestedAdmin.headers.get('cache-control'), 'no-store');
    assert.equal((await nestedAdmin.json()).error, 'Sign in before accessing this feature.');
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
