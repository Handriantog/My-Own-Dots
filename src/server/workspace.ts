import { beginSQLiteTransaction } from './storage/sqlite-transaction.js';
import {
  DEFAULT_DOT_CUSTOMIZATION,
  dotCustomizationSchema,
  dotCustomizationChangeSchema,
  type DesktopDotState,
} from '../shared/dot-customization.js';
import type {
  MarkableMessage,
  MessageMark,
  MessageMarkKind,
} from '../shared/message-marks.js';
import { MemoryStore } from './memory-store.js';
import { ComputerStore } from './computer-store.js';
import { ConnectionStore } from './connection-store.js';
import { AbilityStore } from './abilities/store.js';
import { FolderAccessService } from './folder-access.js';
import { Pages } from './pages.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { VoiceDelivery } from '../shared/local-voice.js';
import {
  DEFAULT_VOICE_SETTINGS,
  voiceSettingsSchema,
  voiceSettingsUpdateSchema,
  type VoiceSettings,
} from '../shared/voice-settings.js';
import { validateLearningSettings } from '../shared/learning.js';
import type {
  CallReceipt,
  Conversation,
  ConversationUpdate,
  Dot,
  Space,
} from '../shared/types.js';
export class WorkspaceStore {
  private db: DatabaseSync;
  private ownsDatabase: boolean;
  readonly memory: MemoryStore;
  readonly pages: Pages;
  readonly computers: ComputerStore;
  readonly connections: ConnectionStore;
  readonly abilities: AbilityStore;
  readonly folders: FolderAccessService;
  constructor(
    path: string,
    readonly ownerId: string,
    database?: DatabaseSync,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.ownsDatabase = !database;
    this.db = database ?? new DatabaseSync(path);
    if (!database)
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_threads(taskId TEXT PRIMARY KEY, threadId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, startedAt INTEGER NOT NULL, endedAt INTEGER, status TEXT NOT NULL, transcript TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS local_voice_delivery(callId TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dot_voice_settings(dotId TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desktop_dot(id INTEGER PRIMARY KEY CHECK(id=1), dotId TEXT, initialized INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS captures(threadId TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS message_marks(
      threadId TEXT NOT NULL, messageId TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, pinnedAt INTEGER, bookmarkedAt INTEGER,
      PRIMARY KEY(threadId, messageId));`);
    for (const [table, column, definition] of [
      ['dots', 'learningContainerId', 'TEXT'],
      ['dots', 'skillDeliveryEnabled', 'INTEGER NOT NULL DEFAULT 0'],
      ['dots', 'appsAllowed', 'INTEGER NOT NULL DEFAULT 0'],
      ['dots', 'composioToolkits', "TEXT NOT NULL DEFAULT '[]'"],
      ['dots', 'composioSessionId', 'TEXT'],
      ['dots', 'composioPolicyHash', 'TEXT'],
      ['dots', 'customization', 'TEXT'],
      ['thread_bindings', 'learningContainerId', 'TEXT'],
      ['thread_bindings', 'pinnedAt', 'INTEGER'],
      ['thread_bindings', 'deletedAt', 'INTEGER'],
    ]) {
      if (
        !this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((field) => field.name === column)
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    // Migrate only once: restarting must never restore a revoked grant.
    if (
      !this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='dot_spaces'",
        )
        .get()
    ) {
      this.db.exec(`SAVEPOINT workspace_schema;
        CREATE TABLE dot_spaces(dotId TEXT NOT NULL, spaceId TEXT NOT NULL, PRIMARY KEY(dotId, spaceId));
        INSERT INTO dot_spaces SELECT id, spaceId FROM dots;
        RELEASE workspace_schema;`);
    }
    this.memory = new MemoryStore(this.db, ownerId);
    this.computers = new ComputerStore(this.db);
    this.connections = new ConnectionStore(this.db);
    this.abilities = new AbilityStore(this.db, ownerId);
    this.folders = new FolderAccessService(this.db, ownerId, {
      requireDot: (id) => {
        if (!this.dot(id)) throw new Error('Dot not found.');
      },
      requireThread: (threadId, dotId) => this.requireThread(threadId, dotId),
    });
    this.pages = new Pages(this.db, (id) =>
      this.spaces().some((space) => space.id === id),
    );
    if (
      !this.db
        .prepare('PRAGMA table_info(calls)')
        .all()
        .some((column) => column.name === 'anchorMessageId')
    )
      this.db.exec('ALTER TABLE calls ADD COLUMN anchorMessageId TEXT');
    if (!this.spaces().length) {
      const space = this.createSpace(
        'Everyday',
        'A little space for your day.',
      );
      this.createDot(
        space.id,
        'Dot',
        'Be thoughtful, practical, and concise. Help the user think clearly and follow through.',
        true,
        true,
      );
    }
  }
  close() {
    this.folders.close();
    if (this.ownsDatabase) this.db.close();
  }
  spaces(): Space[] {
    return this.db
      .prepare('SELECT * FROM spaces ORDER BY createdAt')
      .all() as unknown as Space[];
  }
  createSpace(name: string, description: string): Space {
    const space = {
      id: randomUUID(),
      name,
      description,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO spaces VALUES (?, ?, ?, ?)')
      .run(space.id, name, description, space.createdAt);
    return space;
  }
  dots(): Dot[] {
    return this.db
      .prepare('SELECT * FROM dots ORDER BY createdAt')
      .all()
      .map((row) => ({
        ...row,
        customization: dotCustomizationSchema.parse(
          row.customization
            ? JSON.parse(String(row.customization))
            : DEFAULT_DOT_CUSTOMIZATION,
        ),
        spaceIds: this.db
          .prepare(
            'SELECT spaceId FROM dot_spaces WHERE dotId=? ORDER BY spaceId',
          )
          .all(String(row.id))
          .map((grant) => String(grant.spaceId)),
        researchAllowed: !!row.researchAllowed,
        memoryAllowed: !!row.memoryAllowed,
        appsAllowed: !!row.appsAllowed,
        composioToolkits: JSON.parse(String(row.composioToolkits ?? '[]')),
        skillDeliveryEnabled: !!row.skillDeliveryEnabled,
      })) as unknown as Dot[];
  }
  dot(id: string) {
    return this.dots().find((dot) => dot.id === id);
  }
  desktopDot(): DesktopDotState {
    const row = this.db
      .prepare('SELECT dotId, initialized FROM desktop_dot WHERE id=1')
      .get();
    const dots = this.dots().map(({ id, name, customization }) => ({
      id,
      name,
      customization: customization!,
    }));
    return {
      dotId:
        dots.find((dot) => dot.id === row?.dotId)?.id ?? dots[0]?.id ?? null,
      initialized: !!row?.initialized,
      dots,
    };
  }
  selectDesktopDot(dotId: string): DesktopDotState {
    if (!this.dot(dotId)) throw new Error('Dot not found.');
    this.db
      .prepare(
        'INSERT INTO desktop_dot(id,dotId) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET dotId=excluded.dotId',
      )
      .run(dotId);
    return this.desktopDot();
  }
  setDotCustomization(dotId: string, input: unknown): DesktopDotState {
    const dot = this.dot(dotId);
    if (!dot) throw new Error('Dot not found.');
    const change = dotCustomizationChangeSchema.parse(input);
    const value = dotCustomizationSchema.parse({
      ...dot.customization,
      ...change,
    });
    this.db
      .prepare('UPDATE dots SET customization=? WHERE id=?')
      .run(JSON.stringify(value), dotId);
    return this.desktopDot();
  }
  initializeDotCustomization(input: unknown): DesktopDotState {
    const value = dotCustomizationSchema.parse({
      ...DEFAULT_DOT_CUSTOMIZATION,
      ...dotCustomizationChangeSchema.parse(input),
    });
    const transaction = beginSQLiteTransaction(this.db);
    try {
      if (!this.desktopDot().initialized) {
        this.db
          .prepare(
            'UPDATE dots SET customization=? WHERE customization IS NULL',
          )
          .run(JSON.stringify(value));
        this.db
          .prepare(
            'INSERT INTO desktop_dot(id,initialized) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET initialized=1',
          )
          .run();
      }
      transaction.commit();
    } catch (error) {
      transaction.rollback();
      throw error;
    }
    return this.desktopDot();
  }
  voiceSettings(dotId: string): VoiceSettings {
    if (!this.dot(dotId)) throw new Error('Dot not found.');
    const row = this.db
      .prepare('SELECT value FROM dot_voice_settings WHERE dotId=?')
      .get(dotId);
    return row
      ? voiceSettingsSchema.parse(JSON.parse(String(row.value)))
      : { ...DEFAULT_VOICE_SETTINGS };
  }
  setVoiceSettings(dotId: string, input: unknown): VoiceSettings {
    if (!this.dot(dotId)) throw new Error('Dot not found.');
    const update = voiceSettingsUpdateSchema.parse(input);
    const settings = voiceSettingsSchema.parse({
      ...update,
      quality: update.quality ?? this.voiceSettings(dotId).quality,
    });
    this.db
      .prepare(
        'INSERT OR REPLACE INTO dot_voice_settings(dotId,value) VALUES (?,?)',
      )
      .run(dotId, JSON.stringify(settings));
    return settings;
  }
  createDot(
    spaceId: string,
    name: string,
    instructions: string,
    researchAllowed: boolean,
    memoryAllowed: boolean,
    spaceIds: string[] = [spaceId],
    learningContainerId: string | null = null,
    skillDeliveryEnabled = false,
    appsAllowed = false,
    composioToolkits: string[] = [],
  ): Dot {
    this.validateSpaceAccess(spaceId, spaceIds);
    validateLearningSettings(learningContainerId, skillDeliveryEnabled);
    const dot: Dot = {
      id: randomUUID(),
      spaceId,
      spaceIds: [...new Set(spaceIds)].sort(),
      name,
      instructions,
      researchAllowed,
      memoryAllowed,
      appsAllowed,
      composioToolkits: [...new Set(composioToolkits)].sort(),
      composioSessionId: null,
      composioPolicyHash: null,
      learningContainerId,
      skillDeliveryEnabled,
      createdAt: Date.now(),
    };
    const transaction = beginSQLiteTransaction(this.db, false);
    try {
      this.db
        .prepare(
          'INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt, learningContainerId, skillDeliveryEnabled, appsAllowed, composioToolkits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          dot.id,
          spaceId,
          name,
          instructions,
          +researchAllowed,
          +memoryAllowed,
          dot.createdAt,
          learningContainerId,
          +skillDeliveryEnabled,
          +appsAllowed,
          JSON.stringify(dot.composioToolkits),
        );
      for (const id of dot.spaceIds)
        this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(dot.id, id);
      transaction.commit();
    } catch (error) {
      transaction.rollback();
      throw error;
    }
    return dot;
  }
  canAccessSpace(dotId: string, spaceId: string) {
    return !!this.db
      .prepare('SELECT 1 FROM dot_spaces WHERE dotId=? AND spaceId=?')
      .get(dotId, spaceId);
  }
  private validateSpaceAccess(defaultSpace: string, spaceIds: string[]) {
    if (
      !spaceIds.includes(defaultSpace) ||
      spaceIds.some((id) => !this.spaces().some((space) => space.id === id))
    )
      throw new Error('Space access must include a valid default destination.');
  }
  updateDot(
    id: string,
    patch: Pick<
      Dot,
      | 'name'
      | 'instructions'
      | 'researchAllowed'
      | 'memoryAllowed'
      | 'appsAllowed'
      | 'composioToolkits'
    > & {
      spaceId?: string;
      spaceIds?: string[];
      learningContainerId?: string | null;
      skillDeliveryEnabled?: boolean;
    },
  ): Dot {
    const current = this.dot(id);
    if (!current) throw new Error('Dot not found.');
    const defaultSpace = patch.spaceId ?? current.spaceId;
    const spaceIds = patch.spaceIds ?? current.spaceIds;
    this.validateSpaceAccess(defaultSpace, spaceIds);
    const learningContainerId =
      patch.learningContainerId === undefined
        ? (current.learningContainerId ?? null)
        : patch.learningContainerId;
    const skillDeliveryEnabled =
      patch.skillDeliveryEnabled ?? current.skillDeliveryEnabled ?? false;
    validateLearningSettings(learningContainerId, skillDeliveryEnabled);
    const transaction = beginSQLiteTransaction(this.db, false);
    try {
      this.db
        .prepare(
          'UPDATE dots SET name=?, instructions=?, researchAllowed=?, memoryAllowed=?, learningContainerId=?, skillDeliveryEnabled=?, appsAllowed=?, composioToolkits=? WHERE id=?',
        )
        .run(
          patch.name,
          patch.instructions,
          +patch.researchAllowed,
          +patch.memoryAllowed,
          learningContainerId,
          +skillDeliveryEnabled,
          +patch.appsAllowed,
          JSON.stringify([...new Set(patch.composioToolkits)].sort()),
          id,
        );
      this.db
        .prepare('UPDATE dots SET spaceId=? WHERE id=?')
        .run(defaultSpace, id);
      this.db.prepare('DELETE FROM dot_spaces WHERE dotId=?').run(id);
      for (const space of new Set(spaceIds))
        this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(id, space);
      transaction.commit();
    } catch (error) {
      transaction.rollback();
      throw error;
    }
    return this.dot(id)!;
  }
  saveComposioSession(id: string, sessionId: string, policyHash: string) {
    this.db
      .prepare(
        'UPDATE dots SET composioSessionId=?, composioPolicyHash=? WHERE id=?',
      )
      .run(sessionId, policyHash, id);
  }
  conversations(): Conversation[] {
    return this.db
      .prepare(
        'SELECT * FROM thread_bindings WHERE ownerId=? AND deletedAt IS NULL ORDER BY createdAt DESC',
      )
      .all(this.ownerId) as unknown as Conversation[];
  }
  bindThread(id: string, dotId: string, title: string): Conversation {
    const dot = this.dot(dotId);
    if (!dot) throw new Error('Dot not found.');
    const value: Conversation = {
      id,
      dotId,
      ownerId: this.ownerId,
      title,
      createdAt: Date.now(),
      learningContainerId: dot.learningContainerId ?? null,
    };
    this.db
      .prepare(
        'INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt, learningContainerId) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        dotId,
        this.ownerId,
        title,
        value.createdAt,
        value.learningContainerId ?? null,
      );
    return value;
  }
  deletedConversations(): Conversation[] {
    return this.db
      .prepare(
        'SELECT * FROM thread_bindings WHERE ownerId=? AND deletedAt IS NOT NULL ORDER BY deletedAt DESC',
      )
      .all(this.ownerId) as unknown as Conversation[];
  }
  deleteConversation(id: string): Conversation {
    const transaction = beginSQLiteTransaction(this.db);
    try {
      const thread = this.requireThread(id);
      if (
        this.db
          .prepare(
            "SELECT 1 FROM calls WHERE threadId=? AND status IN ('connecting','active')",
          )
          .get(id)
      )
        throw new Error(
          'Conversation is busy. End its call before deleting it.',
        );
      const hasTable = (name: string) =>
        !!this.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(name);
      if (
        hasTable('conversation_threads') &&
        this.db
          .prepare(
            'SELECT 1 FROM conversation_threads WHERE owner_id=? AND id=? AND lease_token IS NOT NULL AND lease_until>?',
          )
          .get(this.ownerId, id, Date.now())
      )
        throw new Error(
          'Conversation is busy. Stop its response before deleting it.',
        );
      if (
        hasTable('tasks') &&
        this.db
          .prepare(
            "SELECT 1 FROM task_threads b JOIN tasks t ON t.id=b.taskId WHERE b.threadId=? AND t.status<>'cancelled'",
          )
          .get(id)
      )
        throw new Error(
          'Conversation has scheduled tasks. Cancel them in Activity before deleting it.',
        );
      if (
        hasTable('voice_delegations') &&
        this.db
          .prepare(
            "SELECT 1 FROM voice_delegations WHERE owner_id=? AND (parent_thread_id=? OR worker_thread_id=?) AND status IN ('queued','running','approval')",
          )
          .get(this.ownerId, id, id)
      )
        throw new Error(
          'Conversation is busy. Finish its voice task before deleting it.',
        );
      if (hasTable('voice_input_receipts'))
        this.db
          .prepare(
            "UPDATE voice_input_receipts SET status='interrupted',reply='Conversation moved to Trash; request was not resumed.',deliveredAt=? WHERE ownerId=? AND parentThreadId=? AND deliveredAt IS NULL",
          )
          .run(Date.now(), this.ownerId, id);
      const deletedAt = Date.now();
      this.db
        .prepare(
          'UPDATE thread_bindings SET deletedAt=? WHERE id=? AND ownerId=?',
        )
        .run(deletedAt, id, this.ownerId);
      // A page can start a fresh chat; the old binding/history remains in Trash.
      this.db.prepare('DELETE FROM page_threads WHERE threadId=?').run(id);
      transaction.commit();
      return { ...thread, deletedAt };
    } catch (error) {
      transaction.rollback();
      throw error;
    }
  }
  restoreConversation(id: string): Conversation {
    const thread = this.db
      .prepare('SELECT 1 FROM thread_bindings WHERE id=? AND ownerId=?')
      .get(id, this.ownerId);
    if (!thread)
      throw new Error('Conversation does not belong to this Dot and owner.');
    this.db
      .prepare(
        'UPDATE thread_bindings SET deletedAt=NULL WHERE id=? AND ownerId=?',
      )
      .run(id, this.ownerId);
    return this.requireThread(id);
  }
  requireThread(id: string, dotId?: string): Conversation {
    const thread = this.conversations().find((thread) => thread.id === id);
    if (!thread || (dotId && thread.dotId !== dotId))
      throw new Error('Conversation does not belong to this Dot and owner.');
    return thread;
  }
  updateConversation(id: string, patch: ConversationUpdate): Conversation {
    this.requireThread(id);
    this.db
      .prepare(
        `UPDATE thread_bindings SET
      title=COALESCE(?, title),
      pinnedAt=CASE WHEN ? IS NULL THEN pinnedAt WHEN ?=1 THEN COALESCE(pinnedAt, ?) ELSE NULL END
      WHERE id=? AND ownerId=?`,
      )
      .run(
        patch.title ?? null,
        patch.pinned === undefined ? null : Number(patch.pinned),
        Number(patch.pinned ?? false),
        Date.now(),
        id,
        this.ownerId,
      );
    return this.requireThread(id);
  }
  bindTask(taskId: string, threadId: string) {
    this.requireThread(threadId);
    this.db
      .prepare('INSERT INTO task_threads VALUES (?, ?)')
      .run(taskId, threadId);
  }
  messageMarks(threadId?: string): MessageMark[] {
    if (threadId !== undefined) this.requireThread(threadId);
    return this.db
      .prepare(
        `
      SELECT m.*, t.title AS threadTitle, t.dotId, d.name AS dotName
      FROM message_marks m JOIN thread_bindings t ON t.id=m.threadId
      JOIN dots d ON d.id=t.dotId
      WHERE t.ownerId=? AND t.deletedAt IS NULL ${threadId === undefined ? '' : 'AND t.id=?'}
      ORDER BY MAX(COALESCE(m.pinnedAt,0),COALESCE(m.bookmarkedAt,0)) DESC, m.messageId
    `,
      )
      .all(
        this.ownerId,
        ...(threadId === undefined ? [] : [threadId]),
      ) as unknown as MessageMark[];
  }
  setMessageMark(
    threadId: string,
    message: MarkableMessage,
    kind: MessageMarkKind,
    active: boolean,
  ): MessageMark | null {
    this.requireThread(threadId);
    const column = kind === 'pin' ? 'pinnedAt' : 'bookmarkedAt';
    if (active) {
      this.db
        .prepare(
          `INSERT INTO message_marks(threadId,messageId,role,content,${column})
        VALUES (?,?,?,?,?) ON CONFLICT(threadId,messageId) DO UPDATE SET
        role=excluded.role, content=excluded.content, ${column}=COALESCE(message_marks.${column},excluded.${column})
      `,
        )
        .run(threadId, message.id, message.role, message.content, Date.now());
    } else {
      this.db
        .prepare(
          `UPDATE message_marks SET ${column}=NULL WHERE threadId=? AND messageId=?`,
        )
        .run(threadId, message.id);
      this.db
        .prepare(
          'DELETE FROM message_marks WHERE threadId=? AND messageId=? AND pinnedAt IS NULL AND bookmarkedAt IS NULL',
        )
        .run(threadId, message.id);
    }
    return (
      this.messageMarks(threadId).find(
        (mark) => mark.messageId === message.id,
      ) ?? null
    );
  }
  taskThread(taskId: string): string | undefined {
    const row = this.db
      .prepare('SELECT threadId FROM task_threads WHERE taskId=?')
      .get(taskId);
    return typeof row?.threadId === 'string' ? row.threadId : undefined;
  }
  calls(threadId?: string): CallReceipt[] {
    if (threadId) this.requireThread(threadId);
    return this.db
      .prepare(
        `SELECT * FROM calls ${threadId ? 'WHERE threadId=?' : ''} ORDER BY startedAt DESC`,
      )
      .all(...(threadId ? [threadId] : [])) as unknown as CallReceipt[];
  }
  saveVoiceDelivery(id: string, rows: VoiceDelivery[]): void {
    this.call(id);
    this.db
      .prepare(
        'INSERT INTO local_voice_delivery VALUES (?, ?) ON CONFLICT(callId) DO UPDATE SET value=excluded.value',
      )
      .run(id, JSON.stringify(rows));
  }
  voiceDelivery(id: string): VoiceDelivery[] {
    this.call(id);
    const row = this.db
      .prepare('SELECT value FROM local_voice_delivery WHERE callId=?')
      .get(id);
    return row ? (JSON.parse(String(row.value)) as VoiceDelivery[]) : [];
  }
  createCall(threadId: string): CallReceipt {
    this.requireThread(threadId);
    const call: CallReceipt = {
      id: randomUUID(),
      threadId,
      startedAt: Date.now(),
      endedAt: null,
      status: 'connecting',
      transcript: '',
      error: null,
    };
    this.db
      .prepare(
        'INSERT INTO calls(id, threadId, startedAt, endedAt, status, transcript, error) VALUES (?, ?, ?, NULL, ?, ?, NULL)',
      )
      .run(call.id, threadId, call.startedAt, call.status, '');
    return call;
  }
  call(id: string): CallReceipt {
    const call = this.calls().find((call) => call.id === id);
    if (!call) throw new Error('Call not found.');
    this.requireThread(call.threadId);
    return call;
  }
  setCall(
    id: string,
    status: CallReceipt['status'],
    transcript: string,
    error: string | null = null,
  ) {
    const call = this.call(id);
    if (call.endedAt) return call;
    this.db
      .prepare(
        'UPDATE calls SET status=?, transcript=?, error=?, endedAt=? WHERE id=?',
      )
      .run(
        status,
        transcript,
        error,
        status === 'ended' || status === 'failed' ? Date.now() : null,
        id,
      );
    return this.call(id);
  }
  saveLateTranscript(id: string, transcript: string) {
    this.call(id);
    return (
      this.db
        .prepare(
          "UPDATE calls SET transcript=? WHERE id=? AND transcript='' AND endedAt IS NOT NULL",
        )
        .run(transcript, id).changes > 0
    );
  }
  anchorCall(id: string, anchor: string | undefined) {
    this.call(id);
    this.db
      .prepare('UPDATE calls SET anchorMessageId=? WHERE id=?')
      .run(anchor ?? null, id);
  }
  setCallError(id: string, error: string | null) {
    this.call(id);
    this.db.prepare('UPDATE calls SET error=? WHERE id=?').run(error, id);
  }
  saveCapture(threadId: string, value: unknown) {
    this.requireThread(threadId);
    this.db
      .prepare(
        'INSERT INTO captures VALUES (?, ?) ON CONFLICT(threadId) DO UPDATE SET value=excluded.value',
      )
      .run(threadId, JSON.stringify(value));
  }
  capture(threadId: string): unknown {
    this.requireThread(threadId);
    const row = this.db
      .prepare('SELECT value FROM captures WHERE threadId=?')
      .get(threadId);
    return typeof row?.value === 'string' ? JSON.parse(row.value) : null;
  }
}
