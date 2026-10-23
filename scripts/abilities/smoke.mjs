// Offline artifact acceptance. Only release metadata/download bytes are injected;
// extraction, sealing, authority, worker protocol and confinement are production.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, realpath, access } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    bundle: { type: 'string' },
    workspace: { type: 'string' },
    artifact: { type: 'string' },
    python: { type: 'string' },
    node: { type: 'string' },
  },
});
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error(
    'Ability acceptance requires macOS arm64; unsupported is not a passing skip.',
  );
if (!values.bundle || !values.workspace || !values.artifact)
  throw new Error('--bundle, --workspace and --artifact are required');
const bundle = await realpath(values.bundle),
  artifact = await realpath(values.artifact);
const sha = (data) => createHash('sha256').update(data).digest('hex');
await assert.rejects(access(join(bundle, 'dev-source.json')));
for (const file of [
  'native/ability-launcher',
  'abilities/manifest.schema.json',
  'abilities/protocol.md',
])
  await access(join(bundle, file));
const runtime = createRequire(import.meta.url)(
  join(bundle, 'ability-runtime.cjs'),
);
const bytes = await readFile(artifact),
  descriptorBytes = await readFile(artifact.replace(/\.gz$/, '.json'));
const descriptor = runtime.parseReleaseDescriptor(JSON.parse(descriptorBytes));
// These fixtures have no external capabilities, account or configuration.
assert.deepEqual(descriptor.manifest.permissions, []);
assert.equal(descriptor.manifest.tools[0].id, 'run');
const workspace = resolve(values.workspace);
await mkdir(workspace, { mode: 0o700 }); // Refuse to reuse any existing workspace.
assert.equal(await realpath(workspace), workspace);
const packageRoot = join(workspace, 'installation');
const review = {
  id: randomUUID(),
  expiresAt: Date.now() + 60000,
  descriptor,
  descriptorSha256: sha(descriptorBytes),
  descriptorUrl:
    'https://github.com/example/abilities/releases/download/fixture%2Fv0.1.0/fixture.json',
  archiveUrl:
    'https://api.github.com/repos/example/abilities/releases/assets/1',
};
const installer = new runtime.AbilityInstaller(packageRoot, {
  resolve: async (url) => {
    assert.equal(url, review.descriptorUrl);
    return structuredClone(review);
  },
  download: async (url, limit) => {
    assert.equal(url, review.archiveUrl);
    assert.equal(limit, bytes.length);
    return bytes;
  },
});
const node = await realpath(values.node || process.execPath);
const runtimes = {
  javascript: { executable: node, readRoots: [dirname(dirname(node))] },
};
if (values.python) runtimes.python = await runtime.inspectPython(values.python);
let binding;
const host = new runtime.AbilityHost({
  workspaceId: 'sealed-workspace',
  packageRoot,
  stateRoot: join(workspace, 'state'),
  controlRoot: join(workspace, 'control'),
  credentialRoot: join(workspace, 'credentials'),
  launcher: join(bundle, 'native/ability-launcher'),
  runtimes,
  installer,
  storage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('No credentials');
    },
    decryptString: () => {
      throw new Error('No credentials');
    },
  },
  session: () => 'sealed-session',
  binding: async () => structuredClone(binding),
  authorize: async () => structuredClone(binding),
  open: async () => {
    throw new Error('No browser');
  },
});
try {
  const signal = new AbortController().signal;
  const pkg = await host.install(review, signal);
  binding = {
    id: randomUUID(),
    dotId: 'sealed-dot',
    digest: pkg.digest,
    manifest: pkg.manifest,
    grants: [],
    settings: {},
    revision: 1,
    enabled: true,
    restored: false,
    approvedAt: Date.now(),
  };
  const command = runtime.hostCommandSchema.parse(
    JSON.parse(
      JSON.stringify({
        type: 'invoke',
        binding,
        package: {
          digest: pkg.digest,
          descriptor: pkg.descriptor,
          manifest: pkg.manifest,
          files: pkg.files,
        },
        request: {
          context: {
            workspaceId: 'sealed-workspace',
            sessionId: 'sealed-session',
            dotId: binding.dotId,
            bindingId: binding.id,
            digest: pkg.digest,
            grantRevision: 1,
            invocationId: randomUUID(),
            threadId: 'sealed-thread',
            tool: 'run',
          },
          arguments: {},
          settings: {},
        },
      }),
    ),
  );
  const outcome = await host.invoke(command, signal);
  assert.deepEqual(outcome, {
    status: 'success',
    visibility: 'model-visible',
    value: 42,
  });
  const name =
    pkg.manifest.entrypoint.runtime === 'javascript'
      ? 'node'
      : pkg.manifest.entrypoint.runtime;
  const state = join(
    workspace,
    'state',
    sha(JSON.stringify(['sealed-workspace', binding.id])),
  );
  assert.equal(await readFile(join(state, 'verified'), 'utf8'), name);
  console.log(
    JSON.stringify({
      runtime: name,
      digest: pkg.digest,
      outcome,
      transport: 'offline-fixture',
      bundle,
    }),
  );
} finally {
  await host.stop();
}
