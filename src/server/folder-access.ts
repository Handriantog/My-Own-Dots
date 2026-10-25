import { folderPython } from './folder-python.js';
import { logError } from '../shared/error-log.js';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  folderHintCandidate,
  withinHome,
  type FolderResolutionOptions,
} from './folder-hint.js';
import {
  folderDecisionSchema,
  folderRequestSchema,
  type FolderDecision,
  type FolderGrant,
  type FolderRequest,
  type FolderRequestDetail,
  type FolderSelection,
  type FolderExecutionScope,
} from '../shared/folder-access.js';

const TTL = 60 * 60 * 1000;
const pathSchema = z
  .string()
  .max(4096)
  .refine((path) => !path.includes('\0'));
const identitySchema = z.object({ dev: z.string(), ino: z.string() });
const inspectionSchema = z.object({
  path: z.string(),
  name: z.string(),
  identity: identitySchema,
});
const listingSchema = z.object({
  path: z.string(),
  entries: z
    .array(
      z.object({
        name: z.string(),
        type: z.enum(['file', 'directory', 'blocked']),
      }),
    )
    .max(200),
  truncated: z.boolean(),
});
const writeResultSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative().max(65536),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
const readResultSchema = writeResultSchema.extend({ content: z.string() });
const writeSchema = z
  .object({
    content: z
      .string()
      .refine(
        (value) => Buffer.byteLength(value, 'utf8') <= 65536,
        'File exceeds the 64 KiB limit.',
      ),
    expectedHash: z.string().regex(/^(new|[a-f0-9]{64})$/),
  })
  .strict();
type Identity = z.infer<typeof identitySchema>;
type StoredSelection = FolderSelection & { identity: Identity };
type StoredGrant = FolderGrant & { identity: Identity };
type StoredRequest = {
  request: FolderRequest;
  executionThreadId?: string;
  selection?: StoredSelection;
  toolCallId?: string;
  decision?: FolderDecision;
};
type Scope = {
  requireDot(id: string): void;
  requireThread(
    threadId: string,
    dotId?: string,
  ): { id: string; dotId: string };
};
export class FolderAccessError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 410 | 503 = 400,
    readonly code?: 'folder_unavailable',
  ) {
    super(message);
  }
}

const sourceHelper = fileURLToPath(
  new URL('../../scripts/folder-access.py', import.meta.url),
);
const helperPath = process.env.DOTS_RUNTIME_ROOT
  ? resolve(process.env.DOTS_RUNTIME_ROOT, 'scripts/folder-access.py')
  : existsSync(sourceHelper)
    ? sourceHelper
    : resolve('scripts/folder-access.py');

