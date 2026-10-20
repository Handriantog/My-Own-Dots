import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { WorkspaceBackend } from '../../src/desktop/host/workspace-backend.js';
import { randomUUID } from 'node:crypto';
import { saveJournal } from '../../src/server/storage/restore-journal.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function fixture(script?: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'dots-owned-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'bundle');
  const workspace = path.join(root, 'workspace');
  await mkdir(path.join(bundle, 'server'), { recursive: true });
  await mkdir(workspace);
  const port = await freePort();
  await writeFile(
    path.join(workspace, '.env'),
    `PORT=${port}\nCONVERSATION_BACKEND=intelligence\nDATABASE_PATH=relative/state.sqlite\n`,
  );
  await writeFile(
    path.join(bundle, 'server/index.js'),
    script ??
      `
const http = require('node:http');
const server = http.createServer((req,res) => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({service:'my-own-dots',protocol:1,workspaceId:process.env.DOTS_WORKSPACE_ID,pythonEnvironment:process.env.UV_PROJECT_ENVIRONMENT})); });
server.listen(Number(process.env.PORT), process.env.HOST);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`,
  );
  const backend = new WorkspaceBackend({
    bundle,
    data: path.join(root, 'data'),
    sourceRoot: workspace,
    environment: {},
    startupTimeoutMs: 2000,
    shutdownTimeoutMs: 300,
  });
  cleanups.push(() => backend.stop());
  return { backend, root, bundle, workspace, port };
}
describe('workspace backend ownership', () => {
  it('awaits host recovery worker before reading any selected workspace', async () => {
    const f = await fixture();
    const recoverStorage = vi.fn(async () => {
      throw new Error('Recovery worker rejected journal');
    });
    const backend = new WorkspaceBackend({
      bundle: f.bundle,
      data: path.join(f.root, 'worker-profile'),
      sourceRoot: f.workspace,
      environment: {},
      recoverStorage,
    });
    cleanups.push(() => backend.stop());
    await expect(backend.start()).rejects.toThrow(
      'Recovery worker rejected journal',
    );
    expect(recoverStorage).toHaveBeenCalledOnce();
    expect(backend.configuration).toBeUndefined();
  });
  it('reconciles an interrupted restore before opening the selected workspace', async () => {
    const { backend, root, workspace, port } = await fixture();
    const data = path.join(root, 'data');
    const interrupted = path.join(root, 'incomplete-restore');
    await mkdir(data);
    await mkdir(interrupted);
    await writeFile(
      path.join(interrupted, '.env'),
      `PORT=${port}\nCONVERSATION_BACKEND=intelligence\n`,
    );
    const operationId = randomUUID();
    await writeFile(path.join(interrupted, '.restore-owner'), operationId);
    await writeFile(
      path.join(data, 'workspace-location.json'),
      JSON.stringify({ directory: interrupted }),
    );
    await saveJournal(data, {
      version: 1,
      operationId,
      phase: 'switching',
      createdAt: Date.now(),
      directory: interrupted,
      previousSelection: JSON.stringify({ directory: workspace }),
      files: [],
    });
    await backend.start();
    expect(backend.configuration?.workspace).toBe(workspace);
    expect(
      JSON.parse(
        await readFile(path.join(data, 'workspace-location.json'), 'utf8'),
      ).directory,
    ).toBe(workspace);
  });
  it('starts the bundled backend in its configured workspace and stops only its child', async () => {
    const { backend, workspace, port } = await fixture();
    const stages: (string | undefined)[] = [];
    backend.subscribe((status) => stages.push(status.stage));
    const state = await backend.start();
    expect(state).toMatchObject({
      url: `http://127.0.0.1:${port}`,
      owned: true,
    });
    expect(backend.configuration?.database).toBe(
      path.join(workspace, 'relative/state.sqlite'),
    );
    expect(backend.status.phase).toBe('ready');
    expect(stages.filter(Boolean)).toEqual([
      'workspace',
      'workspace',
      'services',
      'backend',
      'ready',
    ]);
    await backend.stop();
    await expect(fetch(`${state.url}/api/desktop/identity`)).rejects.toThrow();
  });
  it('reuses positively identified services without stopping them', async () => {
    const { backend, bundle, workspace, root } = await fixture();
    const state = await backend.start();
    const attached = new WorkspaceBackend({
      bundle,
      data: path.join(root, 'other'),
      sourceRoot: workspace,
      environment: {},
    });
    expect(await attached.start()).toMatchObject({
      url: state.url,
      owned: false,
    });
    await attached.stop();
    expect((await fetch(`${state.url}/api/desktop/identity`)).ok).toBe(true);
  });
  it('refuses an occupied address without Dots identity instead of choosing another port', async () => {
    const { backend, port } = await fixture();
    const server = httpServer((_req, res) => res.end('{}'));
    await new Promise<void>((resolve) =>
      server.listen(port, '127.0.0.1', resolve),
    );
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    await expect(backend.start()).rejects.toThrow(/occupied|conflict/i);
    expect(backend.status.phase).toBe('error');
  });
  it('reports early child exit promptly without leaking child output', async () => {
    const { backend } = await fixture(
      "console.error('password=hidden-secret'); process.exit(3)",
    );
    await expect(backend.start()).rejects.toThrow(/exited.*3/i);
    expect(backend.status.message).not.toContain('hidden-secret');
  });
  it('accepts explicit local service attachment but rejects remote URLs', async () => {
    const { backend, bundle, root } = await fixture();
    const state = await backend.start();
    const attached = new WorkspaceBackend({
      bundle,
      data: root,
      environment: { DOTS_WORKSPACE_URL: state.url },
    });
    expect(await attached.start()).toMatchObject({
      owned: false,
      url: state.url,
    });
    await attached.stop();
    const remote = new WorkspaceBackend({
      bundle,
      data: root,
      environment: { DOTS_WORKSPACE_URL: 'https://example.com' },
    });
    await expect(remote.start()).rejects.toThrow(/loopback|local/i);
  });
  it('preserves absolute databases and saves configuration with private permissions', async () => {
    const { backend, workspace, root } = await fixture();
    const database = path.join(root, 'elsewhere.sqlite');
    await backend.configure({ DATABASE_PATH: database, PORT: '4329' });
    expect(await readFile(path.join(workspace, '.env'), 'utf8')).toContain(
      database,
    );
    expect(backend.configuration?.database).toBe(database);
    await expect(
      backend.configure({ NODE_OPTIONS: '--inspect' }),
    ).rejects.toThrow(/configuration/i);
  });
  it('bounds startup and kills a child that never becomes ready', async () => {
    const { bundle, workspace, root } = await fixture(
      'setInterval(()=>{}, 1000)',
    );
    const backend = new WorkspaceBackend({
      bundle,
      data: root,
      sourceRoot: workspace,
      environment: {},
      startupTimeoutMs: 100,
      shutdownTimeoutMs: 100,
    });
    cleanups.push(() => backend.stop());
    await expect(backend.start()).rejects.toThrow(/timed out/i);
  });
});

