import {
  archiveLimits,
  type ArchiveLimits,
} from '../../shared/storage-archive.js';

// The same rules apply on every OS, including when reading Linux-created archives
// on Windows. Paths are always relative POSIX names; no platform path coercion.
const reserved =
  /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)$/i;
// Control bytes are deliberately rejected, including NUL in archive names.
// eslint-disable-next-line no-control-regex
const forbidden = /[\u0000-\u001f\u007f<>:"\\|?*]/u;

export function validateArchivePaths(
  paths: readonly string[],
  overrides: Partial<ArchiveLimits> = {},
): void {
  const limits = archiveLimits(overrides);
  if (paths.length > limits.maxEntries)
    throw new Error('Archive entry count exceeds limit');
  const seen = new Map<string, { spelling: string; file: boolean }>();
  for (const path of paths) {
    if (
      !path ||
      /[\uD800-\uDFFF]/u.test(path) ||
      Buffer.byteLength(path, 'utf8') > limits.maxPathBytes ||
      forbidden.test(path)
    ) {
      throw new Error('Unsafe archive path or path length limit exceeded');
    }
    const parts = path.split('/');
    let prefix = '';
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        reserved.test(part.split('.')[0].trimEnd())
      ) {
        throw new Error('Unsafe portable archive path');
      }
      prefix = prefix ? `${prefix}/${part}` : part;
      // Upper then lower catches aliases such as ß/SS as well as ordinary case.
      const key = prefix.normalize('NFC').toUpperCase().toLowerCase();
      const file = index === parts.length - 1;
      const previous = seen.get(key);
      if (previous && (previous.spelling !== prefix || previous.file || file)) {
        throw new Error('Duplicate or aliased archive path');
      }
      seen.set(key, { spelling: prefix, file });
    }
  }
}
