import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { folderPython } from '../src/server/folder-python.js';

it('uses the managed environment independently of PATH, with explicit absolute overrides', () => {
  expect(folderPython({ PATH: '/usr/bin:/bin' })).toBe(
    resolve('node_modules/myown-llm-integrator/python/.venv/bin/python'),
  );
  expect(
    folderPython({ UV_PROJECT_ENVIRONMENT: '/managed/venv', PATH: '/usr/bin' }),
  ).toBe('/managed/venv/bin/python');
  expect(
    folderPython({
      MYOWN_LLM_PYTHON: '/setup/python',
      UV_PROJECT_ENVIRONMENT: '/managed',
    }),
  ).toBe('/setup/python');
  expect(
    folderPython({
      DOTS_FOLDER_PYTHON: '/folder/python',
      MYOWN_LLM_PYTHON: '/setup/python',
    }),
  ).toBe('/folder/python');
  expect(() => folderPython({ DOTS_FOLDER_PYTHON: 'python3' })).toThrow(
    'absolute',
  );
});

it('resolves a relative environment from the same Python project as uv setup', () => {
  expect(folderPython({ UV_PROJECT_ENVIRONMENT: 'custom-venv' })).toBe(
    resolve('node_modules/myown-llm-integrator/python/custom-venv/bin/python'),
  );
  expect(
    folderPython({
      DOTS_RUNTIME_ROOT: '/bundled/app',
      UV_PROJECT_ENVIRONMENT: 'custom-venv',
    }),
  ).toBe(
    '/bundled/app/node_modules/myown-llm-integrator/python/custom-venv/bin/python',
  );
});