it('persists an explicitly chosen existing workspace without moving its data', async () => {
  const { backend, root, bundle, workspace } = await fixture();
  const selected = path.join(root, 'selected');
  await mkdir(selected);
  await writeFile(
    path.join(selected, '.env'),
    'PORT=4567\nDATABASE_PATH=kept.sqlite\n',
  );
  await backend.setWorkspaceDirectory(selected);
  const reopened = new WorkspaceBackend({
    bundle,
    data: path.join(root, 'data'),
    sourceRoot: workspace,
    environment: {},
  });
  await reopened.configure({ PORT: '4568' });
  expect(reopened.configuration?.database).toBe(
    path.join(selected, 'kept.sqlite'),
  );
  expect(await readFile(path.join(workspace, '.env'), 'utf8')).not.toContain(
    '4568',
  );
});

it('keeps the SQLite workspace available with an actionable warning when Docker is missing', async () => {
  const { bundle, workspace, root } = await fixture();
  const pgPort = await freePort();
  const backend = new WorkspaceBackend({
    bundle,
    data: root,
    sourceRoot: workspace,
    environment: {
      PATH: '/nonexistent',
      DOCKER_BIN: '/nonexistent/docker',
      CONVERSATION_BACKEND: 'local',
    },
    startupTimeoutMs: 2000,
  });
  cleanups.push(() => backend.stop());
  await backend.configure({
    CONVERSATION_BACKEND: 'local',
    LOCAL_DATABASE_URL: `postgresql://dots:secret@127.0.0.1:${pgPort}/dots`,
    LOCAL_POSTGRES_PORT: String(pgPort),
    LOCAL_POSTGRES_PASSWORD: 'secret',
  });
  const state = await backend.start();
  expect(state).toMatchObject({
    owned: true,
    warning: expect.stringMatching(/Docker/),
  });
  expect(state.warning).not.toContain('secret');
  expect(backend.status.phase).toBe('ready');
});