/** No shell or environment-provided code is evaluated; Python is an app prerequisite. */
function helper(
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted)
    return Promise.reject(
      new FolderAccessError('Folder operation was cancelled.', 403),
    );
  return new Promise((resolveResult, reject) => {
    let python: string;
    try {
      python = folderPython();
    } catch (error) {
      logError('folder_runtime_invalid', error);
      return reject(new FolderAccessError((error as Error).message, 503));
    }
    const fail = (
      error: FolderAccessError,
      details: Record<string, string | number | undefined> = {},
    ) => {
      logError('folder_helper_failed', error, {
        operation: typeof input.action === 'string' ? input.action : undefined,
        python,
        ...details,
      });
      reject(error);
    };
    const child = spawn(python, ['-I', helperPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let outputBytes = 0;
    let error: FolderAccessError | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (message: string, status: 403 | 503) => {
      if (error) return;
      error = new FolderAccessError(message, status);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
      killTimer.unref();
    };
    const abort = () =>
      stop('Folder operation was cancelled or permission was revoked.', 403);
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(
      () => stop('Folder operation timed out.', 503),
      5000,
    );
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 524288)
        stop('Folder helper exceeded its output limit.', 503);
      else output += chunk;
    });
    // Do not expose helper stderr, which could contain absolute local paths.
    child.stderr.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 524288)
        stop('Folder helper exceeded its output limit.', 503);
    });
    child.on('error', (cause) => {
      logError('folder_runtime_start_failed', cause, {
        python,
        operation: String(input.action),
      });
      error ??= new FolderAccessError(
        'Managed Python 3.12 is unavailable. Run integration setup or configure DOTS_FOLDER_PYTHON with an absolute Python 3.12 path.',
        503,
      );
    });
    child.stdin.on('error', () => {
      error ??= new FolderAccessError(
        'Folder helper could not read the request.',
        503,
      );
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (error) return fail(error);
      if (code !== 0)
        return fail(
          new FolderAccessError('Folder operation could not complete.', 503),
          { code: code ?? undefined },
        );
      try {
        const result = z
          .discriminatedUnion('ok', [
            z.object({ ok: z.literal(true), result: z.unknown() }),
            z.object({
              ok: z.literal(false),
              error: z.string().max(300),
              code: z.string().max(80).optional(),
              pythonVersion: z.string().max(40).optional(),
              exceptionType: z.string().max(80).optional(),
              pythonTrace: z.string().max(1000).optional(),
            }),
          ])
          .parse(JSON.parse(output));
        if (!result.ok)
          return fail(
            new FolderAccessError(
              result.error,
              result.code === 'unsupported_python' ||
                result.code === 'helper_failure'
                ? 503
                : 400,
              input.action === 'verify' &&
                (result.exceptionType === 'FileNotFoundError' ||
                  result.exceptionType === 'NotADirectoryError' ||
                  result.exceptionType === 'PermissionError' ||
                  (result.exceptionType === 'Rejected' &&
                    result.error ===
                      'The approved folder changed. Choose and approve it again.'))
                ? 'folder_unavailable'
                : undefined,
            ),
            {
              code: result.code,
              pythonVersion: result.pythonVersion,
              exceptionType: result.exceptionType,
              pythonTrace: result.pythonTrace,
            },
          );
        if (input.action === 'verify')
          z.object({ ok: z.literal(true) }).parse(result.result);
        resolveResult(result.result);
      } catch {
        fail(
          new FolderAccessError(
            'Folder helper returned an invalid response.',
            503,
          ),
        );
      }
    });
    child.stdin.end(JSON.stringify({ ...input, parentPid: process.pid }));
  });
}

