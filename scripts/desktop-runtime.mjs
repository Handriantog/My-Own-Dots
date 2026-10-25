import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { buildIdentity } from './build-identity.mjs';

const excluded = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.local-browsers',
  '.npmrc',
  'credentials.json',
  'id_rsa',
]);
function safePayload(source) {
  const name = path.basename(source);
  return (
    !excluded.has(name) &&
    !/^\.env(?:\.|$)/i.test(name) &&
    !/\.(?:sqlite(?:-wal|-shm)?|sqlite3|db|pyc|key|p12|pfx|onnx|gguf|safetensors|pt|pth)$/i.test(
      name,
    )
  );
}
function resolvePackage(from, name) {
  for (let current = from; ; current = path.dirname(current)) {
    const candidate = path.join(current, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(current) === current) return undefined;
  }
}
/** Copy installed production packages, preserving Node's dependency topology and Python sources. */
export async function stageProductionDependencies(root, output, names) {
  const modules = path.join(root, 'node_modules');
  const canonicalModules = realpathSync(modules);
  const copied = new Set();
  const visit = (source, destination) => {
    const key = path.resolve(destination);
    if (copied.has(key)) return;
    copied.add(key);
    const canonical = realpathSync(source);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(canonical, destination, {
      recursive: true,
      dereference: true,
      filter: (entry) => entry === canonical || safePayload(entry),
    });
    const manifest = JSON.parse(
      readFileSync(path.join(canonical, 'package.json'), 'utf8'),
    );
    const required = { ...manifest.dependencies };
    const optional = {
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    };
    for (const [name, isRequired] of [
      ...Object.keys(required).map((name) => [name, true]),
      ...Object.keys(optional)
        .filter((name) => !required[name])
        .map((name) => [name, false]),
    ]) {
      const found =
        resolvePackage(canonical, name) || resolvePackage(source, name);
      if (!found) {
        if (isRequired)
          throw new Error(
            `Production dependency ${manifest.name}/${name} is not installed.`,
          );
        continue;
      }
      const relative = path.relative(canonicalModules, found);
      // A linked worktree can own its node_modules directory while individual
      // packages resolve to another checkout. Preserve the root installation
      // topology rather than nesting every peer dependency (including cycles).
      const rootPackage = resolvePackage(root, name);
      const target =
        rootPackage && realpathSync(rootPackage) === realpathSync(found)
          ? path.join(output, 'node_modules', name)
          : !relative.startsWith('..') && !path.isAbsolute(relative)
            ? path.join(output, 'node_modules', relative)
            : path.join(destination, 'node_modules', name);
      visit(found, target);
    }
  };
  const manifest = JSON.parse(
    readFileSync(path.join(root, 'package.json'), 'utf8'),
  );
  for (const name of names || Object.keys(manifest.dependencies || {})) {
    const source = resolvePackage(root, name);
    if (!source)
      throw new Error(`Production dependency ${name} is not installed.`);
    visit(source, path.join(output, 'node_modules', name));
  }
  return copied.size;
}
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(path.join(directory, entry.name))
      : entry.name.endsWith('.ts')
        ? [path.join(directory, entry.name)]
        : [],
  );
}
export async function compileDesktopRuntime(root, output) {
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const compilation = await build({
    metafile: true,
    entryPoints: [
      ...sourceFiles(path.join(root, 'src/server')),
      ...sourceFiles(path.join(root, 'src/shared')),
    ],
    outdir: output,
    outbase: path.join(root, 'src'),
    platform: 'node',
    format: 'esm',
    target: 'node24',
    bundle: false,
  });
  writeFileSync(
    path.join(output, 'package.json'),
    JSON.stringify(
      {
        name: 'my-own-dots-runtime',
        private: true,
        type: 'module',
        version: '0.1.0',
      },
      null,
      2,
    ),
  );
  return compilation;
}
export async function buildDesktopRuntime(root, output) {
  const compilation = await compileDesktopRuntime(root, output);
  writeFileSync(
    path.join(output, 'build-identity.json'),
    JSON.stringify(buildIdentity(root), null, 2) + '\n',
  );
  const manifest = JSON.parse(
    readFileSync(path.join(root, 'package.json'), 'utf8'),
  );
  const imports = Object.values(compilation.metafile.outputs)
    .flatMap((output) => output.imports)
    .map((item) => item.path)
    .map((name) =>
      name.startsWith('@')
        ? name.split('/').slice(0, 2).join('/')
        : name.split('/')[0],
    );
  const names = [
    ...new Set(imports.filter((name) => manifest.dependencies[name])),
  ];
  const count = await stageProductionDependencies(root, output, names);
  mkdirSync(path.join(output, 'scripts'), { recursive: true });
  cpSync(
    path.join(root, 'scripts/folder-access.py'),
    path.join(output, 'scripts/folder-access.py'),
  );
  cpSync(
    path.join(root, 'scripts/local-voice'),
    path.join(output, 'scripts/local-voice'),
    { recursive: true, filter: safePayload },
  );
  mkdirSync(path.join(output, 'support'), { recursive: true });
  for (const name of ['compose.local.yml', '.env.example'])
    cpSync(path.join(root, name), path.join(output, 'support', name));
  for (const name of [
    'setup-local.mjs',
    'setup-desktop-integrations.mjs',
    'native-executable-environment.mjs',
  ])
    cpSync(
      path.join(root, 'scripts', name),
      path.join(output, 'support', name),
    );
  cpSync(
    path.join(root, 'docs/desktop/runtime.md'),
    path.join(output, 'support/README.md'),
  );
  console.log(
    `Bundled backend and ${count} production packages (no development environments or data).`,
  );
}
/** Self-contained worker: runtime-selected workspace files are never module search roots. */
export async function buildStorageWorker(root, output) {
  await build({
    entryPoints: [path.join(root, 'src/desktop/host/archive-worker.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    define: { 'import.meta.url': '__dotsBundleUrl' },
    banner: {
      js: "const __dotsBundleUrl = require('node:url').pathToFileURL(__filename).href;",
    },
  });
}