it('creates a private persistent configuration under userData on a new installation', async () => {
  const { root, bundle } = await fixture();
  const backend = new WorkspaceBackend({
    bundle,
    data: path.join(root, 'new-profile'),
    environment: {},
  });
  await backend.configure({ CONVERSATION_BACKEND: 'intelligence' });
  const config = backend.configuration!;
  expect(config.workspace).toBe(path.join(root, 'new-profile/workspace'));
  expect(config.database).toBe(
    path.join(root, 'new-profile/workspace/data/opendots.sqlite'),
  );
  const values = await readFile(config.envFile, 'utf8');
  expect(values).toMatch(/OWNER_TOKEN=[a-f0-9]{64}/);
  expect(values).toMatch(/LOCAL_POSTGRES_PASSWORD=[a-f0-9]{48}/);
  expect(values).toMatch(/COMPOSE_PROJECT_NAME=dots-[a-f0-9]{16}/);
});

it('serializes concurrent starts and cancels a pending launch on stop', async () => {
  const { backend } = await fixture();
  const [first, second] = await Promise.all([backend.start(), backend.start()]);
  expect(first).toEqual(second);
  await backend.stop();
  const pending = backend.start();
  await backend.stop();
  await expect(pending).rejects.toThrow(/cancelled/);
  expect(backend.status.phase).toBe('stopped');
});

it('cancels an owned Docker startup helper when quitting during dependency preparation', async () => {
  const { bundle, workspace, root } = await fixture();
  const pgPort = await freePort();
  await mkdir(path.join(root, 'bin'));
  await writeFile(
    path.join(root, 'bin/docker'),
    `#!${process.execPath}\nsetTimeout(()=>process.exit(1),900)\n`,
    { mode: 0o755 },
  );
  const backend = new WorkspaceBackend({
    bundle,
    data: root,
    sourceRoot: workspace,
    environment: { PATH: path.join(root, 'bin') },
    shutdownTimeoutMs: 50,
  });
  cleanups.push(() => backend.stop());
  await backend.configure({
    CONVERSATION_BACKEND: 'local',
    LOCAL_DATABASE_URL: `postgresql://dots:secret@127.0.0.1:${pgPort}/dots`,
    LOCAL_POSTGRES_PORT: String(pgPort),
    LOCAL_POSTGRES_PASSWORD: 'secret',
  });
  const preparation = new Promise<void>((resolve) =>
    backend.subscribe((status) => {
      if (status.message.includes('Starting local PostgreSQL')) resolve();
    }),
  );
  const pending = backend.start();
  const rejected = expect(pending).rejects.toThrow(/cancelled/);
  await preparation;
  const before = Date.now();
  await backend.stop();
  await rejected;
  expect(Date.now() - before).toBeLessThan(400);
});

it('preserves quotes and literal backslashes when saving dotenv configuration', async () => {
  const { backend, root } = await fixture();
  const database = path.join(root, "quote'and\\nliteral.sqlite");
  await backend.configure({ DATABASE_PATH: database });
  expect(backend.configuration?.database).toBe(database);
});

it('keeps the Integrator default uv environment outside the signed application', async () => {
  const { backend, workspace } = await fixture();
  const connection = await backend.start();
  const response = await fetch(`${connection.url}/api/desktop/identity`);
  expect(await response.json()).toMatchObject({
    pythonEnvironment: path.join(workspace, 'integrations/llm/.venv'),
  });
});

it.each([undefined, 'owner-selected-project'])(
  'preserves legacy Compose storage unless explicitly configured (%s)',
  async (project) => {
    const { bundle, workspace, root } = await fixture();
    const pgPort = await freePort();
    await mkdir(path.join(root, 'bin'));
    const log = path.join(root, 'docker-arguments.json');
    await writeFile(
      path.join(root, 'bin/docker'),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.DOCKER_ARGUMENTS,JSON.stringify(process.argv.slice(2))); process.exit(1);\n`,
      { mode: 0o755 },
    );
    const backend = new WorkspaceBackend({
      bundle,
      data: root,
      sourceRoot: workspace,
      environment: {
        PATH: path.join(root, 'bin'),
        DOCKER_ARGUMENTS: log,
        ...(project ? { COMPOSE_PROJECT_NAME: project } : {}),
      },
    });
    cleanups.push(() => backend.stop());
    await backend.configure({
      CONVERSATION_BACKEND: 'local',
      LOCAL_DATABASE_URL: `postgresql://dots:fixture@127.0.0.1:${pgPort}/dots`,
      LOCAL_POSTGRES_PORT: String(pgPort),
      LOCAL_POSTGRES_PASSWORD: 'fixture',
    });
    await backend.start();
    const args = JSON.parse(await readFile(log, 'utf8')) as string[];
    expect(args[args.indexOf('--project-name') + 1]).toBe(
      project || 'my-own-dots-local',
    );
  },
);