export function initializeProjectExecutionSchema(db: DatabaseSync) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS project_execution_bindings (ownerId TEXT NOT NULL, threadId TEXT NOT NULL, dotId TEXT NOT NULL, grantId TEXT NOT NULL, PRIMARY KEY(ownerId,threadId))',
  );
}
/** Owner decisions are durable; model tools receive only opaque grant IDs. */
export class FolderAccessService {
  private inFlight = new Map<string, Set<AbortController>>();
  private helpers = new Set<AbortController>();
  private writes = new Map<string, Promise<unknown>>();
  private resolutions = new Map<string, Promise<FolderRequestDetail>>();
  private closed = false;
  constructor(
    private db: DatabaseSync,
    readonly ownerId: string,
    private scope: Scope,
    private resolutionOptions: FolderResolutionOptions = {},
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS folder_requests (id TEXT NOT NULL, ownerId TEXT NOT NULL, threadId TEXT NOT NULL, dotId TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(ownerId,id));
      CREATE INDEX IF NOT EXISTS folder_requests_thread ON folder_requests(ownerId,threadId);
      CREATE TABLE IF NOT EXISTS folder_grants (id TEXT NOT NULL, ownerId TEXT NOT NULL, dotId TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(ownerId,id));
      CREATE INDEX IF NOT EXISTS folder_grants_dot ON folder_grants(ownerId,dotId);
    `);
    initializeProjectExecutionSchema(db);
  }
  close() {
    this.closed = true;
    for (const controller of this.helpers) controller.abort();
    for (const operations of this.inFlight.values())
      for (const controller of operations) controller.abort();
  }
  private async runHelper(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (this.closed)
      throw new FolderAccessError('Folder service is closed.', 503);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    this.helpers.add(controller);
    try {
      return await helper(input, controller.signal);
    } finally {
      signal?.removeEventListener('abort', abort);
      this.helpers.delete(controller);
    }
  }
  private requireDot(dotId: string) {
    if (this.closed)
      throw new FolderAccessError('Folder service is closed.', 503);
    try {
      this.scope.requireDot(dotId);
    } catch {
      throw new FolderAccessError('Dot not found.', 404);
    }
  }
  private requireThread(threadId: string, dotId?: string) {
    if (this.closed)
      throw new FolderAccessError('Folder service is closed.', 503);
    try {
      const thread = this.scope.requireThread(threadId, dotId);
      this.requireDot(thread.dotId);
      return thread;
    } catch {
      throw new FolderAccessError(
        'Folder request not found in this conversation.',
        404,
      );
    }
  }
  request(
    dotId: string,
    threadId: string,
    input: z.input<typeof folderRequestSchema>,
    executionThreadId = threadId,
  ): FolderRequest {
    this.requireDot(dotId);
    this.requireThread(threadId, dotId);
    this.requireThread(executionThreadId, dotId);
    const parsed = folderRequestSchema.parse(input);
    const request: FolderRequest = {
      id: randomUUID(),
      threadId,
      dotId,
      reason: parsed.reason,
      folderHint: parsed.folderHint,
      requestedAccess: parsed.access,
      status: 'pending',
      expiresAt: Date.now() + TTL,
    };
    this.db
      .prepare('INSERT INTO folder_requests VALUES (?,?,?,?,?)')
      .run(
        request.id,
        this.ownerId,
        threadId,
        dotId,
        JSON.stringify({ request, executionThreadId }),
      );
    return request;
  }
  private storedRequest(threadId: string, requestId: string): StoredRequest {
    const thread = this.requireThread(threadId);
    const row = this.db
      .prepare(
        'SELECT value FROM folder_requests WHERE ownerId=? AND threadId=? AND id=? AND dotId=?',
      )
      .get(this.ownerId, threadId, requestId, thread.dotId);
    if (!row)
      throw new FolderAccessError(
        'Folder request not found in this conversation.',
        404,
      );
    return JSON.parse(String(row.value)) as StoredRequest;
  }
  private saveRequest(value: StoredRequest) {
    this.db
      .prepare('UPDATE folder_requests SET value=? WHERE ownerId=? AND id=?')
      .run(JSON.stringify(value), this.ownerId, value.request.id);
  }
  private pending(value: StoredRequest, allowExpired = false) {
    if (value.request.status !== 'pending')
      throw new FolderAccessError('Folder request was already decided.', 409);
    if (!allowExpired && value.request.expiresAt <= Date.now())
      throw new FolderAccessError(
        'Folder request expired. Ask the Dot to request access again.',
        410,
      );
  }
  private storedGrant(dotId: string, grantId: string): StoredGrant | undefined {
    const row = this.db
      .prepare(
        'SELECT value FROM folder_grants WHERE ownerId=? AND dotId=? AND id=?',
      )
      .get(this.ownerId, dotId, grantId);
    return row ? (JSON.parse(String(row.value)) as StoredGrant) : undefined;
  }
  private publicGrant({
    identity: _identity,
    ...grant
  }: StoredGrant): FolderGrant {
    return grant;
  }
  private publicSelection({
    identity: _identity,
    ...selection
  }: StoredSelection): FolderSelection {
    return selection;
  }
  private currentDecision(value: StoredRequest): FolderDecision | undefined {
    if (value.decision?.approved && value.request.grantId) {
      const grant = this.storedGrant(
        value.request.dotId,
        value.request.grantId,
      );
      if (!grant || grant.revokedAt !== undefined)
        return {
          approved: false,
          message: 'Folder access was revoked. Request owner approval again.',
        };
    }
    return value.decision;
  }
  getRequest(threadId: string, requestId: string): FolderRequestDetail {
    const value = this.storedRequest(threadId, requestId);
    const grant = value.request.grantId
      ? this.storedGrant(value.request.dotId, value.request.grantId)
      : undefined;
    return {
      request: value.request,
      ...(value.selection
        ? { selection: this.publicSelection(value.selection) }
        : {}),
      ...(grant ? { grant: this.publicGrant(grant) } : {}),
      ...(value.decision ? { decision: this.currentDecision(value) } : {}),
    };
  }
  /** Metadata discovery only; canonical conversation messages determine pending reviews. */
  reviewRequests(): {
    requestId: string;
    threadId: string;
    dotId: string;
    toolCallId?: string;
  }[] {
    if (this.closed)
      throw new FolderAccessError('Folder service is closed.', 503);
    const threads = new Map<string, string | undefined>();
    // Include expired requests and saved decisions: the owner can still decline,
    // or deliver an already-saved decision through the original client tool.
    return this.db
      .prepare(
        `SELECT id, threadId, dotId, json_extract(value, '$.toolCallId') AS toolCallId
         FROM folder_requests WHERE ownerId=? AND json_valid(value)
         AND json_extract(value, '$.request.id')=id
         AND json_extract(value, '$.request.threadId')=threadId
         AND json_extract(value, '$.request.dotId')=dotId
         ORDER BY rowid DESC`,
      )
      .all(this.ownerId)
      .flatMap((row) => {
        const threadId = String(row.threadId);
        const dotId = String(row.dotId);
        if (!threads.has(threadId)) {
          try {
            threads.set(threadId, this.requireThread(threadId).dotId);
          } catch {
            threads.set(threadId, undefined);
          }
        }
        if (threads.get(threadId) !== dotId) return [];
        return [
          {
            requestId: String(row.id),
            threadId,
            dotId,
            ...(typeof row.toolCallId === 'string'
              ? { toolCallId: row.toolCallId }
              : {}),
          },
        ];
      });
  }
  async select(
    threadId: string,
    requestId: string,
    path: string,
  ): Promise<FolderSelection> {
    const value = this.storedRequest(threadId, requestId);
    this.pending(value);
    pathSchema.parse(path);
    const inspection = inspectionSchema.parse(
      await this.runHelper({ action: 'inspect', root: path }),
    );
    const current = this.storedRequest(threadId, requestId);
    this.pending(current);
    current.selection = { id: randomUUID(), ...inspection };
    this.saveRequest(current);
    return this.publicSelection(current.selection);
  }
  /** Propose a verified folder from the immutable request, without granting access. */
  async resolve(
    threadId: string,
    requestId: string,
  ): Promise<FolderRequestDetail> {
    const value = this.storedRequest(threadId, requestId);
    if (!this.canResolve(value)) return this.getRequest(threadId, requestId);
    const previous = this.resolutions.get(requestId);
    if (previous) return previous;
    const pending = this.resolveHint(
      threadId,
      requestId,
      value.request.folderHint,
    );
    this.resolutions.set(requestId, pending);
    try {
      return await pending;
    } finally {
      this.resolutions.delete(requestId);
    }
  }
  private canResolve(value: StoredRequest) {
    return (
      value.request.status === 'pending' &&
      !value.decision &&
      !value.selection &&
      value.request.expiresAt > Date.now()
    );
  }
  private async resolveHint(threadId: string, requestId: string, hint: string) {
    const controller = new AbortController();
    this.helpers.add(controller);
    let inspection: z.infer<typeof inspectionSchema> | undefined;
    try {
      const candidate = await folderHintCandidate(
        hint,
        this.resolutionOptions,
        controller.signal,
      );
      if (
        candidate &&
        this.canResolve(this.storedRequest(threadId, requestId))
      ) {
        const result = inspectionSchema.parse(
          await this.runHelper(
            { action: 'inspect', root: candidate.path },
            controller.signal,
          ),
        );
        // A named/home-relative match must stay inside home after symlink canonicalization.
        if (!candidate.home || withinHome(result.path, candidate.home))
          inspection = result;
      }
    } catch {
      // A missing folder, unavailable metadata index or failed inspection uses the chooser.
    } finally {
      this.helpers.delete(controller);
    }
    const current = this.storedRequest(threadId, requestId);
    if (inspection && this.canResolve(current)) {
      current.selection = { id: randomUUID(), ...inspection };
      this.saveRequest(current);
    }
    return this.getRequest(threadId, requestId);
  }
  async decide(
    threadId: string,
    requestId: string,
    input: z.input<typeof folderDecisionSchema>,
  ): Promise<FolderDecision> {
    const parsed = folderDecisionSchema.parse(input);
    let value = this.storedRequest(threadId, requestId);
    if (value.decision) {
      if (value.toolCallId !== parsed.toolCallId)
        throw new FolderAccessError(
          'Folder request was already decided by another tool call.',
          409,
        );
      return this.currentDecision(value)!;
    }
    this.pending(value, !parsed.approve);
    if (parsed.approve) {
      if (
        !value.selection ||
        value.selection.id !== parsed.selectionId ||
        !parsed.access
      )
        throw new FolderAccessError(
          'Choose a current folder selection and access level before approval.',
        );
      await this.runHelper({
        action: 'verify',
        root: value.selection.path,
        identity: value.selection.identity,
      });
      // Selection, scope, expiry, and decision may have changed during filesystem I/O.
      value = this.storedRequest(threadId, requestId);
      if (value.decision) {
        if (value.toolCallId !== parsed.toolCallId)
          throw new FolderAccessError(
            'Folder request was already decided by another tool call.',
            409,
          );
        return this.currentDecision(value)!;
      }
      this.pending(value);
      if (!value.selection || value.selection.id !== parsed.selectionId)
        throw new FolderAccessError(
          'The folder selection changed. Review it again.',
          409,
        );
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (parsed.approve) {
        const selection = value.selection!;
        const grant: StoredGrant = {
          id: randomUUID(),
          dotId: value.request.dotId,
          name: selection.name,
          path: selection.path,
          identity: selection.identity,
          access: parsed.access!,
          createdAt: Date.now(),
        };
        this.db
          .prepare('INSERT INTO folder_grants VALUES (?,?,?,?)')
          .run(grant.id, this.ownerId, grant.dotId, JSON.stringify(grant));
        // A decision belongs to its task. Updating a shared parent here can
        // redirect or interrupt another task while this approval waits for admission.
        if (grant.access === 'execute')
          this.db
            .prepare(
              'INSERT OR REPLACE INTO project_execution_bindings VALUES (?,?,?,?)',
            )
            .run(this.ownerId, threadId, grant.dotId, grant.id);
        value.request.status = 'approved';
        value.request.grantId = grant.id;
        value.decision = {
          approved: true,
          grantId: grant.id,
          name: grant.name,
          access: grant.access,
          message:
            'The owner selected and approved this folder for the current request, replacing any earlier folder hint. Continue the requested work in this selected folder using its grant ID; do not ask to reconfirm the replacement.',
        };
      } else {
        value.request.status = 'declined';
        value.decision = {
          approved: false,
          message: 'The owner declined folder access.',
        };
      }
      value.toolCallId = parsed.toolCallId;
      this.saveRequest(value);
      this.db.exec('COMMIT');
      return value.decision;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  list(dotId: string): FolderGrant[] {
    this.requireDot(dotId);
    return this.db
      .prepare(
        'SELECT value FROM folder_grants WHERE ownerId=? AND dotId=? ORDER BY rowid',
      )
      .all(this.ownerId, dotId)
      .map((row) => JSON.parse(String(row.value)) as StoredGrant)
      .filter((grant) => grant.revokedAt === undefined)
      .map((grant) => this.publicGrant(grant));
  }
  /** Model catalog only: retain stale owner records, and never renew their identity. */
  async available(dotId: string): Promise<FolderGrant[]> {
    this.requireDot(dotId);
    const grants = this.db
      .prepare(
        'SELECT value FROM folder_grants WHERE ownerId=? AND dotId=? ORDER BY rowid',
      )
      .all(this.ownerId, dotId)
      .map((row) => JSON.parse(String(row.value)) as StoredGrant)
      .filter((grant) => grant.revokedAt === undefined);
    const verified = new Map<string, boolean>();
    const candidates: StoredGrant[] = [];
    for (const grant of grants) {
      const key = JSON.stringify([
        grant.path,
        grant.identity.dev,
        grant.identity.ino,
      ]);
      if (!verified.has(key)) {
        try {
          await this.runHelper({
            action: 'verify',
            root: grant.path,
            identity: grant.identity,
          });
          verified.set(key, true);
        } catch (error) {
          if (
            !(error instanceof FolderAccessError) ||
            error.status !== 400 ||
            error.code !== 'folder_unavailable'
          )
            throw error;
          verified.set(key, false);
        }
      }
      if (verified.get(key)) candidates.push(grant);
    }
    this.requireDot(dotId);
    const available = new Map<string, FolderGrant>();
    // Revocation may run during any helper. Keep only current grants, then choose
    // the newest duplicate at each access level without elevating permission.
    for (const grant of candidates) {
      const current = this.storedGrant(dotId, grant.id);
      if (!current || current.revokedAt !== undefined) continue;
      const key = JSON.stringify([
        grant.path,
        grant.identity.dev,
        grant.identity.ino,
        grant.access,
      ]);
      available.set(key, this.publicGrant(grant));
    }
    return [...available.values()];
  }
  revoke(dotId: string, grantId: string) {
    this.requireDot(dotId);
    const grant = this.storedGrant(dotId, grantId);
    if (!grant) throw new FolderAccessError('Folder grant not found.', 404);
    grant.revokedAt ??= Date.now();
    this.db
      .prepare('UPDATE folder_grants SET value=? WHERE ownerId=? AND id=?')
      .run(JSON.stringify(grant), this.ownerId, grantId);
    for (const controller of this.inFlight.get(grantId) ?? [])
      controller.abort();
    return { revoked: true };
  }
  /** Bind an existing owner-approved execution grant; this cannot elevate read/edit grants. */
  async bindExecution(dotId: string, threadId: string, grantId: string) {
    this.requireThread(threadId, dotId);
    const grant = await this.verifyExecutionGrant(dotId, grantId);
    this.requireThread(threadId, dotId);
    this.authorized(dotId, grantId);
    this.db
      .prepare(
        'INSERT OR REPLACE INTO project_execution_bindings VALUES (?,?,?,?)',
      )
      .run(this.ownerId, threadId, dotId, grantId);
    return { grantId, name: grant.name, access: 'execute' as const };
  }
  private async verifyExecutionGrant(dotId: string, grantId: string) {
    const grant = this.authorized(dotId, grantId);
    if (grant.access !== 'execute')
      throw new FolderAccessError(
        'This project needs explicit permission to run commands.',
        403,
      );
    await this.runHelper({
      action: 'verify',
      root: grant.path,
      identity: grant.identity,
    });
    this.authorized(dotId, grantId);
    return grant;
  }
  async executionScope(
    dotId: string,
    threadId: string,
  ): Promise<FolderExecutionScope | undefined> {
    this.requireThread(threadId, dotId);
    const binding = this.db
      .prepare(
        'SELECT grantId FROM project_execution_bindings WHERE ownerId=? AND dotId=? AND threadId=?',
      )
      .get(this.ownerId, dotId, threadId);
    if (!binding) return undefined;
    const grant = await this.verifyExecutionGrant(
      dotId,
      String(binding.grantId),
    );
    return {
      grantId: grant.id,
      path: grant.path,
      identity: grant.identity,
      access: 'execute',
    };
  }
  private authorized(dotId: string, grantId: string, write = false) {
    this.requireDot(dotId);
    const grant = this.storedGrant(dotId, grantId);
    if (!grant || grant.revokedAt !== undefined)
      throw new FolderAccessError(
        'Folder permission is missing or revoked.',
        403,
      );
    if (write && grant.access !== 'readwrite' && grant.access !== 'execute')
      throw new FolderAccessError('This folder has read-only permission.', 403);
    return grant;
  }
  private async operate(
    dotId: string,
    grantId: string,
    action: 'read' | 'write' | 'list',
    path: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const grant = this.authorized(dotId, grantId, action === 'write');
    pathSchema.parse(path);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const operations = this.inFlight.get(grantId) ?? new Set<AbortController>();
    operations.add(controller);
    this.inFlight.set(grantId, operations);
    try {
      const result = await this.runHelper(
        { ...input, action, root: grant.path, identity: grant.identity, path },
        controller.signal,
      );
      this.authorized(dotId, grantId, action === 'write');
      if (controller.signal.aborted)
        throw new FolderAccessError('Folder operation was cancelled.', 403);
      return result;
    } finally {
      signal?.removeEventListener('abort', abort);
      operations.delete(controller);
      if (!operations.size) this.inFlight.delete(grantId);
    }
  }
  async listDirectory(
    dotId: string,
    grantId: string,
    relativePath = '.',
    signal?: AbortSignal,
  ) {
    return listingSchema.parse(
      await this.operate(dotId, grantId, 'list', relativePath, {}, signal),
    );
  }
  async readFile(
    dotId: string,
    grantId: string,
    relativePath: string,
    signal?: AbortSignal,
  ) {
    return readResultSchema.parse(
      await this.operate(dotId, grantId, 'read', relativePath, {}, signal),
    );
  }
  async writeFile(
    dotId: string,
    grantId: string,
    relativePath: string,
    input: z.input<typeof writeSchema>,
    signal?: AbortSignal,
  ) {
    const grant = this.authorized(dotId, grantId, true);
    const parsed = writeSchema.parse(input);
    pathSchema.parse(relativePath);
    // Canonical roots make overlapping grants share a destination queue. The
    // helper also locks the physical parent directory across server processes.
    const destination = resolve(grant.path, relativePath);
    const previous = this.writes.get(destination) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () =>
        writeResultSchema.parse(
          await this.operate(
            dotId,
            grantId,
            'write',
            relativePath,
            parsed,
            signal,
          ),
        ),
      );
    this.writes.set(destination, operation);
    try {
      return await operation;
    } finally {
      if (this.writes.get(destination) === operation)
        this.writes.delete(destination);
    }
  }
}
