import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { StorageClient } from '../src/server/storage/storage-client.js';
import { Platform } from '../src/server/platform.js';
import { LocalVoiceService } from '../src/server/local-voice/service.js';
import { localVoiceRoutes } from '../src/server/local-voice/routes.js';
import { LocalSpeechWorker } from '../src/server/local-voice/worker.js';
import { DEFAULT_VOICE_SETTINGS } from '../src/shared/voice-settings.js';
import { UnifiedSnapshotSource } from '../src/server/storage/unified-snapshot.js';
import { restoreSQLite } from '../src/server/storage/restore-sqlite.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function fixture(enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'voice-quality-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const ownerId = randomUUID();
  const database = join(root, 'workspace.sqlite');
  const storage = await StorageClient.open({ database, ownerId });
  cleanup.push(() => storage.close());
  const { store, workspace } = storage.repositories;
  const platform = await Platform.create(
    store,
    workspace,
    {
      conversationBackend: 'local',
      llmBackend: 'subscription',
      llmProvider: 'claude-code',
      baseUrl: '',
      runtimeUrl: 'http://localhost/api/copilotkit',
      voiceName: 'marin',
      slackUsers: [],
      webSearchProvider: 'disabled',
    },
    { storage },
  );
  cleanup.push(() => platform.stop());
  const assets = ['whisper', 'kokoro', 'voices', 'vad'].map((id) => ({
    id,
    filename: `${id}.bin`,
    installedBytes: 3,
  }));
  await Promise.all(
    assets.map((asset) => writeFile(join(root, asset.filename), 'abc')),
  );
  const manifest = join(root, 'manifest.json');
  await writeFile(manifest, JSON.stringify({ assets }));
  const service = new LocalVoiceService(platform, {
    enabled,
    python: process.execPath,
    assets: root,
    worker: manifest,
    manifest,
  });
  cleanup.push(() => service.close());
  const dot = (await workspace.dots())[0];
  const app = localVoiceRoutes(service);
  const save = (value: unknown) =>
    app.request(`http://localhost/local-voice/dots/${dot.id}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  return {
    root,
    ownerId,
    database,
    storage,
    workspace,
    platform,
    service,
    app,
    save,
    dot,
  };
}

it('preserves quality through legacy HTTP updates and the real storage worker', async () => {
  const f = await fixture(false);
  expect(
    (await f.save({ ...DEFAULT_VOICE_SETTINGS, quality: 'high' })).status,
  ).toBe(200);
  const result = await f.save({ voiceId: 'bm_george', personality: 'calm' });
  expect(await result.json()).toEqual({
    voiceId: 'bm_george',
    personality: 'calm',
    quality: 'high',
  });
  expect((await f.workspace.voiceSettings(f.dot.id)).quality).toBe('high');
  expect(
    (await f.save({ ...DEFAULT_VOICE_SETTINGS, quality: 'ultra' })).status,
  ).toBe(400);
});

it('allows Basic without either TTS asset and reports High unavailable without falling back', async () => {
  const f = await fixture();
  await rm(join(f.root, 'kokoro.bin'));
  await rm(join(f.root, 'voices.bin'));
  await f.workspace.setVoiceSettings(f.dot.id, {
    ...DEFAULT_VOICE_SETTINGS,
    quality: 'basic',
  });
  const result = await f.app.request(
    `http://localhost/local-voice/status?dotId=${f.dot.id}`,
  );
  expect(await result.json()).toMatchObject({
    ready: true,
    selectedQuality: 'basic',
    modes: {
      basic: { ready: true, audioOutput: false },
      medium: { ready: false, audioOutput: true },
      high: { ready: false, audioInput: true },
    },
  });
  await f.workspace.setVoiceSettings(f.dot.id, {
    ...DEFAULT_VOICE_SETTINGS,
    quality: 'high',
  });
  expect(await f.service.status(f.dot.id)).toMatchObject({
    ready: false,
    selectedQuality: 'high',
  });
  expect(await f.service.status()).toMatchObject({
    ready: false,
    selectedQuality: 'medium',
  });
  expect(
    (await f.app.request('http://localhost/local-voice/status?dotId=missing'))
      .status,
  ).toBe(400);
});

it('rejects Basic preview before constructing or warming synthesis, including a legacy request', async () => {
  const f = await fixture();
  await f.workspace.setVoiceSettings(f.dot.id, {
    ...DEFAULT_VOICE_SETTINGS,
    quality: 'basic',
  });
  const warm = vi
    .spyOn(LocalSpeechWorker.prototype, 'warm')
    .mockRejectedValue(new Error('must not warm'));
  const response = await f.app.request(
    `http://localhost/local-voice/dots/${f.dot.id}/preview`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voiceId: 'af_heart', personality: 'natural' }),
    },
  );
  expect(response.status).toBe(400);
  expect(warm).not.toHaveBeenCalled();
});

