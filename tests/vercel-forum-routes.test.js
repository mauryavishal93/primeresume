import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../backend/server.js';

const routeModules = [
  '../api/forum/activity.js',
  '../api/forum/my-content.js',
  '../api/admin/[...path].js',
  '../api/admin/forum/activity.js',
  '../api/admin/forum/content.js',
  '../api/admin/forum/permanent-delete.js',
  '../api/admin/forum/posts/[postId].js',
  '../api/admin/forum/posts/[postId]/comments/[commentId].js',
  '../api/forum/posts/[postId].js',
  '../api/forum/posts/[postId]/comments.js',
  '../api/forum/posts/[postId]/comments/[commentId].js'
];

test('Vercel forum and admin handlers forward activity, content, moderation, post, and comment routes to Express', async () => {
  for (const routeModule of routeModules) {
    const handler = await import(routeModule);
    assert.equal(handler.default, app, `${routeModule} should export the shared Express app`);
  }
});
