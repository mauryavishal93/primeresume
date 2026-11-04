import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Firebase deploy configuration includes the collection-group author index for comments', () => {
  const firebaseConfig = JSON.parse(readFileSync(new URL('../firebase.json', import.meta.url), 'utf8'));
  const firestoreIndexes = JSON.parse(readFileSync(new URL('../firestore.indexes.json', import.meta.url), 'utf8'));

  assert.equal(firebaseConfig.firestore.indexes, 'firestore.indexes.json');
  assert.ok(firestoreIndexes.fieldOverrides.some(override =>
    override.collectionGroup === 'comments'
      && override.fieldPath === 'authorUid'
      && override.indexes.some(index => index.queryScope === 'COLLECTION_GROUP')
  ));
});
