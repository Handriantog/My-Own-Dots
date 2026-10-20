import { MaintenanceGate } from '../src/server/storage/maintenance.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEventListeners } from 'node:events';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import type { Platform } from '../src/server/platform.js';
import type { Config } from '../src/server/research.js';
import { LocalVoiceService } from '../src/server/local-voice/service.js';
import { LocalSpeechWorker } from '../src/server/local-voice/worker.js';
import { DEFAULT_VOICE_SETTINGS } from '../src/shared/voice-settings.js';

const threadId = '11111111-1111-4111-8111-111111111111';
const callId = '22222222-2222-4222-8222-222222222222';
const origin = 'http://127.0.0.1:4310';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'local-voice-routes-'));
  const assets = ['whisper', 'kokoro', 'voices', 'vad'].map((id) => ({
    id,
    filename: `${id}.bin`,
    installedBytes: 3,
  }));
  await Promise.all(
    assets.map((asset) => writeFile(join(directory, asset.filename), 'abc')),
  );
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ assets }));
  const requireThread = vi.fn((id: string, dotId = 'dot') => {
    if (id !== threadId || dotId !== 'dot') throw Error('Thread not owned');
    return { dotId: 'dot' };
  });
  const snapshot = vi.fn(async () => ({ messages: [], state: {} }));
  const receipt = vi.fn();
  const release = vi.fn();
  const platform = {
    maintenance: new MaintenanceGate(),
    config: { conversationBackend: 'local', llmBackend: 'subscription' },
    setup: () => ({ missing: [] }),
    requireReady: () => {},
    store: { settings: () => ({ paused: false }) },
    localConversations: { getSnapshot: snapshot },
    memory: { enterForeground: async () => release },
    workspace: {
      voiceSettings: vi.fn(() => ({ ...DEFAULT_VOICE_SETTINGS })),
      setVoiceSettings: vi.fn((_id, settings) => settings),
      requireThread,
      createCall: () => ({ id: callId }),
      setCall: receipt,
      saveVoiceDelivery: () => {},
    },
    stopVoiceTurn: vi.fn(async () => {}),
  } as unknown as Platform;
  vi.spyOn(LocalSpeechWorker.prototype, 'warm').mockResolvedValue();
  const close = vi
    .spyOn(LocalSpeechWorker.prototype, 'close')
    .mockResolvedValue();
  const detect = vi
    .spyOn(LocalSpeechWorker.prototype, 'detect')
    .mockResolvedValue(0);
  const service = new LocalVoiceService(platform, {
    enabled: true,
    python: '/usr/bin/true',
    assets: directory,
    worker: join(directory, 'manifest.json'),
    manifest: join(directory, 'manifest.json'),
  });
  const config: Config = {
    mode: 'sample',
    baseUrl: 'https://api.openai.com/v1',
  };
  const store = new Store(':memory:');
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    ownerToken: 'owner',
    origin,
    localVoice: service,
  });
  cleanups.push(async () => {
    await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = (
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
    url = origin,
  ) =>
    app.request(`${url}/api/local-voice/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: 'Bearer owner',
        origin,
        'content-type': 'application/json',
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const start = async () => {
    const response = await request('calls', { threadId, dotId: 'dot' });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string; token: string };
  };
  return {
    platform,
    service,
    app,
    request,
    start,
    receipt,
    release,
    detect,
    snapshot,
    directory,
    close,
  };
}

describe('local voice HTTP security boundaries', () => {
  it('cancels an in-flight preview before starting a call and releases its resources', async () => {
    const f = await fixture();
    let warmStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      warmStarted = resolve;
    });
    vi.spyOn(LocalSpeechWorker.prototype, 'warm').mockImplementationOnce(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
          warmStarted();
        }),
    );
    const preview = f.service.preview(
      'dot',
      DEFAULT_VOICE_SETTINGS,
      new AbortController().signal,
    );
    const rejected = expect(preview).rejects.toThrow(/preview stopped/i);
    await started;
    expect(() =>
      f.service.preview(
        'dot',
        DEFAULT_VOICE_SETTINGS,
        new AbortController().signal,
      ),
    ).toThrow(/current audio/i);
    await f.start();
    await rejected;
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it('reads and saves allowlisted per-Dot settings and rejects unknown voices', async () => {
    const f = await fixture();
    const path = `${origin}/api/local-voice/dots/dot/settings`;
    const headers = {
      authorization: 'Bearer owner',
      origin,
      'content-type': 'application/json',
    };
    expect(await (await f.app.request(path, { headers })).json()).toEqual(
      DEFAULT_VOICE_SETTINGS,
    );
    const settings = { voiceId: 'bm_george', personality: 'serious' };
    expect(
      await (
        await f.app.request(path, {
          method: 'PUT',
          headers,
          body: JSON.stringify(settings),
        })
      ).json(),
    ).toEqual(settings);
    expect(
      (
        await f.app.request(path, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ ...settings, voiceId: 'jf_alpha' }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.app.request(path, {
          headers: { ...headers, authorization: '' },
        })
      ).status,
    ).toBe(401);
    await f.start();
    expect(
      (
        await f.app.request(path, {
          method: 'PUT',
          headers,
          body: JSON.stringify(settings),
        })
      ).status,
    ).toBe(400);
  });
  it('previews fixed text locally with the selected settings, closes the worker, and never starts a call', async () => {
    const f = await fixture();
    const synthesize = vi
      .spyOn(LocalSpeechWorker.prototype, 'synthesize')
      .mockResolvedValue(Buffer.alloc(4800));
    const response = await f.request('dots/dot/preview', {
      voiceId: 'bm_george',
      personality: 'calm',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('audio/wav');
    expect(
      Buffer.from(await response.arrayBuffer()).toString('ascii', 0, 4),
    ).toBe('RIFF');
    expect(synthesize).toHaveBeenCalledWith(
      expect.stringContaining('Take your time'),
      expect.any(AbortSignal),
    );
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.receipt).not.toHaveBeenCalled();
    await f.start();
    expect(
      (await f.request('dots/dot/preview', DEFAULT_VOICE_SETTINGS)).status,
    ).toBe(400);
  });
  it('reads installedBytes from the manifest and requires all four selected assets', async () => {
    const f = await fixture();
    expect(await f.service.status()).toMatchObject({ ready: true });
    await rm(join(f.directory, 'vad.bin'));
    expect(await f.service.status()).toMatchObject({ ready: false });
  });
  it('retains owner, origin, JSON content-type and loopback-only checks', async () => {
    const f = await fixture();
    const body = { threadId, dotId: 'dot' };
    expect(
      (await f.request('status', undefined, { authorization: '' })).status,
    ).toBe(401);
    expect(
      (await f.request('calls', body, { origin: 'https://evil.example' }))
        .status,
    ).toBe(403);
    expect(
      (await f.request('calls', body, { 'sec-fetch-site': 'cross-site' }))
        .status,
    ).toBe(403);
    expect(
      (await f.request('calls', body, { 'content-type': 'text/plain' })).status,
    ).toBe(415);
    expect(
      (await f.request('calls', body, {}, 'http://external.example')).status,
    ).toBe(403);
    expect(f.receipt).not.toHaveBeenCalled();
  });
  it('rejects forged Dot/thread, missing or wrong capabilities, and cross-call commands', async () => {
    const f = await fixture();
    expect(
      (await f.request('calls', { threadId, dotId: 'other' })).status,
    ).toBe(400);
    const handle = await f.start();
    for (const [id, token] of [
      [handle.id, ''],
      [handle.id, 'wrong'],
      ['other', handle.token],
    ]) {
      expect(
        (
          await f.request(
            `calls/${id}/control`,
            { action: 'heartbeat' },
            { 'x-dot-voice-token': token },
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await f.request(
          `calls/${handle.id}/control`,
          { action: 'heartbeat' },
          { 'x-dot-voice-token': handle.token },
        )
      ).status,
    ).toBe(200);
    expect(f.release).not.toHaveBeenCalled();
  });
  it('accepts one exact frame, then rejects replay and expires the capability', async () => {
    const f = await fixture();
    const handle = await f.start();
    const headers = { 'x-dot-voice-token': handle.token };
    const frame = { sequence: 0, pcm: Buffer.alloc(1024).toString('base64') };
    expect(
      (await f.request(`calls/${handle.id}/frame`, frame, headers)).status,
    ).toBe(200);
    expect(
      (await f.request(`calls/${handle.id}/frame`, frame, headers)).status,
    ).toBe(400);
    expect(f.detect).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
    await expect(
      (async () => await f.service.require(handle.id, handle.token))(),
    ).rejects.toThrow();
  });
  it('bounds call payloads and rejects noncanonical PCM before inference', async () => {
    const f = await fixture();
    const handle = await f.start();
    const headers = { 'x-dot-voice-token': handle.token };
    expect(
      (
        await f.request(
          `calls/${handle.id}/frame`,
          { sequence: 0, pcm: 'x'.repeat(9000) },
          headers,
        )
      ).status,
    ).toBe(413);
    const pcm = Buffer.alloc(1024).toString('base64');
    expect(
      (
        await f.request(
          `calls/${handle.id}/frame`,
          { sequence: 0, pcm: pcm.slice(0, -3) + 'B==' },
          headers,
        )
      ).status,
    ).toBe(400);
    expect(f.detect).not.toHaveBeenCalled();
  });
  it('does not allocate a call when shutdown races its conversation read', async () => {
    const f = await fixture();
    let complete!: (value: {
      messages: never[];
      state: Record<string, never>;
    }) => void;
    f.snapshot.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const start = f.service
      .start(threadId, 'dot', new AbortController().signal)
      .catch((error) => error);
    await vi.waitFor(() => expect(f.snapshot).toHaveBeenCalled());
    await f.service.close();
    complete({ messages: [], state: {} });
    expect(await start).toBeInstanceOf(Error);
    expect(f.receipt).not.toHaveBeenCalled();
  });
  it('waits for the ended call to reap before starting replacement workers', async () => {
    const f = await fixture();
    const handle = await f.start();
    let reaped!: () => void;
    f.close.mockReturnValue(
      new Promise<void>((resolve) => {
        reaped = resolve;
      }),
    );
    const ended = (await f.service.require(handle.id, handle.token)).end();
    const starting = f.service.start(
      threadId,
      'dot',
      new AbortController().signal,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(LocalSpeechWorker.prototype.warm).toHaveBeenCalledTimes(3);
    reaped();
    await ended;
    await starting;
    expect(LocalSpeechWorker.prototype.warm).toHaveBeenCalledTimes(6);
    await expect(
      (async () => await f.service.require(handle.id, handle.token))(),
    ).rejects.toThrow();
  });
  it('accepts authenticated duplicate ends but rejects other expired-call controls', async () => {
    const f = await fixture();
    const handle = await f.start();
    const headers = { 'x-dot-voice-token': handle.token };
    expect(
      (
        await f.request(
          `calls/${handle.id}/control`,
          { action: 'end' },
          headers,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await f.request(
          `calls/${handle.id}/control`,
          { action: 'end' },
          headers,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await f.request(
          `calls/${handle.id}/control`,
          { action: 'heartbeat' },
          headers,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request(
          `calls/${handle.id}/control`,
          { action: 'end' },
          { 'x-dot-voice-token': 'wrong' },
        )
      ).status,
    ).toBe(400);
    expect(
      f.receipt.mock.calls.filter(([, state]) => state === 'ended'),
    ).toHaveLength(1);
  });
  it('rejects a second event consumer and releases the call when the first disconnects', async () => {
    const f = await fixture();
    const handle = await f.start();
    const headers = { 'x-dot-voice-token': handle.token };
    const response = await f.request(
      `calls/${handle.id}/events`,
      undefined,
      headers,
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      expect((await reader.read()).done).toBe(false);
      const duplicate = await f.request(
        `calls/${handle.id}/events`,
        undefined,
        headers,
      );
      if (duplicate.status === 200) await duplicate.body?.cancel();
      expect(duplicate.status).toBe(400);
    } finally {
      await reader.cancel();
    }
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledTimes(1));
    await expect(
      (async () => await f.service.require(handle.id, handle.token))(),
    ).rejects.toThrow();
  });
  it('aborts a stalled SSE writer after a grace period without blocking End', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const handle = await f.start();
    const call = await f.service.require(handle.id, handle.token);
    const headers = { 'x-dot-voice-token': handle.token };
    const response = await f.request(
      `calls/${handle.id}/events`,
      undefined,
      headers,
    );
    try {
      // Leave its body unread so queued writes cannot complete.
      for (let i = 0; i < 40 && !call.ended; i++) await call.interrupt(false);
      expect(call.ended).toBe(true);
      expect(
        (
          await f.request(
            `calls/${handle.id}/control`,
            { action: 'end' },
            headers,
          )
        ).status,
      ).toBe(200);
      expect(f.release).toHaveBeenCalledTimes(1);
      expect(call.connected).toBe(true);
      await vi.advanceTimersByTimeAsync(999);
      expect(call.connected).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(call.connected).toBe(false);
      await response.text();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (!response.body?.locked) await response.body?.cancel();
    }
  });
  it('clears the SSE shutdown deadline after delivering an ordinary ended event', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const handle = await f.start();
    const call = await f.service.require(handle.id, handle.token);
    const headers = { 'x-dot-voice-token': handle.token };
    const request = new Request(
      `${origin}/api/local-voice/calls/${handle.id}/events`,
      {
        headers: { ...headers, authorization: 'Bearer owner', origin },
      },
    );
    const response = await f.app.request(request);
    expect(getEventListeners(request.signal, 'abort')).toHaveLength(1);
    const body = response.text();
    expect(
      (
        await f.request(
          `calls/${handle.id}/control`,
          { action: 'end' },
          headers,
        )
      ).status,
    ).toBe(200);
    expect(await body).toContain('"type":"ended"');
    expect(call.connected).toBe(false);
    expect(getEventListeners(request.signal, 'abort')).toHaveLength(0);
    expect(getEventListeners(call.endSignal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it('refuses manual snapshots until local voice workers and final receipts settle', async () => {
  const f = await fixture();
  const handle = await f.start();
  const gate = f.platform.maintenance;
  await expect(
    gate.acquire({ origin: 'manual', signal: new AbortController().signal }),
  ).rejects.toThrow(/busy/i);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.close.mockReturnValue(pending);
  const ending = (await f.service.require(handle.id, handle.token)).end();
  let captured = false;
  const snapshot = gate
    .acquire({ origin: 'automatic', signal: new AbortController().signal })
    .then((lease) => {
      captured = true;
      return lease;
    });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    expect(captured).toBe(false);
  } finally {
    finish();
  }
  await ending;
  const lease = await snapshot;
  expect(f.receipt).toHaveBeenLastCalledWith(
    expect.any(String),
    'ended',
    expect.any(String),
    undefined,
  );
  lease.release();
});
