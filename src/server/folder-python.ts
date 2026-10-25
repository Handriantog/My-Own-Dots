import { isAbsolute, resolve } from 'node:path';

/** Folder access shares the locked Integrator Python 3.12 runtime, never PATH. */
export function folderPython(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DOTS_FOLDER_PYTHON || env.MYOWN_LLM_PYTHON;
  if (configured) {
    if (!isAbsolute(configured))
      throw new Error(
        'Folder access requires an absolute Python 3.12 interpreter path. Check DOTS_FOLDER_PYTHON or MYOWN_LLM_PYTHON.',
      );
    return configured;
  }
  return resolve(
    env.DOTS_RUNTIME_ROOT || '.',
    'node_modules/myown-llm-integrator/python',
    env.UV_PROJECT_ENVIRONMENT || '.venv',
    'bin/python',
  );
}