it('does not cache a successful readiness response that completes after stop', async () => {
  const { bundle, workspace, root } = await fixture(`
const http=require('node:http');
const server=http.createServer((req,res)=>{res.end(JSON.stringify({service:'my-own-dots',protocol:1,workspaceId:process.env.DOTS_WORKSPACE_ID}));});
server.listen(Number(process.env.PORT),process.env.HOST);
process.on('SIGTERM',()=>setTimeout(()=>server.close(()=>process.exit(0)),100));
`);
  const backend = new WorkspaceBackend({
    bundle,
    data: root,
    sourceRoot: workspace,
    environment: {},
    startupTimeoutMs: 2000,
    shutdownTimeoutMs: 500,
  });
  cleanups.push(() => backend.stop());
  const original = globalThis.fetch;
  let intercepted = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observed!: () => void;
  const observedResponse = new Promise<void>((resolve) => {
    observed = resolve;
  });
  globalThis.fetch = async (...args) => {
    const response = await original(...args);
    if (!intercepted && response.ok) {
      intercepted = true;
      observed();
      await held;
    }
    return response;
  };
  try {
    const startup = backend.start().then(
      (value) => ({ value, error: undefined }),
      (error) => ({ value: undefined, error }),
    );
    await observedResponse;
    const stopping = backend.stop();
    release();
    const result = await startup;
    await stopping;
    expect(result.value).toBeUndefined();
    expect(result.error).toMatchObject({
      message: expect.stringMatching(/cancelled/),
    });
    const fresh = await backend.start();
    expect((await original(`${fresh.url}/api/desktop/identity`)).ok).toBe(true);
  } finally {
    release();
    globalThis.fetch = original;
  }
});