it('cancels a delayed Medium preview before acknowledging a switch to Basic', async () => {
  const f = await fixture();
  let admit!: (release: () => void) => void;
  const foreground = vi
    .spyOn(f.platform.memory!, 'enterForeground')
    .mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          admit = resolve;
        }),
    );
  const warm = vi
    .spyOn(LocalSpeechWorker.prototype, 'warm')
    .mockResolvedValue();
  const synthesize = vi
    .spyOn(LocalSpeechWorker.prototype, 'synthesize')
    .mockResolvedValue(Buffer.alloc(1920));
  vi.spyOn(LocalSpeechWorker.prototype, 'close').mockResolvedValue();
  const preview = f.service
    .preview(f.dot.id, DEFAULT_VOICE_SETTINGS, new AbortController().signal)
    .then(
      () => 'completed',
      () => 'cancelled',
    );
  await vi.waitFor(() => expect(foreground).toHaveBeenCalledOnce());
  const saved = await f.service.saveSettings(f.dot.id, {
    ...DEFAULT_VOICE_SETTINGS,
    quality: 'basic',
  });
  const release = vi.fn();
  admit(release);
  expect(saved.quality).toBe('basic');
  expect(await preview).toBe('cancelled');
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  expect(warm).not.toHaveBeenCalled();
  expect(synthesize).not.toHaveBeenCalled();
});

it('prevents preview and call startup from overtaking an outstanding settings write', async () => {
  const f = await fixture();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const original = f.workspace.setVoiceSettings.bind(f.workspace);
  vi.spyOn(f.workspace, 'setVoiceSettings').mockImplementation(
    async (...args) => {
      await pending;
      return original(...args);
    },
  );
  const saved = f.service.saveSettings(f.dot.id, {
    ...DEFAULT_VOICE_SETTINGS,
    quality: 'basic',
  });
  try {
    expect(() => {
      const preview = f.service.preview(
        f.dot.id,
        DEFAULT_VOICE_SETTINGS,
        new AbortController().signal,
      );
      void preview.catch(() => {});
    }).toThrow(/settings.*sav/i);
    await expect(
      f.service.start('unused', f.dot.id, new AbortController().signal),
    ).rejects.toThrow(/settings.*sav/i);
  } finally {
    finish();
    await saved;
  }
});

it('changes the settings revision after voice and personality changes even if quality is unchanged', async () => {
  const f = await fixture(false);
  const before = (await f.service.status(f.dot.id)).settingsRevision;
  expect(before).toEqual(expect.any(String));
  await f.service.saveSettings(f.dot.id, {
    ...DEFAULT_VOICE_SETTINGS,
    personality: 'calm',
  });
  expect((await f.service.status(f.dot.id)).settingsRevision).not.toBe(before);
});

it('retains quality and voice preferences through a unified snapshot and restore', async () => {
  const f = await fixture();
  const settings = {
    voiceId: 'bm_george',
    personality: 'calm',
    quality: 'basic',
  };
  await f.workspace.setVoiceSettings(f.dot.id, settings);
  const config = join(f.root, '.env');
  await writeFile(config, 'LLM_PROVIDER=fixture\n');
  const source = new UnifiedSnapshotSource({
    storage: f.storage,
    sqlitePath: f.database,
    ownerId: f.ownerId,
    workspaceId: randomUUID(),
    gate: f.platform.maintenance,
    configurationPath: config,
  });
  const snapshot = join(f.root, 'snapshot');
  await source.capture(snapshot, new AbortController().signal);
  await mkdir(join(f.root, 'restored/data'), { recursive: true });
  await mkdir(join(f.root, 'restored/recovery'));
  const restored = join(f.root, 'restored/data/workspace.sqlite');
  await restoreSQLite(
    join(snapshot, 'core/workspace.sqlite'),
    restored,
    f.ownerId,
    new AbortController().signal,
    'sqlite',
  );
  const reopened = await StorageClient.open({
    database: restored,
    ownerId: f.ownerId,
  });
  try {
    expect(
      await reopened.repositories.workspace.voiceSettings(f.dot.id),
    ).toEqual(settings);
  } finally {
    await reopened.close();
  }
});
it('snapshots Basic at startup and rejects a stale quality expectation without starting workers', async () => {
  const f = await fixture();
  await f.workspace.setVoiceSettings(f.dot.id, {
    ...DEFAULT_VOICE_SETTINGS,
    quality: 'basic',
  });
  const thread = await f.platform.createConversation(f.dot.id, 'Basic call');
  const warmed: string[][] = [];
  vi.spyOn(LocalSpeechWorker.prototype, 'warm').mockImplementation(
    async function (this: LocalSpeechWorker) {
      const args = (this as unknown as { launch: { args: string[] } }).launch
        .args;
      warmed.push(args);
      if (args.includes('synthesis'))
        throw new Error('Basic attempted synthesis');
    },
  );
  const post = (expectedQuality: string) =>
    f.app.request('http://localhost/local-voice/calls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId: thread.id,
        dotId: f.dot.id,
        expectedQuality,
      }),
    });
  expect((await post('medium')).status).toBe(400);
  expect(warmed).toHaveLength(0);
  const response = await post('basic');
  expect(response.status).toBe(201);
  const handle = await response.json();
  expect(handle.quality).toBe('basic');
  expect(warmed.map((args) => args.at(-1)).sort()).toEqual([
    'recognition',
    'vad',
  ]);
  expect(
    (await f.save({ ...DEFAULT_VOICE_SETTINGS, quality: 'medium' })).status,
  ).toBe(400);
  await (await f.service.require(handle.id, handle.token)).end();
});

