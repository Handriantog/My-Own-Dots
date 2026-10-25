import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Hash source inputs without embedding source, paths outside the repo or credentials. */
export function buildIdentity(root) {
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const files = [
    ...new Set(git('ls-files', '-co', '--exclude-standard', '-z').split('\0')),
  ]
    .filter((file) =>
      /^(src\/|scripts\/|native\/|public\/|vendor\/|package(?:-lock)?\.json$|tsconfig.*\.json$|vite\.config\.ts$)/.test(
        file,
      ),
    )
    .sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file + '\0');
    try {
      hash.update(readFileSync(path.join(root, file)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hash.update('<deleted>');
    }
    hash.update('\0');
  }
  const lock = JSON.parse(
    readFileSync(path.join(root, 'package-lock.json'), 'utf8'),
  );
  const dependency = lock.packages['node_modules/myown-llm-integrator'];
  return {
    sourceSha256: hash.digest('hex'),
    baseCommit: git('rev-parse', 'HEAD'),
    modified: !!git('status', '--porcelain'),
    builtAt: new Date().toISOString(),
    integrator: {
      version: dependency.version,
      integrity: dependency.integrity,
    },
    codexVersion: '0.163.0',
  };
}
