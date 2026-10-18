import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  folderDecisionSchema,
  folderRequestSchema,
  type FolderDecision,
  type FolderGrant,
  type FolderRequest,
  type FolderRequestDetail,
  type FolderSelection,
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
  ) {
    super(message);
  }
}

const sourceHelper = fileURLToPath(
  new URL('../../scripts/folder-access.py', import.meta.url),
);
const helperPath = existsSync(sourceHelper)
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
    const child = spawn(
      process.env.DOTS_FOLDER_PYTHON || 'python3',
      ['-I', helperPath],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
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
    child.on('error', () => {
      error ??= new FolderAccessError(
        'Python 3 is required for local folder access.',
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
      if (error) return reject(error);
      if (code !== 0)
        return reject(
          new FolderAccessError('Folder operation could not complete.', 503),
        );
      try {
        const result = z
          .discriminatedUnion('ok', [
            z.object({ ok: z.literal(true), result: z.unknown() }),
            z.object({ ok: z.literal(false), error: z.string().max(300) }),
          ])
          .parse(JSON.parse(output));
        if (!result.ok) return reject(new FolderAccessError(result.error));
        resolveResult(result.result);
      } catch {
        reject(
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

/** Owner decisions are durable; model tools receive only opaque grant IDs. */
export class FolderAccessService {
  private inFlight = new Map<string, Set<AbortController>>();
  private helpers = new Set<AbortController>();
  private writes = new Map<string, Promise<unknown>>();
  private closed = false;
  constructor(
    private db: DatabaseSync,
    readonly ownerId: string,
    private scope: Scope,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS folder_requests (id TEXT NOT NULL, ownerId TEXT NOT NULL, threadId TEXT NOT NULL, dotId TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(ownerId,id));
      CREATE INDEX IF NOT EXISTS folder_requests_thread ON folder_requests(ownerId,threadId);
      CREATE TABLE IF NOT EXISTS folder_grants (id TEXT NOT NULL, ownerId TEXT NOT NULL, dotId TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(ownerId,id));
      CREATE INDEX IF NOT EXISTS folder_grants_dot ON folder_grants(ownerId,dotId);
    `);
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
  ): FolderRequest {
    this.requireDot(dotId);
    this.requireThread(threadId, dotId);
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
        JSON.stringify({ request }),
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
        value.request.status = 'approved';
        value.request.grantId = grant.id;
        value.decision = {
          approved: true,
          grantId: grant.id,
          name: grant.name,
          access: grant.access,
          message:
            'The owner approved this folder. Use its grant ID for folder tools.',
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
  private authorized(dotId: string, grantId: string, write = false) {
    this.requireDot(dotId);
    const grant = this.storedGrant(dotId, grantId);
    if (!grant || grant.revokedAt !== undefined)
      throw new FolderAccessError(
        'Folder permission is missing or revoked.',
        403,
      );
    if (write && grant.access !== 'readwrite')
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
