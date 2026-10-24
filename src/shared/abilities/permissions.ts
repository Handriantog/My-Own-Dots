import type { AbilityManifest } from './manifest.js';

export type PermissionChange = {
  key: string;
  kind: 'added' | 'changed' | 'removed';
  requiresConsent: boolean;
};
/** Canonical object keys; array order is intentional and conservatively reviewed. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonicalJson(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
function access(manifest: AbilityManifest): Map<string, string> {
  return new Map([
    ['source', canonicalJson(manifest.source)],
    ['id', manifest.id],
    ['publisher', manifest.publisher],
    ['entrypoint', canonicalJson(manifest.entrypoint)],
    ['platforms', canonicalJson(manifest.platforms)],
    ['helpers', canonicalJson(manifest.helpers)],
    ['settings', canonicalJson(manifest.settings)],
    ['notices', canonicalJson(manifest.notices ?? [])],
    ['activities', canonicalJson(manifest.activities ?? [])],
    ...manifest.tools.map((tool): [string, string] => [
      'tool:' + tool.id + ':execution',
      tool.execution ?? 'any',
    ]),
    ...manifest.tools.map((tool): [string, string] => [
      'tool:' + tool.id + ':channels',
      canonicalJson(tool.channels ?? ['text', 'voice']),
    ]),
    ...manifest.permissions.map((permission): [string, string] => [
      'permission:' + permission.id,
      canonicalJson(permission),
    ]),
    ...manifest.tools.map((tool): [string, string] => [
      'tool:' + tool.id + ':visibility',
      tool.visibility,
    ]),
  ]);
}
export function permissionDiff(
  previous: AbilityManifest,
  next: AbilityManifest,
): PermissionChange[] {
  const before = access(previous),
    after = access(next);
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .flatMap((key) => {
      if (before.get(key) === after.get(key)) return [];
      const kind = !before.has(key)
        ? 'added'
        : !after.has(key)
          ? 'removed'
          : 'changed';
      return [{ key, kind, requiresConsent: kind !== 'removed' }];
    });
}
