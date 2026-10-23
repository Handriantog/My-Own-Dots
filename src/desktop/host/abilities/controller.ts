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
  installedAbilitySchema,
  type DesktopAbilityMethod,
  type DesktopAbilityReply,
} from '../../../shared/abilities/desktop.js';
import { assertBoundedJson } from '../../../shared/abilities/limits.js';
import type { ProtectedStorage } from '../backup-keys.js';
import type { WorkspaceBackendConnection } from '../workspace-backend.js';
import { DesktopAbilityBridge } from './bridge.js';
import { createSpotifyTransport } from './spotify.js';
import { LocalAbilityPackages } from './local.js';
import { AbilityInstaller } from './installer.js';
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
  local: LocalAbilityPackages;
  bridge: DesktopAbilityBridge;
  python?: AbilityRuntime;
};
type AttachmentStage =
  | 'platform'
  | 'configuration'
  | 'launcher'
  | 'runtime'
  | 'directories'
  | 'host'
  | 'pairing'
  | 'cleanup'
  | 'connection';
type Options = {
  profile: string;
  bundle: string;
  storage: ProtectedStorage;
  open(url: string): Promise<void>;
  chooseAbility?(): Promise<string | undefined>;
  choosePython?(): Promise<string | undefined>;
  approvePython?(runtime: AbilityRuntime): Promise<boolean>;
  runtimes?: AbilitySupervisorOptions['runtimes'];
  onUnavailable?(
    stage: AttachmentStage,
    code: ReturnType<typeof failureCode>,
  ): void;
};
/** Desktop-main only. No renderer-provided URL, path, token or authority is accepted. */
export class AbilityController {
  private current?: Current;
  private choosingPython = false;
  private choosingAbility = false;
  private maintenance = false;
  private connection?: WorkspaceBackendConnection;
  private operations: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private stopped = false;
  private recovery?: ReturnType<typeof setTimeout>;
  // Automatic attachment never resets this; another failure needs an owner action.
  private autoRecoveryUsed = false;
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
  private reportUnavailable(
    stage: AttachmentStage,
    code: ReturnType<typeof failureCode>,
  ): void {
    try {
      this.options.onUnavailable?.(stage, code);
    } catch {
      // Diagnostics must not interrupt revocation or attachment cleanup.
    }
  }
  async reconnect(): Promise<void> {
    if (this.stopped || !this.connection)
      throw new AbilityFailure('host_unavailable');
    if (this.maintenance) throw new AbilityFailure('busy');
    await this.attach(this.connection);
    if (!this.available) throw new AbilityFailure(this.unavailable);
  }
  async attach(connection: WorkspaceBackendConnection): Promise<void> {
    this.autoRecoveryUsed = false;
    return this.attachConnection(connection);
  }
  private async attachConnection(
    connection: WorkspaceBackendConnection,
    previousSessionId?: string,
  ): Promise<void> {
    clearTimeout(this.recovery);
    this.recovery = undefined;
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
      old?.local.clear();
      await old?.bridge.stop();
      if (this.stopped || generation !== this.generation) return;
      if (process.platform !== 'darwin' || process.arch !== 'arm64') {
        this.unavailable = 'unsupported_platform';
        this.reportUnavailable('platform', this.unavailable);
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
        this.reportUnavailable('configuration', this.unavailable);
        return;
      }
      let current: Current | undefined;
      let stage: AttachmentStage = 'configuration';
      try {
        loopbackBackend(connection.url);
        stage = 'launcher';
        const launcher = join(this.options.bundle, 'native/ability-launcher');
        await validateExecutable(launcher);
        stage = 'runtime';
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
        stage = 'directories';
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
        stage = 'host';
        const controller = new AbortController();
        const local = new LocalAbilityPackages(() => bridge?.session);
        const host: AbilityHost = new AbilityHost({
          appControl: createSpotifyTransport(
            join(this.options.bundle, 'native/spotify-control'),
          ),
          installer: new AbilityInstaller(
            join(root, 'installation'),
            local.transport,
          ),
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
            previousSessionId,
          },
          host,
          (lostSessionId) => {
            if (
              this.current !== current ||
              this.stopped ||
              generation !== this.generation
            )
              return;
            this.unavailable = 'host_unavailable';
            current?.controller.abort();
            current?.local.clear();
            this.reportUnavailable('connection', this.unavailable);
            if (this.autoRecoveryUsed || this.maintenance) return;
            this.autoRecoveryUsed = true;
            this.recovery = setTimeout(() => {
              this.recovery = undefined;
              if (
                this.stopped ||
                this.maintenance ||
                generation !== this.generation ||
                (this.current && this.current !== current)
              )
                return;
              void this.attachConnection(connection, lostSessionId).catch(
                () => {},
              );
            }, 1000);
            this.recovery.unref?.();
          },
        );
        current = {
          connection: { ...connection },
          controller,
          host,
          local,
          bridge,
          python: runtime.python,
        };
        this.current = current;
        stage = 'pairing';
        await bridge.start();
        stage = 'cleanup';
        await this.api(connection, '/abilities/cleanup', {}, controller.signal);
        if (this.stopped || generation !== this.generation) {
          controller.abort();
          await bridge.stop();
          if (this.current === current) this.current = undefined;
        }
      } catch (error) {
        this.unavailable = 'host_unavailable';
        if (!this.stopped && generation === this.generation)
          this.reportUnavailable(
            stage,
            error instanceof AbilityFailure ? error.code : 'host_unavailable',
          );
        current?.controller.abort();
        current?.local.clear();
        if (this.current === current) this.current = undefined;
        await current?.bridge.stop();
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
    clearTimeout(this.recovery);
    this.recovery = undefined;
    ++this.generation;
    const current = this.current;
    this.current = undefined;
    current?.controller.abort();
    current?.local.clear();
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
      if (method === 'reconnect') {
        if (this.maintenance) throw new AbilityFailure('busy');
        await this.reconnect();
        if (!authority.trusted()) throw new AbilityFailure('permission_denied');
        return {
          ok: true,
          value: { available: this.available },
        } as DesktopAbilityReply<M>;
      }
      const current = this.current;
      if (this.maintenance && !['list', 'catalog'].includes(method))
        throw new AbilityFailure('busy');
      if (
        !['list', 'catalog'].includes(method) &&
        (!current || !this.available)
      )
        throw new AbilityFailure(this.unavailable);
      const signal =
        this.available && current
          ? current.controller.signal
          : AbortSignal.timeout(3000);
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
        case 'catalog': {
          const response = z
            .strictObject({ installations: z.array(installedAbilitySchema) })
            .parse(await api('/abilities/catalog'));
          value = {
            ...response,
            available: this.available,
            ...(!this.available ? { reason: this.unavailable } : {}),
          };
          break;
        }
        case 'install': {
          value = await api(
            '/abilities/install',
            desktopAbilityMethods.install.input.parse(input),
          );
          break;
        }
        case 'master': {
          const args = desktopAbilityMethods.master.input.parse(input);
          value = await api(`/abilities/packages/${args.digest}/master`, {
            enabled: args.enabled,
          });
          break;
        }
        case 'applyAll': {
          const args = desktopAbilityMethods.applyAll.input.parse(input);
          value = await api(`/abilities/packages/${args.digest}/apply-all`, {});
          break;
        }
        case 'assign': {
          const args = desktopAbilityMethods.assign.input.parse(input);
          value = await api(
            `/dots/${encodeURIComponent(args.dotId)}/abilities/assign`,
            { digest: args.digest, enabled: args.enabled },
          );
          break;
        }
        case 'list': {
          const args = desktopAbilityMethods.list.input.parse(input);
          const response = z
            .strictObject({
              bindings: z.array(bindingSchema),
              installed: z.array(installedAbilitySchema).optional(),
            })
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
        case 'reviewLocal':
        case 'reviewInstallLocal': {
          if (this.choosingAbility || !this.options.chooseAbility)
            throw new AbilityFailure('busy');
          this.choosingAbility = true;
          try {
            const args =
              method === 'reviewLocal'
                ? desktopAbilityMethods.reviewLocal.input.parse(input)
                : undefined;
            const path = await this.options.chooseAbility();
            if (!path) {
              value = null;
              break;
            }
            if (!authority.trusted() || this.current !== current)
              throw new AbilityFailure('permission_denied');
            const review = await current!.local.review(path, signal);
            if (!authority.trusted() || this.current !== current)
              throw new AbilityFailure('permission_denied');
            const prepared = desktopAbilityMethods.review.output.parse(
              await api(
                args
                  ? `/dots/${encodeURIComponent(args.dotId)}/abilities/review-local`
                  : '/abilities/review-local',
                { review, sessionId: current!.bridge.session },
              ),
            );
            value = {
              ...prepared,
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
          } finally {
            this.choosingAbility = false;
          }
          break;
        }
        case 'review':
        case 'reviewInstall': {
          const args =
            method === 'review'
              ? desktopAbilityMethods.review.input.parse(input)
              : desktopAbilityMethods.reviewInstall.input.parse(input);
          const review = desktopAbilityMethods.review.output.parse(
            await api(
              'dotId' in args && typeof args.dotId === 'string'
                ? `/dots/${encodeURIComponent(args.dotId)}/abilities/review`
                : '/abilities/review',
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
            {
              reviewId: args.reviewId,
              settings: args.settings,
              ...(args.acceptedNotices
                ? { acceptedNotices: args.acceptedNotices }
                : {}),
            },
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
            ...(args.acceptedNotices
              ? { acceptedNotices: args.acceptedNotices }
              : {}),
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
