import * as path from 'path';

export const PROTECTED_STORAGE_SMOKE_DIRECTORY_PREFIX = 'wlb-protected-storage-smoke-';

export function resolveProtectedStorageSmokeDirectory(
  requested: boolean,
  candidate: unknown,
  tempRoot: string,
): string | null {
  if (!requested) return null;
  if (typeof candidate !== 'string' || candidate.length === 0) return null;

  const resolvedTempRoot = path.resolve(tempRoot);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedTempRoot, resolvedCandidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  if (!path.basename(resolvedCandidate).startsWith(PROTECTED_STORAGE_SMOKE_DIRECTORY_PREFIX)) {
    return null;
  }
  return resolvedCandidate;
}
