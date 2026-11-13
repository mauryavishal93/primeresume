import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const SOURCE_PROJECT_ID = 'buildmyportfolio-5b714';
const TARGET_PROJECT_ID = 'resumeout';
const MIGRATION_MARKER_PATH = '_migrationMetadata/firestoreCopy';
const PAGE_SIZE = 200;

function usage() {
  console.error('Usage: node --env-file=.env scripts/copy-firestore.js <target-service-account.json> [--dry-run|--execute|--resume]');
  process.exitCode = 2;
}

function parseServiceAccount(raw, label, expectedProjectId) {
  let account;
  try {
    account = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} service account JSON is invalid.`, { cause: error });
  }
  if (account.project_id !== expectedProjectId) {
    throw new Error(`${label} service account must belong to ${expectedProjectId}.`);
  }
  return account;
}

function remapReferences(value, sourceDb, targetDb) {
  if (Array.isArray(value)) return value.map(item => remapReferences(item, sourceDb, targetDb));
  if (!value || typeof value !== 'object') return value;
  if (value.firestore === sourceDb && typeof value.path === 'string') return targetDb.doc(value.path);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, remapReferences(item, sourceDb, targetDb)])
  );
}

async function visitDocument(document, { onDocument, sourceDb, targetDb, FieldPath, seenPaths }) {
  if (seenPaths.has(document.ref.path)) return 0;
  seenPaths.add(document.ref.path);
  let count = await onDocument(document) === false ? 0 : 1;
  for (const childCollection of await document.ref.listCollections()) {
    count += await visitCollection(childCollection, { onDocument, sourceDb, targetDb, FieldPath, seenPaths });
  }
  return count;
}

async function visitCollection(collection, { onDocument, sourceDb, targetDb, FieldPath, seenPaths }) {
  let lastDocument = null;
  let count = 0;
  while (true) {
    let query = collection.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (lastDocument) query = query.startAfter(lastDocument);
    const snapshot = await query.get();
    if (snapshot.empty) break;
    for (const document of snapshot.docs) {
      count += await visitDocument(document, { onDocument, sourceDb, targetDb, FieldPath, seenPaths });
    }
    lastDocument = snapshot.docs.at(-1);
    if (snapshot.size < PAGE_SIZE) break;
  }
  return count;
}

async function listAuthUserIds(auth) {
  const ids = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    ids.push(...page.users.map(user => user.uid));
    pageToken = page.pageToken;
  } while (pageToken);
  return ids;
}

async function scanDocuments(db, FieldPath, userIds, { onDocument = async () => true, ignoreMigrationMarker = false } = {}) {
  let count = 0;
  const seenPaths = new Set();
  const options = {
    sourceDb: db,
    targetDb: db,
    FieldPath,
    seenPaths,
    onDocument: async document => {
      if (ignoreMigrationMarker && document.ref.path === MIGRATION_MARKER_PATH) return false;
      return onDocument(document);
    }
  };
  for (const collection of await db.listCollections()) {
    count += await visitCollection(collection, options);
  }
  for (const uid of userIds) {
    const userReference = db.collection('users').doc(uid);
    for (const collection of await userReference.listCollections()) {
      count += await visitCollection(collection, options);
    }
  }
  return { count, paths: seenPaths };
}

async function main() {
  const [targetCredentialPath, ...flags] = process.argv.slice(2);
  const mode = flags[0];
  if (!targetCredentialPath || flags.length > 1 || !['--dry-run', '--execute', '--resume'].includes(mode)) {
    usage();
    return;
  }

  const sourceCredentials = parseServiceAccount(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '',
    'Source',
    SOURCE_PROJECT_ID
  );
  const targetCredentials = parseServiceAccount(
    await readFile(path.resolve(targetCredentialPath), 'utf8'),
    'Target',
    TARGET_PROJECT_ID
  );

  const [{ cert, initializeApp }, { getAuth }, firestoreAdmin] = await Promise.all([
    import('firebase-admin/app'),
    import('firebase-admin/auth'),
    import('firebase-admin/firestore')
  ]);
  const { FieldPath, getFirestore } = firestoreAdmin;
  const sourceApp = initializeApp({ credential: cert(sourceCredentials) }, 'firestore-migration-source');
  const targetApp = initializeApp({ credential: cert(targetCredentials) }, 'firestore-migration-target');
  const sourceDb = getFirestore(sourceApp);
  const targetDb = getFirestore(targetApp);
  const sourceAuth = getAuth(sourceApp);
  const userIds = await listAuthUserIds(sourceAuth);
  const sourceCollections = await sourceDb.listCollections();
  if (sourceCollections.some(collection => collection.id === '_migrationMetadata')) {
    throw new Error(`The source uses the reserved migration collection "_migrationMetadata".`);
  }

  const migrationMarker = targetDb.doc(MIGRATION_MARKER_PATH);
  const markerSnapshot = await migrationMarker.get();
  const sourceScan = await scanDocuments(sourceDb, FieldPath, userIds);
  const targetScan = await scanDocuments(targetDb, FieldPath, userIds, { ignoreMigrationMarker: true });
  if (mode === '--dry-run') {
    const missingCount = [...sourceScan.paths].filter(documentPath => !targetScan.paths.has(documentPath)).length;
    console.log(`Source project: ${SOURCE_PROJECT_ID} (${sourceScan.count} documents across ${userIds.length} Auth users)`);
    console.log(`Target project: ${TARGET_PROJECT_ID} (${targetScan.count} documents)`);
    console.log(`Documents not yet present in target: ${missingCount}`);
    if (targetScan.count > 0) console.log('The target is not empty; use --resume only if it contains data from this migration.');
    console.log('Dry run complete. No data was written.');
    return;
  }

  if (mode === '--resume') {
    for (const documentPath of targetScan.paths) {
      if (!sourceScan.paths.has(documentPath)) {
        throw new Error(`Target contains a document not present in the source (${documentPath}). Refusing to resume.`);
      }
    }
    if (markerSnapshot.exists) {
      const marker = markerSnapshot.data();
      if (marker.sourceProjectId !== SOURCE_PROJECT_ID || marker.targetProjectId !== TARGET_PROJECT_ID || marker.state !== 'running') {
        throw new Error('The target contains a migration marker that does not represent a resumable copy from this source.');
      }
    } else {
      await migrationMarker.set({
        sourceProjectId: SOURCE_PROJECT_ID,
        targetProjectId: TARGET_PROJECT_ID,
        state: 'running',
        startedAt: new Date()
      });
    }
    console.log(`Resuming the verified migration; ${targetScan.count} documents are already present.`);
  } else if (markerSnapshot.exists) {
    const marker = markerSnapshot.data();
    if (marker.sourceProjectId !== SOURCE_PROJECT_ID
      || marker.targetProjectId !== TARGET_PROJECT_ID
      || marker.state !== 'running') {
      throw new Error('The target contains a migration marker that does not represent a resumable copy from this source.');
    }
    console.log(`Resuming the interrupted copy; ${targetScan.count} target documents are already present.`);
  } else {
    if (targetScan.count > 0) {
      throw new Error(`The target contains ${targetScan.count} documents. Refusing to overwrite destination data.`);
    }
    await migrationMarker.set({
      sourceProjectId: SOURCE_PROJECT_ID,
      targetProjectId: TARGET_PROJECT_ID,
      state: 'running',
      startedAt: new Date()
    });
  }

  const copiedPaths = new Set();
  const copyOptions = {
    sourceDb,
    targetDb,
    FieldPath,
    seenPaths: new Set(),
    onDocument: async document => {
      if (mode === '--resume' && targetScan.paths.has(document.ref.path)) return false;
      await targetDb.doc(document.ref.path).set(remapReferences(document.data(), sourceDb, targetDb));
      copiedPaths.add(document.ref.path);
      return true;
    }
  };
  for (const collection of sourceCollections) {
    const count = await visitCollection(collection, copyOptions);
    console.log(`Copied ${collection.id}: ${count} documents, including nested collections.`);
  }
  for (const uid of userIds) {
    for (const collection of await sourceDb.collection('users').doc(uid).listCollections()) {
      const count = await visitCollection(collection, copyOptions);
      console.log(`Copied users/${uid}/${collection.id}: ${count} documents, including nested collections.`);
    }
  }

  await migrationMarker.delete();
  const finalTargetScan = await scanDocuments(targetDb, FieldPath, userIds);
  const missingPaths = [...sourceScan.paths].filter(documentPath => !finalTargetScan.paths.has(documentPath));
  if (missingPaths.length) {
    throw new Error(`Copy verification failed: ${missingPaths.length} source documents are missing from the target.`);
  }
  console.log(`Firestore copy verified: ${sourceScan.count} source documents are present in ${TARGET_PROJECT_ID}; ${copiedPaths.size} written in this run.`);
}

main().catch(error => {
  console.error('Firestore migration failed.', error);
  process.exitCode = 1;
});
