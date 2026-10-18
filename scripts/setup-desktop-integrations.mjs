// Run explicitly with Electron's bundled Node or Node 24+: no model downloads.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import path from 'node:path';
const workspace = process.argv[2] && path.resolve(process.argv[2]);
if (!workspace)
  throw new Error(
    'Usage: node setup-desktop-integrations.mjs /absolute/workspace/folder',
  );
const runtime = fileURLToPath(new URL('..', import.meta.url));
const python = path.join(workspace, 'integrations/llm/python');
await mkdir(path.dirname(python), { recursive: true });
await cp(
  path.join(runtime, 'node_modules/myown-llm-integrator/python'),
  python,
  {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (source) =>
      !['.venv', '__pycache__'].includes(path.basename(source)),
  },
);
const result = spawnSync(
  'uv',
  ['sync', '--project', python, '--frozen', '--no-dev'],
  { stdio: 'inherit', env: process.env },
);
if (result.error || result.status !== 0)
  throw new Error(
    'Python setup failed. Install uv, retry this command, and keep your provider CLI signed in.',
  );
const envFile = path.join(workspace, '.env');
const contents = await readFile(envFile, 'utf8');
const existing = parseEnv(contents);
if (!existing.MYOWN_LLM_PYTHON) {
  const executable = path.join(python, '.venv/bin/python');
  const quote = ["'", '`', '"'].find(
    (candidate) =>
      !executable.includes(candidate) &&
      parseEnv(`VALUE=${candidate}${executable}${candidate}`).VALUE ===
        executable,
  );
  if (!quote)
    throw new Error(
      'Workspace path cannot contain all three quote styles. Configure MYOWN_LLM_PYTHON manually.',
    );
  const line = `MYOWN_LLM_PYTHON=${quote}${executable}${quote}`;
  const next = /^MYOWN_LLM_PYTHON=.*$/m.test(contents)
    ? contents.replace(/^MYOWN_LLM_PYTHON=.*$/m, () => line)
    : `${contents.trimEnd()}\n${line}\n`;
  await writeFile(envFile, next, { mode: 0o600 });
}
console.log(
  'Subscription Python dependencies installed in your workspace. Sign in to your selected provider CLI, then retry the app. No speech models were downloaded.',
);
