import os from 'node:os';
import path from 'node:path';

/** Native launches do not source shell profiles. Keep configured search order first. */
export function nativeExecutableEnvironment(
  environment,
  platform = process.platform,
) {
  if (platform !== 'darwin') return { ...environment };
  const home = environment.HOME || os.homedir();
  const directories = [
    ...(environment.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(
      path.delimiter,
    ),
    path.join(home, '.local/bin'),
    path.join(home, '.docker/bin'),
    path.join(home, 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/Applications/Docker.app/Contents/Resources/bin',
  ];
  return {
    ...environment,
    PATH: [...new Set(directories.filter(Boolean))].join(path.delimiter),
  };
}
