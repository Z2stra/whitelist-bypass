import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import {
  PROTECTED_STORAGE_SMOKE_DIRECTORY_PREFIX,
  resolveProtectedStorageSmokeDirectory,
} from './protected-settings-smoke-policy';

test('protected-storage smoke directory must be an explicitly prefixed child of the temp root', () => {
  const tempRoot = path.resolve('/tmp');
  const candidate = path.join(tempRoot, `${PROTECTED_STORAGE_SMOKE_DIRECTORY_PREFIX}abc`);
  assert.equal(resolveProtectedStorageSmokeDirectory(true, candidate, tempRoot), candidate);
  assert.equal(resolveProtectedStorageSmokeDirectory(false, candidate, tempRoot), null);
});

test('protected-storage smoke directory cannot target application data or escape the temp root', () => {
  const tempRoot = path.resolve('/tmp');
  assert.equal(resolveProtectedStorageSmokeDirectory(true, '/home/user/app-data', tempRoot), null);
  assert.equal(resolveProtectedStorageSmokeDirectory(true, '/tmp/not-prefixed', tempRoot), null);
  assert.equal(resolveProtectedStorageSmokeDirectory(true, '/tmp', tempRoot), null);
  assert.equal(resolveProtectedStorageSmokeDirectory(true, undefined, tempRoot), null);
});
