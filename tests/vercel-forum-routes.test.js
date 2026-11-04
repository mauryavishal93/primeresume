import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../backend/server.js';

test('the single Vercel API catch-all forwards forum and admin routes to Express', async () => {
  const handler = await import('../api/[...path].js');
  assert.equal(handler.default, app);
});
