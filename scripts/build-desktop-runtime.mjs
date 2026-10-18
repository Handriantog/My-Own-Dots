import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildDesktopRuntime } from './desktop-runtime.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
await buildDesktopRuntime(root, path.join(root, 'dist/desktop/app'));