it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
  'offers High only with SQLite delegation, VAD and the pinned native assets; starts no subscription session',
  async () => {
    const { NativeVoiceWorker } =
      await import('../src/server/local-voice/native-worker.js');
    const f = await fixture();
    const nativeManifest = join(f.root, 'native-models.json');
    const revision = 'a'.repeat(40);
    await mkdir(join(f.root, 'models', revision, 'audio_detokenizer'), {
      recursive: true,
    });
    await writeFile(
      join(f.root, 'models', revision, 'audio_detokenizer/model.safetensors'),
      'abc',
    );
    await writeFile(
      nativeManifest,
      JSON.stringify({
        audio: {
          revision,
          files: [{ path: 'audio_detokenizer/model.safetensors', bytes: 3 }],
        },
        router: {
          revision,
          files: [{ path: 'audio_detokenizer/model.safetensors', bytes: 3 }],
        },
      }),
    );
    const service = new LocalVoiceService(f.platform, {
      enabled: true,
      python: process.execPath,
      assets: f.root,
      worker: nativeManifest,
      manifest: join(f.root, 'manifest.json'),
      nativeRoot: f.root,
      nativePython: process.execPath,
      nativeLauncher: nativeManifest,
      nativeManifest,
      inferenceSession: true,
      providerSession: true,
    });
    cleanup.push(() => service.close());
    await f.workspace.setVoiceSettings(f.dot.id, {
      ...DEFAULT_VOICE_SETTINGS,
      quality: 'high',
    });
    await rm(join(f.root, 'whisper.bin'));
    await rm(join(f.root, 'kokoro.bin'));
    expect((await service.status(f.dot.id)).modes?.high.ready).toBe(true);
    const warmed = vi
      .spyOn(NativeVoiceWorker.prototype, 'warm')
      .mockResolvedValue();
    vi.spyOn(NativeVoiceWorker.prototype, 'close').mockResolvedValue();
    const localWarm = vi
      .spyOn(LocalSpeechWorker.prototype, 'warm')
      .mockResolvedValue();
    vi.spyOn(LocalSpeechWorker.prototype, 'close').mockResolvedValue();
    const thread = await f.platform.createConversation(f.dot.id, 'Native');
    const listeners = vi.spyOn(f.platform.nativeVoice!, 'listen');
    const handle = await service.start(
      thread.id,
      f.dot.id,
      new AbortController().signal,
      'high',
    );
    expect(handle.quality).toBe('high');
    expect(warmed).toHaveBeenCalledOnce();
    expect(localWarm).toHaveBeenCalledOnce();
    await (await service.require(handle.id, handle.token)).end();
    const resumed = await service.start(
      thread.id,
      f.dot.id,
      new AbortController().signal,
      'high',
    );
    const resumedCall = await service.require(resumed.id, resumed.token);
    const update = vi
      .spyOn(resumedCall, 'nativeUpdate')
      .mockImplementation(() => {});
    const notify = listeners.mock.calls.at(-1)![0];
    const job = {
      id: 'finished-task',
      callId: handle.id,
      dotId: f.dot.id,
      parentThreadId: thread.id,
      workerThreadId: 'worker',
      status: 'completed',
      result: 'The folder contains project notes.',
      leaseGeneration: 1,
    } as import('../src/shared/voice-delegation.js').VoiceDelegation;
    notify({ ...job, parentThreadId: 'other-thread' });
    notify({ ...job, dotId: 'other-dot' });
    expect(update).not.toHaveBeenCalled();
    notify(job);
    expect(update).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('project notes'),
    );
    await resumedCall.end();
  },
);