it('applies a changed token when detaching and reattaching without killing the external service', async () => {
  const { backend: owner, bundle, workspace, root } = await fixture();
  const service = await owner.start();
  const attached = new WorkspaceBackend({
    bundle,
    data: root,
    sourceRoot: workspace,
    environment: {},
  });
  cleanups.push(() => attached.stop());
  const old = await attached.start();
  await attached.configure({ OWNER_TOKEN: 'changed-token' });
  const fresh = await attached.start();
  expect(fresh).not.toBe(old);
  expect(fresh).toMatchObject({ owned: false, ownerToken: 'changed-token' });
  expect((await fetch(`${service.url}/api/desktop/identity`)).ok).toBe(true);
});
it('rejects invalid configuration before stopping an owned backend or writing its file', async () => {
  const { backend, workspace } = await fixture();
  const connection = await backend.start();
  const before = await readFile(path.join(workspace, '.env'), 'utf8');
  await expect(backend.configure({ PORT: 'not-a-port' })).rejects.toThrow(
    /PORT/,
  );
  expect(await backend.start()).toBe(connection);
  expect(await readFile(path.join(workspace, '.env'), 'utf8')).toBe(before);
});
it.skipIf(process.platform !== 'darwin')(
  'finds user-local prerequisites with a native minimal PATH and preserves explicit executable overrides',
  async () => {
    const { bundle, workspace, root } = await fixture(`
const {spawnSync}=require('node:child_process');
const http=require('node:http');
const server=http.createServer((req,res)=>res.end(JSON.stringify({service:'my-own-dots',protocol:1,workspaceId:process.env.DOTS_WORKSPACE_ID,uv:spawnSync('uv',[],{encoding:'utf8'}).stdout,provider:spawnSync(process.env.CODEX_BIN,[],{encoding:'utf8'}).stdout,path:process.env.PATH})));
server.listen(Number(process.env.PORT),process.env.HOST);
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`);
    const bin = path.join(root, '.local/bin');
    await mkdir(bin, { recursive: true });
    for (const name of ['docker', 'uv', 'custom-codex'])
      await writeFile(
        path.join(bin, name),
        `#!${process.execPath}\nprocess.stdout.write('${name} fixture');`,
        { mode: 0o755 },
      );
    const backend = new WorkspaceBackend({
      bundle,
      data: root,
      sourceRoot: workspace,
      environment: {
        HOME: root,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        CODEX_BIN: path.join(bin, 'custom-codex'),
      },
    });
    cleanups.push(() => backend.stop());
    const pgPort = await freePort();
    await backend.configure({
      CONVERSATION_BACKEND: 'local',
      LOCAL_DATABASE_URL: `postgresql://dots:fixture@127.0.0.1:${pgPort}/dots`,
      LOCAL_POSTGRES_PORT: String(pgPort),
      LOCAL_POSTGRES_PASSWORD: 'fixture',
    });
    const connection = await backend.start();
    expect(connection.warning).toBeUndefined();
    const result = await (
      await fetch(`${connection.url}/api/desktop/identity`)
    ).json();
    expect(result).toMatchObject({
      uv: 'uv fixture',
      provider: 'custom-codex fixture',
    });
    expect(result.path).toContain('/opt/homebrew/bin');
    expect(result.path).toContain('/usr/local/bin');
    expect(result.path).toContain(
      '/Applications/Docker.app/Contents/Resources/bin',
    );
  },
);
it('retries failed Docker preparation after stop and clears the degraded status on success', async () => {
  const { bundle, workspace, root } = await fixture();
  const docker = path.join(root, 'docker-fixture');
  const log = path.join(root, 'attempts');
  await writeFile(
    docker,
    `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.ATTEMPTS,'attempt\\n');process.exit(fs.existsSync(process.env.AVAILABLE)?0:1);`,
    { mode: 0o755 },
  );
  const backend = new WorkspaceBackend({
    bundle,
    data: root,
    sourceRoot: workspace,
    environment: {
      DOCKER_BIN: docker,
      ATTEMPTS: log,
      AVAILABLE: path.join(root, 'available'),
    },
  });
  cleanups.push(() => backend.stop());
  const pgPort = await freePort();
  await backend.configure({
    CONVERSATION_BACKEND: 'local',
    LOCAL_DATABASE_URL: `postgresql://dots:fixture@127.0.0.1:${pgPort}/dots`,
    LOCAL_POSTGRES_PORT: String(pgPort),
    LOCAL_POSTGRES_PASSWORD: 'fixture',
  });
  expect((await backend.start()).warning).toMatch(/Docker/);
  expect(backend.status).toMatchObject({
    phase: 'ready',
    warning: expect.stringMatching(/Docker/),
  });
  await writeFile(path.join(root, 'available'), 'yes');
  await backend.stop();
  expect((await backend.start()).warning).toBeUndefined();
  expect(backend.status).not.toHaveProperty('warning');
  expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(2);
});
it('does not recreate a missing explicitly selected workspace', async () => {
  const f = await fixture();
  const selected = path.join(f.root, 'missing-drive', 'workspace');
  await mkdir(path.join(f.root, 'data'));
  await writeFile(
    path.join(f.root, 'data/workspace-location.json'),
    JSON.stringify({ directory: selected }),
  );
  await expect(f.backend.start()).rejects.toThrow(
    /missing|unavailable|restore/i,
  );
  await expect(readFile(path.join(selected, '.env'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(
    JSON.parse(
      await readFile(path.join(f.root, 'data/workspace-location.json'), 'utf8'),
    ).directory,
  ).toBe(selected);
});
it('uses a persisted manifest identity without changing a legacy workspace backend', async () => {
  const f = await fixture();
  const id = randomUUID();
  await writeFile(
    path.join(f.workspace, 'workspace.json'),
    JSON.stringify({
      version: 1,
      id,
      ownerId: 'opendots-owner',
      storage: 'legacy-postgres',
      schema: 1,
    }),
  );
  const state = await f.backend.start();
  expect(
    (await (await fetch(state.url + '/api/desktop/identity')).json())
      .workspaceId,
  ).toBe(id);
});
it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'reports a read-only selected workspace without changing its configuration',
  async () => {
    const f = await fixture();
    const original = await readFile(path.join(f.workspace, '.env'), 'utf8');
    await chmod(f.workspace, 0o500);
    try {
      await expect(f.backend.start()).rejects.toThrow(/not writable/);
      expect(await readFile(path.join(f.workspace, '.env'), 'utf8')).toBe(
        original,
      );
      expect(f.backend.status.phase).toBe('error');
    } finally {
      await chmod(f.workspace, 0o700);
    }
  },
);
it('rejects a mismatched manifest owner before starting a backend', async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.workspace, 'workspace.json'),
    JSON.stringify({
      version: 1,
      id: randomUUID(),
      ownerId: 'different-owner',
      storage: 'legacy-postgres',
      schema: 1,
    }),
  );
  const config =
    (await readFile(path.join(f.workspace, '.env'), 'utf8')) +
    'OWNER_ID=config-owner\n';
  await writeFile(path.join(f.workspace, '.env'), config);
  await expect(f.backend.start()).rejects.toThrow(/owner does not match/);
  expect(await readFile(path.join(f.workspace, '.env'), 'utf8')).toBe(config);
});
