import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  writeFile,
  chmod,
  stat,
  open,
  rm,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { connect } from 'node:net';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { nativeExecutableEnvironment } from '../../../scripts/native-executable-environment.mjs';
import { workspaceIdentity } from '../../server/workspace-identity.js';
import { RestoreService } from '../../server/storage/restore.js';
import {
  readSelection,
  writeSelection,
  withRestoreLock,
} from '../../server/storage/restore-journal.js';
import type { WorkspaceStatus } from '../shared/workspace-contract.js';
import {
  resolveWorkspaceLocation,
  type PortableLayout,
} from './workspace-location.js';
import {
  readWorkspaceManifest,
  sqliteStorageSchema,
} from '../../shared/workspace-manifest.js';

export interface WorkspaceBackendOptions {
  bundle: string;
  data: string;
  sourceRoot?: string;
  /** Process environment override, useful for isolated launchers and tests. */
  environment?: NodeJS.ProcessEnv;
  executable?: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  /** Native host runs potentially large interrupted-restore verification off its main thread. */
  recoverStorage?: () => Promise<void>;
  portableRoot?: string;
  portablePaths?: PortableLayout;
  portableMachineId?: string;
}
export interface WorkspaceBackendConnection {
  url: string;
  ownerToken?: string;
  owned: boolean;
  warning?: string;
}
export type WorkspaceBackendStatus = WorkspaceStatus;
export interface WorkspaceBackendConfiguration {
  workspace: string;
  envFile: string;
  database: string;
  workspaceId?: string;
  storageEngine?: 'legacy-postgres' | 'sqlite';
}
const editable = new Set([
  'HOST',
  'PORT',
  'DATABASE_PATH',
  'OWNER_TOKEN',
  'CONVERSATION_BACKEND',
  'LOCAL_DATABASE_URL',
  'LOCAL_POSTGRES_PORT',
  'LOCAL_POSTGRES_PASSWORD',
  'COMPOSE_PROJECT_NAME',
  'LLM_BACKEND',
  'LLM_PROVIDER',
  'LLM_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_BASE_URL',
  'MYOWN_LLM_PYTHON',
  'CODEX_BIN',
  'DOCKER_BIN',
  'UV_BIN',
  'AGENT_BIN',
  'LOCAL_VOICE_ENABLED',
  'LOCAL_VOICE_PYTHON',
  'LOCAL_VOICE_ASSETS',
  'INTELLIGENCE_API_KEY',
]);
function configurationLine(key: string, value: string) {
  const quote = ["'", '`', '"'].find(
    (candidate) =>
      !value.includes(candidate) &&
      parseEnv(`VALUE=${candidate}${value}${candidate}`).VALUE === value,
  );
  if (!quote)
    throw new Error(
      'Configuration values cannot contain all three quote styles.',
    );
  return `${key}=${quote}${value}${quote}`;
}
/** Validate before closing documents, stopping services, or changing the configuration file. */
export function validateWorkspaceConfiguration(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    if (
      !editable.has(key) ||
      typeof value !== 'string' ||
      /[\n\r\0]/.test(value)
    )
      throw new Error('Unsupported workspace configuration value.');
    configurationLine(key, value);
  }
  if (values.HOST && !['127.0.0.1', 'localhost', '::1'].includes(values.HOST))
    throw new Error('Desktop HOST must be a loopback address.');
  for (const key of ['PORT', 'LOCAL_POSTGRES_PORT']) {
    if (
      values[key] &&
      (!Number.isInteger(Number(values[key])) ||
        Number(values[key]) < 1 ||
        Number(values[key]) > 65535)
    )
      throw new Error(`${key} must be an integer from 1 to 65535.`);
  }
  if (
    values.CONVERSATION_BACKEND &&
    !['local', 'intelligence'].includes(values.CONVERSATION_BACKEND)
  )
    throw new Error('CONVERSATION_BACKEND must be local or intelligence.');
  if (values.LOCAL_DATABASE_URL) {
    try {
      const url = new URL(values.LOCAL_DATABASE_URL);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname)
        throw new Error();
    } catch {
      throw new Error(
        'LOCAL_DATABASE_URL is malformed. Use a PostgreSQL connection URL.',
      );
    }
  }
}
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function localUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Workspace URL must be a valid loopback HTTP address.');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Workspace URL must be a loopback HTTP address without credentials or paths.',
    );
  return url.origin;
}
async function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
export class WorkspaceBackend {
  private child?: ChildProcess;
  private preparationChild?: ChildProcess;
  private active?: WorkspaceBackendConnection;
  private pending?: Promise<WorkspaceBackendConnection>;
  private generation = 0;
  private listeners = new Set<(status: WorkspaceBackendStatus) => void>();
  private current: WorkspaceBackendStatus = {
    phase: 'idle',
    message: 'Workspace has not started.',
    stage: 'workspace',
  };
  private config?: WorkspaceBackendConfiguration;
  constructor(private readonly options: WorkspaceBackendOptions) {}
  get status() {
    return { ...this.current };
  }
  get configuration() {
    return this.config ? { ...this.config } : undefined;
  }
  subscribe(listener: (status: WorkspaceBackendStatus) => void) {
    this.listeners.add(listener);
    listener(this.status);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private update(
    phase: WorkspaceBackendStatus['phase'],
    message: string,
    warning?: string,
    stage?: WorkspaceStatus['stage'],
  ) {
    const nextStage = stage ?? (phase === 'ready' ? 'ready' : undefined);
    this.current = {
      phase,
      message,
      ...(warning ? { warning } : {}),
      ...(nextStage ? { stage: nextStage } : {}),
    };
    for (const listener of this.listeners) listener(this.status);
  }
  private async load() {
    if (this.options.recoverStorage) await this.options.recoverStorage();
    else
      await new RestoreService({
        profile: this.options.data,
        stopWorkspace: () => this.stop(),
      }).recover();
    const inherited = this.options.environment ?? process.env;
    let selected: string | undefined;
    try {
      const saved = await readSelection(this.options.data);
      const selection = saved
        ? (JSON.parse(saved) as { directory?: unknown })
        : undefined;
      if (
        selection &&
        (typeof selection.directory !== 'string' ||
          !path.isAbsolute(selection.directory))
      )
        throw new Error('Saved workspace path is invalid');
      selected = selection?.directory as string | undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(
          'Saved workspace location could not be read. Choose the workspace folder again.',
          { cause: error },
        );
    }
    const explicit =
      inherited.DOTS_WORKSPACE_DIR ||
      selected ||
      (this.options.portableRoot ? undefined : this.options.sourceRoot);
    const { workspace } = resolveWorkspaceLocation({
      platform: process.platform,
      home: homedir(),
      localAppData: inherited.LOCALAPPDATA,
      xdgDataHome: inherited.XDG_DATA_HOME,
      electronData: this.options.data,
      selected: explicit ? path.resolve(explicit) : undefined,
      executable: this.options.executable ?? process.execPath,
      portableRoot: this.options.portableRoot,
      portablePaths: this.options.portablePaths,
    });
    if (explicit) {
      try {
        if (!(await stat(workspace)).isDirectory())
          throw new Error('Not a directory');
      } catch (error) {
        throw new Error(
          `Selected workspace is missing or unavailable: ${workspace}. Reconnect the disk or choose its existing folder.`,
          { cause: error },
        );
      }
    } else await mkdir(workspace, { recursive: true });
    const probe = path.join(workspace, `.dots-workspace-check-${randomUUID()}`);
    try {
      const handle = await open(probe, 'wx', 0o600);
      try {
        await handle.sync();
      } finally {
        await handle.close();
        await rm(probe, { force: true });
      }
    } catch (error) {
      throw new Error(`Workspace is not writable: ${workspace}`, {
        cause: error,
      });
    }
    const manifest = await readWorkspaceManifest(workspace);
    if (
      manifest &&
      (manifest.storage === 'sqlite'
        ? manifest.schema > sqliteStorageSchema
        : manifest.schema !== 1)
    )
      throw new Error(
        'This workspace requires a compatible SQLite storage runtime',
      );
    const envFile = path.join(workspace, '.env');
    let contents: string;
    try {
      contents = await readFile(envFile, 'utf8');
    } catch (error) {
      if (manifest)
        throw new Error(
          'Selected workspace configuration (.env) is missing or unreadable; restore it before retrying.',
          { cause: error },
        );
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(
          'Workspace .env could not be read. Check folder permissions.',
          { cause: error },
        );
      const password = randomBytes(24).toString('hex');
      contents = `HOST=127.0.0.1\nPORT=4310\nDATABASE_PATH=data/opendots.sqlite\nOWNER_TOKEN=${randomBytes(32).toString('hex')}\nCONVERSATION_BACKEND=local\nCOMPOSE_PROJECT_NAME=dots-${randomBytes(8).toString('hex')}\nLLM_BACKEND=subscription\nLLM_PROVIDER=codex\nLOCAL_POSTGRES_PASSWORD=${password}\nLOCAL_POSTGRES_PORT=5434\nLOCAL_DATABASE_URL=postgresql://dots:${password}@127.0.0.1:5434/dots\nDO_NOT_TRACK=1\n`;
      await writeFile(envFile, contents, { mode: 0o600, flag: 'wx' });
    }
    let values: NodeJS.ProcessEnv;
    try {
      values = parseEnv(contents);
    } catch {
      throw new Error(
        'Workspace .env is malformed. Correct the configuration and retry.',
      );
    }
    const env = nativeExecutableEnvironment({ ...inherited, ...values });
    if (manifest) {
      if (env.OWNER_ID && env.OWNER_ID !== manifest.ownerId)
        throw new Error(
          'Workspace manifest owner does not match its configuration',
        );
      env.OWNER_ID = manifest.ownerId;
    }
    const database = path.resolve(
      workspace,
      env.DATABASE_PATH || 'data/opendots.sqlite',
    );
    if (manifest?.storage === 'sqlite') {
      if (!(await stat(database).catch(() => undefined))?.isFile())
        throw new Error(
          'Selected SQLite workspace database is missing; reconnect its disk or restore a backup.',
        );
      if ((env.CONVERSATION_BACKEND || 'local') !== 'local')
        throw new Error(
          'A SQLite workspace requires the local conversation backend.',
        );
      delete env.LOCAL_DATABASE_URL;
    }
    this.config = {
      workspace,
      envFile,
      database,
      storageEngine: manifest?.storage ?? 'legacy-postgres',
      ...(manifest ? { workspaceId: manifest.id } : {}),
    };
    // Once a default has been opened, a missing disk is a recovery event rather
    // than permission to silently create another empty workspace.
    if (!explicit) await writeSelection(this.options.data, workspace);
    return { env, contents };
  }
  /** Host must call this only after an explicit native directory choice. Existing files stay in place. */
  async setWorkspaceDirectory(directory: string) {
    if (!path.isAbsolute(directory) || !(await stat(directory)).isDirectory())
      throw new Error('Choose an existing workspace folder.');
    await this.stop();
    await mkdir(this.options.data, { recursive: true });
    await withRestoreLock(this.options.data, () =>
      writeSelection(this.options.data, directory),
    );
    this.config = undefined;
    await this.load();
    this.update(
      'idle',
      'Workspace folder selected. Start or retry to connect.',
    );
  }
  async configure(values: Record<string, string>) {
    validateWorkspaceConfiguration(values);
    // stop() detaches external connections without signalling any external process.
    if (this.active || this.pending) await this.stop();
    const { contents } = await this.load();
    let next = contents;
    for (const [key, value] of Object.entries(values)) {
      const line = configurationLine(key, value);
      const pattern = new RegExp(`^${key}=.*$`, 'm');
      next = pattern.test(next)
        ? next.replace(pattern, () => line)
        : `${next.trimEnd()}\n${line}\n`;
    }
    await writeFile(this.config!.envFile, next, { mode: 0o600 });
    await chmod(this.config!.envFile, 0o600);
    await this.load();
  }
  start(): Promise<WorkspaceBackendConnection> {
    if (this.active) return Promise.resolve(this.active);
    if (this.pending) return this.pending;
    const generation = ++this.generation;
    this.pending = this.launch(generation)
      .catch(async (error: unknown) => {
        await this.terminateChild();
        const message =
          error instanceof Error ? error.message : 'Workspace startup failed.';
        this.update('error', message);
        throw new Error(message);
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private async identity(url: string, ownerToken?: string) {
    try {
      const response = await fetch(`${url}/api/desktop/identity`, {
        headers: ownerToken ? { authorization: `Bearer ${ownerToken}` } : {},
        signal: AbortSignal.timeout(600),
        redirect: 'error',
      });
      if (!response.ok) return undefined;
      const value = (await response.json()) as {
        service?: string;
        protocol?: number;
        workspaceId?: string;
      };
      return value.service === 'my-own-dots' && value.protocol === 1
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  }
  private async launch(
    generation: number,
  ): Promise<WorkspaceBackendConnection> {
    this.update(
      'starting',
      'Reading workspace configuration…',
      undefined,
      'workspace',
    );
    const { env } = await this.load();
    if (generation !== this.generation)
      throw new Error('Workspace startup was cancelled.');
    let ownerToken = env.OWNER_TOKEN || undefined;
    if (env.DOTS_WORKSPACE_URL) {
      const url = localUrl(env.DOTS_WORKSPACE_URL);
      let identified = !!(await this.identity(url, ownerToken));
      if (!identified) {
        try {
          const response = await fetch(`${url}/api/state`, {
            headers: ownerToken
              ? { authorization: `Bearer ${ownerToken}` }
              : {},
            signal: AbortSignal.timeout(1500),
            redirect: 'error',
          });
          const state = (await response.json()) as {
            settings?: { paused?: boolean };
            tasks?: unknown[];
            memories?: unknown[];
          };
          identified =
            response.ok &&
            typeof state.settings?.paused === 'boolean' &&
            Array.isArray(state.tasks) &&
            Array.isArray(state.memories);
        } catch {
          /* Recovery below is intentionally free of provider credentials. */
        }
      }
      if (!identified)
        throw new Error(
          'The explicit local workspace could not be identified or unlocked. Check its URL and OWNER_TOKEN.',
        );
      if (generation !== this.generation)
        throw new Error('Workspace startup was cancelled.');
      this.active = { url, ownerToken, owned: false };
      this.update('ready', 'Connected to your existing workspace.');
      return this.active;
    }
    const host = env.HOST || '127.0.0.1';
    if (!['127.0.0.1', 'localhost', '::1'].includes(host))
      throw new Error('Desktop HOST must be a loopback address.');
    const port = Number(env.PORT || 4310);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('PORT must be an integer from 1 to 65535.');
    const url = `http://${host === '::1' ? '[::1]' : host}:${port}`;
    await mkdir(path.dirname(this.config!.database), { recursive: true });
    const workspaceId =
      this.config!.workspaceId ?? workspaceIdentity(this.config!.database);
    if (await portOpen(host, port)) {
      if ((await this.identity(url, ownerToken))?.workspaceId !== workspaceId)
        throw new Error(
          'Workspace port is occupied by an unidentified or different service. Stop that service yourself or change PORT; no second runner was started.',
        );
      if (generation !== this.generation)
        throw new Error('Workspace startup was cancelled.');
      this.active = { url, ownerToken, owned: false };
      this.update('ready', 'Connected to your existing workspace.');
      return this.active;
    }
    // Older local workspaces may not configure a token. Authenticate the child
    // we launch without changing their .env or credentials for external services.
    ownerToken ??= randomBytes(32).toString('hex');
    env.OWNER_TOKEN = ownerToken;
    let warning: string | undefined;
    this.update('starting', 'Checking local services…', undefined, 'services');
    try {
      await this.prepareDatabase(env);
    } catch (error) {
      if (
        error instanceof Error &&
        /LOCAL_DATABASE_URL is malformed/.test(error.message)
      )
        throw error;
      warning =
        error instanceof Error
          ? error.message
          : 'Local conversations are unavailable. Check PostgreSQL and Docker setup.';
    }
    if (generation !== this.generation)
      throw new Error('Workspace startup was cancelled.');
    this.update(
      'starting',
      'Starting the bundled workspace backend…',
      warning,
      'backend',
    );
    const previousPython = path.join(
      this.config!.workspace,
      'integrations/llm/.venv',
    );
    const pythonEnvironment =
      env.UV_PROJECT_ENVIRONMENT ||
      ((await stat(previousPython).catch(() => undefined))?.isDirectory()
        ? previousPython
        : path.join(this.options.data, 'integrations/llm/.venv'));
    const child = spawn(
      this.options.executable || process.execPath,
      [path.join(this.options.bundle, 'server/index.js')],
      {
        cwd: this.config!.workspace,
        env: {
          ...env,
          ELECTRON_RUN_AS_NODE: '1',
          UV_PROJECT_ENVIRONMENT: pythonEnvironment,
          NODE_ENV: 'production',
          HOST: host,
          PORT: String(port),
          DATABASE_PATH: this.config!.database,
          DOTS_DESKTOP_API_ONLY: '1',
          DOTS_RUNTIME_ROOT: path.resolve(this.options.bundle),
          DOTS_WORKSPACE_ID: workspaceId,
          DOTS_WORKSPACE_ENV: this.config!.envFile,
          DOTS_PORTABLE_MACHINE_ID: this.options.portableMachineId,
        },
        stdio: 'ignore',
      },
    );
    this.child = child;
    let failure: Error | undefined;
    child.once('error', () => {
      failure = new Error(
        'Bundled Node runtime could not start. Reinstall the application and retry.',
      );
    });
    child.once('exit', (code, signal) => {
      failure = new Error(
        `Workspace backend exited (${code ?? signal ?? 'unknown'}). Check workspace configuration and integration setup, then retry.`,
      );
      if (this.active?.owned && this.child === child) {
        this.active = undefined;
        this.update('error', failure.message);
      }
    });
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 20_000);
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (generation !== this.generation)
        throw new Error('Workspace startup was cancelled.');
      if ((await this.identity(url, ownerToken))?.workspaceId === workspaceId) {
        if (generation !== this.generation || this.child !== child)
          throw new Error('Workspace startup was cancelled.');
        if (failure || child.exitCode !== null || child.signalCode !== null)
          throw (
            failure ?? new Error('Workspace backend exited during startup.')
          );
        this.active = {
          url,
          ownerToken,
          owned: true,
          ...(warning ? { warning } : {}),
        };
        this.update(
          'ready',
          warning ||
            'Workspace is ready. AI and voice integrations can be configured in Settings.',
          warning,
        );
        return this.active;
      }
      await delay(50);
    }
    throw new Error(
      'Workspace startup timed out. Check configuration and integration setup, then retry.',
    );
  }
  private async prepareDatabase(env: NodeJS.ProcessEnv) {
    if (
      this.config?.storageEngine === 'sqlite' ||
      (env.CONVERSATION_BACKEND || 'local') !== 'local' ||
      !env.LOCAL_DATABASE_URL
    )
      return;
    let database: URL;
    try {
      database = new URL(env.LOCAL_DATABASE_URL);
    } catch {
      throw new Error(
        'LOCAL_DATABASE_URL is malformed. Use a PostgreSQL connection URL.',
      );
    }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname))
      return;
    const port = Number(database.port || 5432);
    const host = database.hostname.replace(/^\[|\]$/g, '');
    if (await portOpen(host, port)) return;
    if (
      port !== Number(env.LOCAL_POSTGRES_PORT || 5434) ||
      !env.LOCAL_POSTGRES_PASSWORD
    )
      throw new Error(
        'Configured PostgreSQL is unavailable. Start your database service or update LOCAL_DATABASE_URL.',
      );
    this.update(
      'starting',
      'Starting local PostgreSQL with Docker Compose…',
      undefined,
      'services',
    );
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        env.DOCKER_BIN || 'docker',
        [
          'compose',
          '--project-name',
          env.COMPOSE_PROJECT_NAME || 'my-own-dots-local',
          '--env-file',
          this.config!.envFile,
          '-f',
          path.join(this.options.bundle, 'support/compose.local.yml'),
          'up',
          '-d',
          '--wait',
          '--wait-timeout',
          '40',
        ],
        { cwd: this.config!.workspace, env, stdio: 'ignore' },
      );
      this.preparationChild = child;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(
          new Error(
            'PostgreSQL startup timed out. Open Docker Desktop and retry.',
          ),
        );
      }, 45_000);
      child.once('error', () => {
        clearTimeout(timer);
        reject(
          new Error(
            'Docker is unavailable. Install/open Docker Desktop, or configure an existing PostgreSQL in LOCAL_DATABASE_URL.',
          ),
        );
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else
          reject(
            new Error(
              'Docker could not start PostgreSQL. Open Docker Desktop, check the configured database port, and retry. Existing volumes were preserved.',
            ),
          );
      });
    });
  }
  private async terminateChild() {
    const children = [this.child, this.preparationChild];
    this.child = undefined;
    this.preparationChild = undefined;
    await Promise.all(
      children.map(async (child) => {
        if (!child || child.exitCode !== null || child.signalCode !== null)
          return;
        const wait = (timeout: number) =>
          new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              child.removeListener('exit', finish);
              resolve();
            };
            const timer = setTimeout(finish, timeout);
            child.once('exit', finish);
          });
        const graceful = wait(this.options.shutdownTimeoutMs ?? 5000);
        child.kill('SIGTERM');
        await graceful;
        if (child.exitCode === null && child.signalCode === null) {
          const killed = wait(1000);
          child.kill('SIGKILL');
          await killed;
        }
      }),
    );
  }
  async stop() {
    ++this.generation;
    this.active = undefined;
    await this.terminateChild();
    await this.pending?.catch(() => {});
    this.update('stopped', 'Workspace stopped.');
  }
}
