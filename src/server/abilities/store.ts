import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  parseManifest,
  parseReleaseDescriptor,
  validateValue,
} from '../../shared/abilities/manifest.js';
import { parseOutcome } from '../../shared/abilities/protocol.js';
import { canonicalJson } from '../../shared/abilities/permissions.js';
import type {
  Binding,
  InvocationContext,
  InvocationOutcome,
  JsonValue,
  VerifiedPackage,
} from '../../shared/abilities/types.js';
import { beginSQLiteTransaction } from '../storage/sqlite-transaction.js';

export function initializeAbilitySchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ability_packages(
    digest TEXT PRIMARY KEY CHECK(length(digest)=64), descriptor TEXT NOT NULL CHECK(json_valid(descriptor)),
    files TEXT NOT NULL CHECK(json_valid(files)), installedAt INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS ability_bindings(
      id TEXT PRIMARY KEY,dotId TEXT NOT NULL REFERENCES dots(id),source TEXT NOT NULL,abilityId TEXT NOT NULL,
      digest TEXT NOT NULL REFERENCES ability_packages(digest),grants TEXT NOT NULL CHECK(json_valid(grants)),
      settings TEXT NOT NULL CHECK(json_valid(settings)),revision INTEGER NOT NULL CHECK(revision>0 AND revision<=9007199254740991),
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),approvedAt INTEGER NOT NULL,
      restored INTEGER NOT NULL DEFAULT 0 CHECK(restored IN (0,1)),UNIQUE(dotId,source,abilityId)) STRICT;
    CREATE TABLE IF NOT EXISTS ability_receipts(
      invocationId TEXT PRIMARY KEY,bindingId TEXT NOT NULL,context TEXT NOT NULL CHECK(json_valid(context)),
      state TEXT NOT NULL CHECK(state IN ('running','settled')),outcome TEXT CHECK(outcome IS NULL OR json_valid(outcome)),
      createdAt INTEGER NOT NULL,settledAt INTEGER,
      CHECK((state='running' AND outcome IS NULL AND settledAt IS NULL) OR (state='settled' AND outcome IS NOT NULL AND settledAt IS NOT NULL))) STRICT;
    CREATE INDEX IF NOT EXISTS ability_receipts_binding ON ability_receipts(bindingId,state);`);
}
const boundedId = z.string().min(1).max(256);
const contextSchema = z.strictObject({
  workspaceId: boundedId,
  sessionId: boundedId,
  dotId: boundedId,
  bindingId: z.string().uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  grantRevision: z.number().int().positive().safe(),
  invocationId: boundedId,
  tool: boundedId,
  threadId: boundedId,
});
export type PackageRecord = Omit<VerifiedPackage, 'root'>;
export type AbilityReceipt = {
  context: InvocationContext;
  state: 'running' | 'settled';
  outcome?: { status: InvocationOutcome['status']; code?: string };
};

export class AbilityStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly ownerId: string,
  ) {
    initializeAbilitySchema(db);
    // A new storage owner never resumes a call whose effect is unknown.
    db.prepare(
      "UPDATE ability_receipts SET state='settled',outcome=?,settledAt=? WHERE state='running'",
    ).run('{"status":"uncertain"}', Date.now());
  }
  private transaction<T>(action: () => T): T {
    const transaction = beginSQLiteTransaction(this.db);
    try {
      const result = action();
      transaction.commit();
      return result;
    } catch (error) {
      transaction.rollback();
      throw error;
    }
  }
  recordPackage(pkg: VerifiedPackage): void {
    const descriptor = parseReleaseDescriptor(pkg.descriptor);
    if (
      pkg.digest !== descriptor.asset.sha256 ||
      canonicalJson(parseManifest(pkg.manifest)) !==
        canonicalJson(descriptor.manifest)
    )
      throw new Error('Ability package identity mismatch');
    const files = z
      .array(
        z.strictObject({
          path: z.string().min(1).max(1024),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          size: z.number().int().nonnegative().safe(),
          executable: z.boolean(),
        }),
      )
      .max(20_000)
      .parse(pkg.files);
    if (
      files.length !== descriptor.asset.fileCount ||
      files.reduce((total, file) => total + file.size, 0) !==
        descriptor.asset.extractedBytes
    )
      throw new Error('Ability package inventory mismatch');
    const encoded = canonicalJson(descriptor),
      inventory = canonicalJson(files);
    this.transaction(() => {
      const previous = this.db
        .prepare('SELECT descriptor,files FROM ability_packages WHERE digest=?')
        .get(pkg.digest);
      if (
        previous &&
        (previous.descriptor !== encoded || previous.files !== inventory)
      )
        throw new Error('Conflicting Ability package identity');
      this.db
        .prepare('INSERT OR IGNORE INTO ability_packages VALUES(?,?,?,?)')
        .run(pkg.digest, encoded, inventory, Date.now());
    });
  }
  package(digest: string): PackageRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM ability_packages WHERE digest=?')
      .get(digest);
    if (!row) return undefined;
    const descriptor = parseReleaseDescriptor(
      JSON.parse(String(row.descriptor)),
    );
    return {
      digest,
      descriptor,
      manifest: descriptor.manifest,
      files: JSON.parse(String(row.files)),
    };
  }
  packages(): PackageRecord[] {
    return this.db
      .prepare('SELECT digest FROM ability_packages ORDER BY digest')
      .all()
      .map((row) => this.package(String(row.digest))!);
  }
  removePackage(digest: string): void {
    if (this.bindingsForDigest(digest).length)
      throw new Error('Ability is still bound to a Dot');
    this.db.prepare('DELETE FROM ability_packages WHERE digest=?').run(digest);
  }
  private requireDot(dotId: string): void {
    if (!this.db.prepare('SELECT id FROM dots WHERE id=?').get(dotId))
      throw new Error('Dot not found');
  }
  bind(
    dotId: string,
    digest: string,
    grants: string[],
    settings: Record<string, JsonValue>,
  ): Binding {
    return this.transaction(() => {
      this.requireDot(dotId);
      const pkg = this.package(digest);
      if (!pkg) throw new Error('Ability package is not installed');
      if (
        grants.length > 100 ||
        new Set(grants).size !== grants.length ||
        grants.some(
          (id) =>
            !pkg.manifest.permissions.some(
              (permission) => permission.id === id,
            ),
        )
      )
        throw new Error('Unknown Ability grant');
      const validated = validateValue(pkg.manifest.settings, settings);
      const source = `${pkg.manifest.source.owner}/${pkg.manifest.source.repository}`;
      const old = this.db
        .prepare(
          'SELECT id,revision FROM ability_bindings WHERE dotId=? AND source=? AND abilityId=?',
        )
        .get(dotId, source, pkg.manifest.id);
      const id = old ? String(old.id) : randomUUID();
      this.interrupt(id);
      this.db
        .prepare(
          `INSERT INTO ability_bindings VALUES(?,?,?,?,?,?,?,?,1,?,0)
        ON CONFLICT(dotId,source,abilityId) DO UPDATE SET digest=excluded.digest,grants=excluded.grants,settings=excluded.settings,
        revision=excluded.revision,enabled=1,approvedAt=excluded.approvedAt,restored=0`,
        )
        .run(
          id,
          dotId,
          source,
          pkg.manifest.id,
          digest,
          JSON.stringify([...grants].sort()),
          JSON.stringify(validated),
          Number(old?.revision ?? 0) + 1,
          Date.now(),
        );
      return this.get(id)!;
    });
  }
  list(dotId: string): Binding[] {
    return this.db
      .prepare('SELECT id FROM ability_bindings WHERE dotId=? ORDER BY id')
      .all(dotId)
      .map((row) => this.get(String(row.id))!);
  }
  bindingsForDigest(digest: string): Binding[] {
    return this.db
      .prepare('SELECT id FROM ability_bindings WHERE digest=? ORDER BY id')
      .all(digest)
      .map((row) => this.get(String(row.id))!);
  }
  get(id: string): Binding | undefined {
    const row = this.db
      .prepare('SELECT * FROM ability_bindings WHERE id=?')
      .get(id);
    if (!row) return undefined;
    const pkg = this.package(String(row.digest));
    if (!pkg) throw new Error('Ability binding lost its package');
    return {
      id,
      dotId: String(row.dotId),
      digest: pkg.digest,
      manifest: pkg.manifest,
      grants: JSON.parse(String(row.grants)),
      settings: JSON.parse(String(row.settings)),
      revision: Number(row.revision),
      enabled: Boolean(row.enabled),
      approvedAt: Number(row.approvedAt),
      restored: Boolean(row.restored),
    };
  }
  private require(id: string): Binding {
    const binding = this.get(id);
    if (!binding) throw new Error('Ability binding not found');
    return binding;
  }
  private interrupt(id: string): void {
    this.db
      .prepare(
        "UPDATE ability_receipts SET state='settled',outcome=?,settledAt=? WHERE bindingId=? AND state='running'",
      )
      .run('{"status":"uncertain"}', Date.now(), id);
  }
  revoke(id: string): Binding {
    return this.transaction(() => {
      this.require(id);
      this.interrupt(id);
      this.db
        .prepare(
          'UPDATE ability_bindings SET enabled=0,revision=revision+1 WHERE id=?',
        )
        .run(id);
      return this.get(id)!;
    });
  }
  enable(id: string): Binding {
    return this.transaction(() => {
      const binding = this.require(id);
      if (binding.restored)
        throw new Error('Restored Ability needs a new review');
      if (!binding.enabled)
        this.db
          .prepare(
            'UPDATE ability_bindings SET enabled=1,revision=revision+1 WHERE id=?',
          )
          .run(id);
      return this.get(id)!;
    });
  }
  configure(id: string, settings: Record<string, JsonValue>): Binding {
    return this.transaction(() => {
      const binding = this.require(id);
      const value = validateValue(binding.manifest.settings, settings);
      this.interrupt(id);
      // Credentials include client ID and consent revision. An old account cannot
      // satisfy the changed configuration, even if the provider account is equal.
      this.db
        .prepare(
          'UPDATE ability_bindings SET settings=?,revision=revision+1 WHERE id=?',
        )
        .run(JSON.stringify(value), id);
      return this.get(id)!;
    });
  }
  forget(id: string): void {
    this.transaction(() => {
      this.interrupt(id);
      this.db.prepare('DELETE FROM ability_bindings WHERE id=?').run(id);
    });
  }
  fingerprint(dotId: string): string {
    return this.db
      .prepare(
        'SELECT id,revision,enabled FROM ability_bindings WHERE dotId=? ORDER BY id',
      )
      .all(dotId)
      .map((binding) => `${binding.id}:${binding.revision}:${binding.enabled}`)
      .join(',');
  }
  claimInvocation(input: InvocationContext): boolean {
    const parsed = contextSchema.safeParse(input);
    if (!parsed.success) return false;
    const context = parsed.data;
    return this.transaction(() => {
      const binding = this.get(context.bindingId);
      if (
        !binding ||
        !binding.enabled ||
        binding.restored ||
        binding.dotId !== context.dotId ||
        binding.digest !== context.digest ||
        binding.revision !== context.grantRevision ||
        !binding.manifest.tools.some((tool) => tool.id === context.tool)
      )
        return false;
      if (
        !this.db
          .prepare(
            'SELECT id FROM thread_bindings WHERE id=? AND dotId=? AND ownerId=? AND deletedAt IS NULL',
          )
          .get(context.threadId, context.dotId, this.ownerId)
      )
        return false;
      return (
        this.db
          .prepare(
            "INSERT OR IGNORE INTO ability_receipts VALUES(?,?,?,'running',NULL,?,NULL)",
          )
          .run(
            context.invocationId,
            context.bindingId,
            JSON.stringify(context),
            Date.now(),
          ).changes > 0
      );
    });
  }
  settleInvocation(invocationId: string, input: InvocationOutcome): void {
    const outcome = parseOutcome(input);
    const generic =
      outcome.status === 'error'
        ? { status: outcome.status, code: outcome.code }
        : { status: outcome.status };
    this.db
      .prepare(
        "UPDATE ability_receipts SET state='settled',outcome=?,settledAt=? WHERE invocationId=? AND state='running'",
      )
      .run(JSON.stringify(generic), Date.now(), invocationId);
  }
  receipt(invocationId: string): AbilityReceipt | undefined {
    const row = this.db
      .prepare(
        'SELECT context,state,outcome FROM ability_receipts WHERE invocationId=?',
      )
      .get(invocationId);
    if (!row) return undefined;
    return {
      context: contextSchema.parse(JSON.parse(String(row.context))),
      state: row.state as AbilityReceipt['state'],
      ...(row.outcome ? { outcome: JSON.parse(String(row.outcome)) } : {}),
    };
  }
}
