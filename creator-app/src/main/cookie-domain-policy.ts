export function cookieDomainMatchesRoots(
  rawDomain: unknown,
  roots: readonly string[],
): boolean {
  if (typeof rawDomain !== 'string' || rawDomain.length === 0) return false;
  const domain = rawDomain.trim().replace(/^\.+/, '').toLowerCase();
  if (!domain) return false;
  return roots.some((rawRoot) => {
    const root = rawRoot.trim().replace(/^\.+/, '').toLowerCase();
    return root.length > 0 && (domain === root || domain.endsWith(`.${root}`));
  });
}
