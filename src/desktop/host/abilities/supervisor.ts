import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Duplex, Readable } from 'node:stream';
import { z } from 'zod';
import {
  AbilityFailure,
  failureCode,
} from '../../../shared/abilities/bridge.js';
import {
  abilityLimits,
  assertBoundedJson,
} from '../../../shared/abilities/limits.js';
import { validateValue } from '../../../shared/abilities/manifest.js';
import { canonicalJson } from '../../../shared/abilities/permissions.js';
import {
  capabilityReplySchema,
  parseWorkerMessage,
  workerResultSchema,
  type HostMessage,
} from '../../../shared/abilities/protocol.js';
import type {
  Binding,
  CapabilityReply,
  CapabilityRequest,
  InvocationContext,
  InvocationRequest,
  VerifiedPackage,
} from '../../../shared/abilities/types.js';
import { DirectoryAnchor, verifyInstalledPackage } from './package.js';
import {
  buildSandboxProfile,
  validateExecutable,
  validateRuntime,
  type AbilityRuntime,
} from './sandbox.js';

export type WorkerResult = z.infer<typeof workerResultSchema>;
export type ExecutionBinding = {
  binding: Binding;
  package: VerifiedPackage;
  stateRoot: string;
};
export type AbilitySupervisorOptions = {
  launcher: string;
  controlRoot: string;
  runtimes: { javascript: AbilityRuntime; python?: AbilityRuntime };
  resolve(context: InvocationContext): Promise<ExecutionBinding>;
  capability(
    context: InvocationContext,
    request: CapabilityRequest,
    signal: AbortSignal,
  ): Promise<CapabilityReply>;
};
type Entry = Binding['manifest']['entrypoint'];
type Job = {
  request: InvocationRequest;
  controller: AbortController;
  complete(result: WorkerResult): void;
  cleanup(): void;
};
type Scope = {
  job: Job;
  workers: Set<ProtocolWorker>;
  slots: Set<Promise<void>>;
  started: boolean;
  done: Promise<void>;
  finish(): void;
};
type Queue = { active?: Scope; waiting: Job[] };

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new AbilityFailure('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
class ProtocolWorker {
  readonly child: ChildProcess;
  readonly closed: Promise<void>;
  readonly result: Promise<WorkerResult>;
  pid?: number;
  private stopping = false;
  private readonly control: Duplex;
  private renewal?: ReturnType<typeof setInterval>;
  constructor(
    launcher: string,
    profile: string,
    executable: string,
    args: string[],
    cwd: string,
    tool: string,
    request: InvocationRequest,
    signal: AbortSignal,
    capability: (request: CapabilityRequest) => Promise<CapabilityReply>,
    started: () => void,
    authorize: () => Promise<unknown>,
  ) {
    const child = (this.child = spawn(
      launcher,
      [
        '--profile',
        profile,
        '--control-fd',
        '3',
        '--status-fd',
        '4',
        '--lease',
        '--',
        executable,
        ...args,
      ],
      {
        cwd,
        env: {},
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      },
    ));
    this.control = child.stdio[3] as Duplex;
    this.control.on('error', () => {});
    const initialize = randomUUID(),
      invoke = randomUUID();
    let phase: 'initialize' | 'invoke' | 'done' = 'initialize';
    let rejectResult: (error: Error) => void = () => {};
    let resolveResult: (value: WorkerResult) => void = () => {};
    this.result = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    // A close/error may arrive before execute() begins awaiting this promise.
    void this.result.catch(() => {});
    const fail = (error: Error) => {
      if (phase !== 'done') {
        phase = 'done';
        rejectResult(error);
      }
      this.stop();
    };
    const send = (value: HostMessage) => {
      if (this.stopping || signal.aborted) return;
      const bytes = JSON.stringify(value) + '\n';
      if (Buffer.byteLength(bytes) > abilityLimits.frameBytes) {
        fail(new AbilityFailure('invalid_response'));
        return;
      }
      child.stdin!.write(bytes, (error) => {
        if (error) fail(new AbilityFailure('invalid_response'));
      });
    };
    child.stdin!.on('error', () =>
      fail(new AbilityFailure('invalid_response')),
    );
    let buffered = Buffer.alloc(0),
      frames = 0,
      pending = 0,
      stderr = 0,
      status = '';
    const seen = new Set<string>([initialize, invoke]);
    child.stdout!.on('data', (chunk: Buffer) => {
      if (phase === 'done') return;
      buffered = Buffer.concat([buffered, chunk]);
      let boundary: number;
      try {
        while ((boundary = buffered.indexOf(10)) >= 0) {
          if (boundary > abilityLimits.frameBytes || ++frames > 2048)
            throw new AbilityFailure('invalid_response');
          const message = parseWorkerMessage(
            JSON.parse(buffered.subarray(0, boundary).toString('utf8')),
          );
          buffered = buffered.subarray(boundary + 1);
          if ('method' in message) {
            if (phase !== 'invoke' || seen.has(message.id) || pending >= 16)
              throw new AbilityFailure('invalid_response');
            seen.add(message.id);
            pending++;
            void capability(message.params)
              .then(
                (result) => {
                  if (phase === 'invoke')
                    send({
                      jsonrpc: '2.0',
                      id: message.id,
                      result: capabilityReplySchema.parse(result),
                    });
                },
                (error) => {
                  if (phase === 'invoke')
                    send({
                      jsonrpc: '2.0',
                      id: message.id,
                      result: { ok: false, code: failureCode(error) },
                    });
                },
              )
              .catch(() => fail(new AbilityFailure('invalid_response')))
              .finally(() => {
                pending--;
              });
          } else if (
            message.id === initialize &&
            phase === 'initialize' &&
            'result' in message &&
            'apiVersion' in message.result
          ) {
            phase = 'invoke';
            send({
              jsonrpc: '2.0',
              id: invoke,
              method: 'invoke',
              params: {
                tool,
                arguments: request.arguments,
                settings: request.settings,
                ...(request.selection ? { selection: request.selection } : {}),
              },
            });
          } else if (message.id === invoke && phase === 'invoke') {
            if ('error' in message)
              throw new AbilityFailure(message.error.code);
            const result = workerResultSchema.parse(message.result);
            phase = 'done';
            resolveResult(result);
          } else throw new AbilityFailure('invalid_response');
        }
        if (buffered.length > abilityLimits.frameBytes)
          throw new AbilityFailure('invalid_response');
      } catch {
        fail(new AbilityFailure('invalid_response'));
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.length;
      if (stderr > abilityLimits.frameBytes)
        fail(new AbilityFailure('invalid_response'));
    });
    (child.stdio[4] as Readable).on('data', (chunk: Buffer) => {
      status += chunk.toString('utf8');
      if (status.length > 4096) {
        fail(new AbilityFailure('invalid_response'));
        return;
      }
      let boundary: number;
      try {
        while ((boundary = status.indexOf('\n')) >= 0) {
          const message = JSON.parse(status.slice(0, boundary));
          status = status.slice(boundary + 1);
          if (
            message.type === 'spawn' &&
            this.pid === undefined &&
            Number.isSafeInteger(message.pid) &&
            message.pid > 1
          ) {
            this.pid = message.pid;
            started();
          } else if (message.type !== 'exit')
            throw new Error('Invalid launcher status');
        }
      } catch {
        fail(new AbilityFailure('invalid_response'));
      }
    });
    const abort = () => fail(new AbilityFailure('cancelled'));
    let checking = false;
    this.renewal = setInterval(() => {
      if (checking || this.stopping || signal.aborted || phase === 'done')
        return;
      checking = true;
      void authorize()
        .then(
          () => {
            if (!this.stopping && !signal.aborted && phase !== 'done')
              this.control.write('R', (error) => {
                if (error) fail(new AbilityFailure('host_unavailable'));
              });
          },
          () => fail(new AbilityFailure('permission_denied')),
        )
        .finally(() => {
          checking = false;
        });
    }, 500);
    this.renewal.unref?.();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    this.closed = new Promise((resolve) => {
      const close = () => {
        if (this.renewal) clearInterval(this.renewal);
        signal.removeEventListener('abort', abort);
        if (phase !== 'done') fail(new AbilityFailure('invalid_response'));
        resolve();
      };
      child.once('close', close);
      child.once('error', () => fail(new AbilityFailure('invalid_response')));
    });
    send({
      jsonrpc: '2.0',
      id: initialize,
      method: 'initialize',
      params: { apiVersion: 1 },
    });
  }
  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    if (this.renewal) clearInterval(this.renewal);
    // Only the native watchdog signals its unreaped child identity. Closing this
    // descriptor starts TERM -> two-second grace -> KILL -> waitpid cleanup.
    this.control.destroy();
    this.child.stdin?.end();
  }
}

export class AbilitySupervisor {
  private readonly queues = new Map<string, Queue>();
  private stopped = false;
  constructor(private readonly options: AbilitySupervisorOptions) {}
  status(bindingId: string): {
    active: boolean;
    queued: number;
    workers: number;
  } {
    const queue = this.queues.get(bindingId);
    return {
      active: Boolean(queue?.active),
      queued: queue?.waiting.length ?? 0,
      workers: [...(queue?.active?.workers ?? [])].filter(
        (worker) => worker.pid !== undefined,
      ).length,
    };
  }
  invoke(
    request: InvocationRequest,
    signal: AbortSignal,
  ): Promise<WorkerResult> {
    if (this.stopped)
      return Promise.resolve({ status: 'error', code: 'host_unavailable' });
    if (signal.aborted)
      return Promise.resolve({ status: 'error', code: 'cancelled' });
    const key = request.context.bindingId;
    const queue = this.queues.get(key) ?? { waiting: [] };
    this.queues.set(key, queue);
    if (queue.active && queue.waiting.length >= abilityLimits.queuedInvocations)
      return Promise.resolve({ status: 'error', code: 'busy' });
    return new Promise((resolve) => {
      const controller = new AbortController();
      const cancel = (code: 'cancelled' | 'timeout') => {
        controller.abort(new AbilityFailure(code));
        const index = queue.waiting.indexOf(job);
        if (index >= 0) {
          queue.waiting.splice(index, 1);
          job.cleanup();
          resolve({ status: 'error', code });
        }
      };
      const abort = () => cancel('cancelled');
      const timer = setTimeout(
        () => cancel('timeout'),
        abilityLimits.invocationMs,
      );
      timer.unref?.();
      const job: Job = {
        request: structuredClone(request),
        controller,
        complete: resolve,
        cleanup: () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
        },
      };
      signal.addEventListener('abort', abort, { once: true });
      queue.waiting.push(job);
      this.pump(key, queue);
    });
  }
  private pump(key: string, queue: Queue): void {
    if (queue.active || this.stopped) return;
    const job = queue.waiting.shift();
    if (!job) {
      this.queues.delete(key);
      return;
    }
    let finish: () => void = () => {};
    const scope: Scope = {
      job,
      workers: new Set(),
      slots: new Set(),
      started: false,
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      finish: () => finish(),
    };
    queue.active = scope;
    void this.run(scope)
      .then(job.complete, () => job.complete({ status: 'uncertain' }))
      .finally(() => {
        job.cleanup();
        queue.active = undefined;
        scope.finish();
        this.pump(key, queue);
      });
  }
  private async authority(scope: Scope): Promise<ExecutionBinding> {
    scope.job.controller.signal.throwIfAborted();
    let resolved: ExecutionBinding;
    try {
      resolved = await abortable(
        this.options.resolve(scope.job.request.context),
        scope.job.controller.signal,
      );
    } catch (error) {
      if (error instanceof AbilityFailure) throw error;
      throw new AbilityFailure('permission_denied');
    }
    scope.job.controller.signal.throwIfAborted();
    const { binding, package: pkg } = resolved,
      context = scope.job.request.context;
    if (
      !binding.enabled ||
      binding.restored ||
      binding.id !== context.bindingId ||
      binding.dotId !== context.dotId ||
      binding.revision !== context.grantRevision ||
      binding.digest !== context.digest ||
      pkg.digest !== context.digest ||
      canonicalJson(pkg.manifest) !== canonicalJson(binding.manifest) ||
      canonicalJson(binding.settings) !==
        canonicalJson(scope.job.request.settings)
    )
      throw new AbilityFailure('permission_denied');
    return resolved;
  }
  private async run(scope: Scope): Promise<WorkerResult> {
    try {
      const { binding } = await this.authority(scope);
      const tool = binding.manifest.tools.find(
        (tool) => tool.id === scope.job.request.context.tool,
      );
      if (!tool) throw new AbilityFailure('permission_denied');
      assertBoundedJson(scope.job.request.arguments, abilityLimits.frameBytes);
      validateValue(tool.input, scope.job.request.arguments);
      return await this.execute(
        scope,
        binding.manifest.entrypoint,
        scope.job.request,
      );
    } catch (error) {
      return scope.started && scope.job.controller.signal.aborted
        ? { status: 'uncertain' }
        : {
            status: 'error',
            code: scope.job.controller.signal.aborted
              ? 'cancelled'
              : failureCode(error),
          };
    } finally {
      scope.job.controller.abort();
      for (const worker of scope.workers) worker.stop();
      await Promise.all([...scope.slots]);
    }
  }
  private async capability(
    scope: Scope,
    request: CapabilityRequest,
  ): Promise<CapabilityReply> {
    const { binding } = await this.authority(scope);
    if (request.kind !== 'helper') {
      scope.job.controller.signal.throwIfAborted();
      const reply = await abortable(
        this.options.capability(
          scope.job.request.context,
          request,
          scope.job.controller.signal,
        ),
        scope.job.controller.signal,
      );
      await this.authority(scope);
      return capabilityReplySchema.parse(reply);
    }
    const helper = binding.manifest.helpers.find(
      (helper) => helper.id === request.helperId,
    );
    if (
      !helper ||
      !binding.manifest.permissions.some(
        (p) =>
          p.kind === 'helper' &&
          p.helperId === helper.id &&
          binding.grants.includes(p.id),
      )
    )
      throw new AbilityFailure('permission_denied');
    validateValue(helper.arguments, request.arguments);
    const result = await this.execute(
      scope,
      helper.entrypoint,
      {
        ...scope.job.request,
        arguments: request.arguments,
        selection: undefined,
      },
      helper.id,
      false,
    );
    if (result.status !== 'success')
      return {
        ok: false,
        code: result.status === 'error' ? result.code : 'invalid_response',
      };
    return { ok: true, kind: 'helper', value: result.value ?? null };
  }
  private async execute(
    scope: Scope,
    entry: Entry,
    request: InvocationRequest,
    tool = request.context.tool,
    primary = true,
  ): Promise<WorkerResult> {
    const signal = scope.job.controller.signal;
    signal.throwIfAborted();
    if (scope.slots.size >= abilityLimits.workers)
      throw new AbilityFailure('busy');
    let finish: () => void = () => {};
    const slot = new Promise<void>((resolve) => {
      finish = resolve;
    });
    scope.slots.add(slot);
    let worker: ProtocolWorker | undefined, temporary: string | undefined;
    try {
      const resolved = await this.authority(scope);
      const pkg = resolved.package;
      try {
        await verifyInstalledPackage(pkg);
      } catch {
        throw new AbilityFailure('permission_denied');
      }
      const packageAnchor = await DirectoryAnchor.capture(pkg.root),
        state = await DirectoryAnchor.capture(resolved.stateRoot),
        control = await DirectoryAnchor.capture(this.options.controlRoot);
      await DirectoryAnchor.capture(join(state.path, 'tmp'));
      const target = join(pkg.root, entry.path);
      const runtime =
        entry.runtime === 'native'
          ? { executable: target, readRoots: [] }
          : this.options.runtimes[entry.runtime];
      if (!runtime) throw new AbilityFailure('setup_needed');
      await validateRuntime(runtime);
      await validateExecutable(this.options.launcher);
      const profile = buildSandboxProfile({
        packageRoot: pkg.root,
        stateRoot: state.path,
        temporaryRoot: join(state.path, 'tmp'),
        executable: runtime.executable,
        runtimeReadRoots: runtime.readRoots,
      });
      await control.check();
      temporary = await mkdtemp(join(control.path, 'run-'));
      const path = join(temporary, 'profile.sb');
      await writeFile(path, profile, { mode: 0o600, flag: 'wx' });
      await packageAnchor.check();
      await state.check();
      await control.check();
      await this.authority(scope);
      signal.throwIfAborted();
      const args =
        entry.runtime === 'native'
          ? []
          : entry.runtime === 'python'
            ? ['-I', '-S', '-B', target]
            : [target];
      worker = new ProtocolWorker(
        this.options.launcher,
        path,
        runtime.executable,
        args,
        state.path,
        tool,
        request,
        signal,
        (request) => this.capability(scope, request),
        () => {
          scope.started = true;
        },
        () => this.authority(scope),
      );
      scope.workers.add(worker);
      const result = await worker.result;
      if (primary) scope.job.controller.abort();
      return result;
    } catch (error) {
      if (error instanceof AbilityFailure || signal.aborted) throw error;
      throw new AbilityFailure('permission_denied');
    } finally {
      try {
        if (worker) {
          worker.stop();
          await worker.closed;
          scope.workers.delete(worker);
        }
        if (temporary) await rm(temporary, { recursive: true, force: true });
      } finally {
        scope.slots.delete(slot);
        finish();
      }
    }
  }
  async stopBinding(bindingId: string): Promise<void> {
    const queue = this.queues.get(bindingId);
    if (!queue) return;
    for (const job of queue.waiting.splice(0)) {
      job.controller.abort();
      job.cleanup();
      job.complete({ status: 'error', code: 'cancelled' });
    }
    queue.active?.job.controller.abort();
    await queue.active?.done;
  }
  async stopAll(): Promise<void> {
    this.stopped = true;
    await Promise.all(
      [...this.queues.keys()].map((key) => this.stopBinding(key)),
    );
    this.queues.clear();
  }
}
