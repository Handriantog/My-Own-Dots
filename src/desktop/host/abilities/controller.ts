import { mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';
import {
  AbilityFailure,
  bindingSchema,
  bridgeLimit,
  failureCode,
  loopbackBackend,
} from '../../../shared/abilities/bridge.js';
import {
  desktopAbilityMethods,
  type DesktopAbilityMethod,
  type DesktopAbilityReply,
} from '../../../shared/abilities/desktop.js';
import { assertBoundedJson } from '../../../shared/abilities/limits.js';
import type { ProtectedStorage } from '../backup-keys.js';
import type { WorkspaceBackendConnection } from '../workspace-backend.js';
import { DesktopAbilityBridge } from './bridge.js';
import { AbilityHost } from './host.js';
import { DirectoryAnchor } from './package.js';
import { inspectPython, loadPython, savePython } from './runtime.js';
import type { AbilityRuntime } from './sandbox.js';
import { validateExecutable, validateRuntime } from './sandbox.js';
import type { AbilitySupervisorOptions } from './supervisor.js';
type Current = {
  connection: WorkspaceBackendConnection;
  controller: AbortController;
  host: AbilityHost;
  bridge: DesktopAbilityBridge;
  python?: AbilityRuntime;
};
type Options = {
  profile: string;
  bundle: string;
  storage: ProtectedStorage;
  open(url: string): Promise<void>;
  choosePython?(): Promise<string | undefined>;
  approvePython?(runtime: AbilityRuntime): Promise<boolean>;
  runtimes?: AbilitySupervisorOptions['runtimes'];
};
/** Desktop-main only. No renderer-provided URL, path, token or authority is accepted. */
export class AbilityController {
  private current?: Current;
  private choosingPython = false;
  private maintenance = false;
  private connection?: WorkspaceBackendConnection;
  private operations: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private stopped = false;
  private unavailable:
    'unsupported_platform' | 'host_unavailable' | 'setup_needed' =
    'host_unavailable';
  constructor(private readonly options: Options) {}
  get available(): boolean {
    return !this.stopped && !!this.current?.bridge.connected;
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.operations.catch(() => {}).then(action);
    this.operations = next;
    return next;
  }
  async attach(connection: WorkspaceBackendConnection): Promise<void> {
    if (this.stopped) return;
    if (
      this.available &&
      this.current?.connection.url === connection.url &&
      this.current.connection.workspaceId === connection.workspaceId &&
      this.current.connection.ownerToken === connection.ownerToken
    )
      return;
    const generation = ++this.generation;
    this.connection = { ...connection };
    return this.serial(async () => {
      const old = this.current;
      this.current = undefined;
      old?.controller.abort();
      await old?.bridge.stop();
      if (this.stopped || generation !== this.generation) return;
      if (process.platform !== 'darwin' || process.arch !== 'arm64') {
        this.unavailable = 'unsupported_platform';
        return;
      }
      if (
        !connection.workspaceId ||
        !connection.abilityRoot ||
        !isAbsolute(connection.abilityRoot) ||
        !connection.ownerToken ||
        connection.ownerToken.length < 24
      ) {
        this.unavailable = 'setup_needed';
        return;
      }
      let current: Current | undefined;
      try {
        loopbackBackend(connection.url);
        const launcher = join(this.options.bundle, 'native/ability-launcher');
        await validateExecutable(launcher);
        const runtime: AbilitySupervisorOptions['runtimes'] = {
          ...(this.options.runtimes ?? {
            javascript: {
              executable: await realpath(process.execPath),
              readRoots: [dirname(dirname(await realpath(process.execPath)))],
            },
          }),
        };
        await validateRuntime(runtime.javascript);
        if (runtime.python) await validateRuntime(runtime.python);
        const profile = await realpath(this.options.profile),
          privateRoot = join(profile, 'abilities'),
          root = connection.abilityRoot;
        for (const directory of [privateRoot, root]) {
          if ((await realpath(dirname(directory))) !== dirname(directory))
            throw new AbilityFailure('permission_denied');
          await mkdir(directory, { mode: 0o700 }).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== 'EEXIST') throw error;
            },
          );
          await DirectoryAnchor.capture(directory);
        }
        if (!runtime.python) {
          // Invalid or moved Python affects only Python abilities, never JavaScript.
          runtime.python = await loadPython(privateRoot).catch(() => undefined);
        }
        if (this.stopped || generation !== this.generation) return;
        const controller = new AbortController();
        const host: AbilityHost = new AbilityHost({
          workspaceId: connection.workspaceId,
          packageRoot: join(root, 'installation'),
          stateRoot: join(root, 'state'),
          controlRoot: join(privateRoot, 'control'),
          credentialRoot: join(privateRoot, 'credentials'),
          launcher,
          runtimes: runtime,
          storage: this.options.storage,
          session: () => bridge?.session,
          binding: async (id) =>
            bindingSchema.parse(
              await this.api(
                connection,
                `/abilities/${encodeURIComponent(id)}`,
                undefined,
                controller.signal,
              ),
            ),
          authorize: (context) => bridge.authorize(context),
          open: this.options.open,
        });
        const bridge: DesktopAbilityBridge = new DesktopAbilityBridge(
          {
            url: connection.url,
            workspaceId: connection.workspaceId,
            ownerToken: connection.ownerToken,
          },
          host,
        );
        current = {
          connection: { ...connection },
          controller,
          host,
          bridge,
          python: runtime.python,
        };
        this.current = current;
        await bridge.start();
        await this.api(connection, '/abilities/cleanup', {}, controller.signal);
        if (this.stopped || generation !== this.generation) {
          controller.abort();
          await bridge.stop();
          if (this.current === current) this.current = undefined;
        }
      } catch {
        this.unavailable = 'host_unavailable';
        current?.controller.abort();
        await current?.bridge.stop();
        if (this.current === current) this.current = undefined;
      }
    });
  }
  async quiesce(): Promise<void> {
    if (this.maintenance) return;
    this.maintenance = true;
    await this.current?.host.quiesce();
  }
  async resumeMaintenance(): Promise<void> {
    if (!this.maintenance) return;
    await this.current?.host.resume();
    this.maintenance = false;
  }
  suspend(): Promise<void> {
    ++this.generation;
    const current = this.current;
    this.current = undefined;
    current?.controller.abort();
    const stopping = current?.bridge.stop();
    return this.serial(async () => {
      await stopping;
    });
  }
  stop(): Promise<void> {
    this.stopped = true;
    return this.suspend();
  }
  private async api(
    connection: WorkspaceBackendConnection,
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const origin = loopbackBackend(connection.url);
    if (!connection.ownerToken) throw new AbilityFailure('setup_needed');
    const bytes =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (bytes && bytes.length > bridgeLimit)
      throw new AbilityFailure('invalid_response');
    return new Promise((resolve, reject) => {
      const request = (
        origin.protocol === 'https:' ? httpsRequest : httpRequest
      )(
        new URL('/api' + path, origin),
        {
          method: bytes ? 'POST' : 'GET',
          agent: false,
          signal,
          headers: {
            authorization: `Bearer ${connection.ownerToken}`,
            ...(bytes
              ? {
                  'content-type': 'application/json',
                  'content-length': bytes.length,
                }
              : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let count = 0;
          response.on('data', (chunk: Buffer) => {
            count += chunk.length;
            if (count > bridgeLimit)
              response.destroy(new AbilityFailure('invalid_response'));
            else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              if (response.statusCode !== 200)
                throw new AbilityFailure(
                  response.statusCode === 401
                    ? 'permission_denied'
                    : 'host_unavailable',
                );
              const value: unknown = JSON.parse(
                Buffer.concat(chunks).toString('utf8'),
              );
              assertBoundedJson(value, bridgeLimit);
              resolve(value);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on('error', reject);
      request.setTimeout(300_000, () =>
        request.destroy(new AbilityFailure('timeout')),
      );
      request.end(bytes);
    });
  }
  async invoke<M extends DesktopAbilityMethod>(
    method: M,
    raw: unknown,
    authority: { trusted(): boolean },
  ): Promise<DesktopAbilityReply<M>> {
    try {
      if (!authority.trusted() || !Object.hasOwn(desktopAbilityMethods, method))
        throw new AbilityFailure('permission_denied');
      assertBoundedJson(raw, bridgeLimit);
      const spec = desktopAbilityMethods[method],
        input = spec.input.parse(raw);
      const connection = this.connection;
      if (!connection || this.stopped)
        throw new AbilityFailure('host_unavailable');
      const current = this.current;
      if (this.maintenance && method !== 'list')
        throw new AbilityFailure('busy');
      if (method !== 'list' && (!current || !this.available))
        throw new AbilityFailure(this.unavailable);
      const signal = current?.controller.signal ?? AbortSignal.timeout(3000);
      const api = (path: string, body?: unknown) =>
        this.api(connection, path, body, signal);
      let boundBinding: z.infer<typeof bindingSchema> | undefined;
      if ('bindingId' in input) {
        const bound = z
          .object({ bindingId: z.uuid(), dotId: z.string() })
          .parse(input);
        const binding = bindingSchema.parse(
          await api(`/abilities/${encodeURIComponent(bound.bindingId)}`),
        );
        if (binding.id !== bound.bindingId || binding.dotId !== bound.dotId)
          throw new AbilityFailure('permission_denied');
        boundBinding = binding;
      }
      if (!authority.trusted() || (current && this.current !== current))
        throw new AbilityFailure('permission_denied');
      if (method === 'choosePython') {
        if (
          this.choosingPython ||
          !this.options.choosePython ||
          !this.options.approvePython
        )
          throw new AbilityFailure('busy');
        this.choosingPython = true;
        try {
          const path = await this.options.choosePython();
          if (!path)
            return {
              ok: true,
              value: { selected: false },
            } as DesktopAbilityReply<M>;
          const runtime = await inspectPython(path);
          if (!authority.trusted() || this.current !== current)
            throw new AbilityFailure('permission_denied');
          if (!(await this.options.approvePython(runtime)))
            return {
              ok: true,
              value: { selected: false },
            } as DesktopAbilityReply<M>;
          if (!authority.trusted() || this.current !== current)
            throw new AbilityFailure('permission_denied');
          await savePython(
            join(await realpath(this.options.profile), 'abilities'),
            runtime,
          );
          await this.suspend();
          await this.attach(connection);
          return {
            ok: true,
            value: { selected: true },
          } as DesktopAbilityReply<M>;
        } finally {
          this.choosingPython = false;
        }
      }
      let value: unknown;
      switch (method) {
        case 'list': {
          const args = desktopAbilityMethods.list.input.parse(input);
          const response = z
            .strictObject({ bindings: z.array(bindingSchema) })
            .parse(
              await api(`/dots/${encodeURIComponent(args.dotId)}/abilities`),
            );
          value = {
            ...response,
            activity: Object.fromEntries(
              response.bindings.map((binding) => [
                binding.id,
                current?.host.running(binding.id) ?? false,
              ]),
            ),
            available: this.available,
            ...(current?.python ? { python: current.python } : {}),
            ...(!this.available ? { reason: this.unavailable } : {}),
          };
          break;
        }
        case 'review': {
          const args = desktopAbilityMethods.review.input.parse(input);
          const review = desktopAbilityMethods.review.output.parse(
            await api(
              `/dots/${encodeURIComponent(args.dotId)}/abilities/review`,
              { url: args.url },
            ),
          );
          value = {
            ...review,
            storage: {
              packagePath: join(
                connection.abilityRoot!,
                'installation',
                'packages',
                review.descriptor.asset.sha256,
              ),
              stateParent: join(connection.abilityRoot!, 'state'),
            },
          };
          break;
        }
        case 'teach': {
          const args = desktopAbilityMethods.teach.input.parse(input);
          value = await api(
            `/dots/${encodeURIComponent(args.dotId)}/abilities/teach`,
            { reviewId: args.reviewId, settings: args.settings },
          );
          break;
        }
        case 'enable': {
          const args = desktopAbilityMethods.enable.input.parse(input);
          value = await api(`/abilities/${args.bindingId}/enable`, {});
          break;
        }
        case 'update': {
          const args = desktopAbilityMethods.update.input.parse(input);
          value = await api(`/abilities/${args.bindingId}/update`, {
            reviewId: args.reviewId,
            settings: args.settings,
          });
          break;
        }
        case 'configure': {
          const args = desktopAbilityMethods.configure.input.parse(input);
          value = await api(`/abilities/${args.bindingId}/configure`, {
            settings: args.settings,
          });
          break;
        }
        case 'connect': {
          const args = desktopAbilityMethods.connect.input.parse(input);
          const account = boundBinding!.manifest.permissions.find(
            (p) => p.kind === 'oauth' && p.id === args.accountId,
          );
          if (
            !account ||
            account.kind !== 'oauth' ||
            !boundBinding!.enabled ||
            !boundBinding!.grants.includes(account.id)
          )
            throw new AbilityFailure('permission_denied');
          if (boundBinding!.settings[account.clientIdSetting] !== args.clientId)
            await api(`/abilities/${args.bindingId}/configure`, {
              settings: {
                ...boundBinding!.settings,
                [account.clientIdSetting]: args.clientId,
              },
            });
          if (!authority.trusted() || this.current !== current)
            throw new AbilityFailure('permission_denied');
          await current!.host.accounts.connect(
            args.bindingId,
            args.clientId,
            args.accountId,
          );
          value = { ok: true };
          break;
        }
        case 'account': {
          const args = desktopAbilityMethods.account.input.parse(input);
          const presence = await current!.host.accounts.presence(
            args.bindingId,
            args.accountId,
          );
          value = { connected: presence.connected };
          break;
        }
        case 'disable':
        case 'disconnect': {
          const args = desktopAbilityMethods.disable.input.parse(input);
          await api(`/abilities/${args.bindingId}/${method}`, {});
          value = { ok: true };
          break;
        }
        case 'forget': {
          const args = desktopAbilityMethods.forget.input.parse(input);
          await api(`/abilities/${args.bindingId}/forget`, {
            eraseState: args.eraseState,
          });
          value = { ok: true };
          break;
        }
        case 'uninstall': {
          const args = desktopAbilityMethods.uninstall.input.parse(input);
          await api(`/abilities/packages/${args.digest}/uninstall`, {});
          value = { ok: true };
          break;
        }
        case 'recent': {
          const args = desktopAbilityMethods.recent.input.parse(input);
          value = await current!.host.recentResults(args.dotId, args.threadId);
          break;
        }
        case 'results': {
          const args = desktopAbilityMethods.results.input.parse(input);
          value =
            (await current!.host.readResult(args.dotId, args.handle)) ?? null;
          break;
        }
        case 'select': {
          const args = desktopAbilityMethods.select.input.parse(input);
          value = {
            selectionRef: await current!.host.select(
              args.dotId,
              args.handle,
              args.itemId,
            ),
          };
          break;
        }
      }
      if (!authority.trusted() || (current && this.current !== current))
        throw new AbilityFailure('permission_denied');
      return {
        ok: true,
        value: spec.output.parse(value),
      } as DesktopAbilityReply<M>;
    } catch (error) {
      return { ok: false, code: failureCode(error) };
    }
  }
}
