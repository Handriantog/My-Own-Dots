import { timingSafeEqual, randomBytes } from 'node:crypto';
import { access, lstat, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Platform } from '../platform.js';
import type { LocalVoiceStatus } from '../../shared/local-voice.js';
import { LiveVoiceCall, waitForVoiceOperation } from './live.js';
import { LocalSpeechWorker } from './worker.js';
import { clearVoiceTurn, setVoiceTurn } from './context.js';
import {
  personalityFor,
  voiceSettingsSchema,
  type VoiceSettings,
} from '../../shared/voice-settings.js';
import { encodeFixtureWav } from './audio.js';
import { VoiceInferenceSession, VoiceProviderSession } from './inference.js';
export interface LocalVoiceConfig {
  enabled: boolean;
  inferenceSession?: boolean;
  providerSession?: boolean;
  python: string;
  assets: string;
  worker: string;
  manifest: string;
}
export function localVoiceConfig(env: NodeJS.ProcessEnv): LocalVoiceConfig {
  const root = join(
    homedir(),
    'Library/Application Support/My Own Dots/local-voice',
  );
  return {
    enabled: env.LOCAL_VOICE_ENABLED === '1',
    inferenceSession: env.LOCAL_VOICE_INTEGRATOR_SESSION === '1',
    providerSession: env.LOCAL_VOICE_PROVIDER_SESSION === '1',
    python: env.LOCAL_VOICE_PYTHON || join(root, 'venv/bin/python'),
    assets: env.LOCAL_VOICE_ASSETS || join(root, 'assets'),
    worker: resolve(
      env.DOTS_RUNTIME_ROOT || '.',
      'scripts/local-voice/worker.py',
    ),
    manifest: resolve(
      env.DOTS_RUNTIME_ROOT || '.',
      'scripts/local-voice/manifest.json',
    ),
  };
}
export class LocalVoiceService {
  private call?: LiveVoiceCall;
  private starting = false;
  private closed = false;
  private previewing?: { controller: AbortController; done: Promise<Buffer> };
  private readonly shutdown = new AbortController();
  constructor(
    private readonly platform: Platform,
    private readonly config: LocalVoiceConfig,
  ) {}
  async settings(dotId: string) {
    return await this.platform.workspace.voiceSettings(dotId);
  }
  async saveSettings(dotId: string, input: unknown) {
    if (
      this.starting ||
      (this.call && !this.call.ended && this.call.scope.dotId === dotId)
    )
      throw Error('End the call before changing its voice.');
    return await this.platform.workspace.setVoiceSettings(
      dotId,
      voiceSettingsSchema.parse(input),
    );
  }
  private worker(mode: string, settings?: VoiceSettings) {
    return new LocalSpeechWorker({
      executable: this.config.python,
      args: [
        this.config.worker,
        '--assets',
        this.config.assets,
        '--mode',
        mode,
      ],
      ...(settings ? { voiceSettings: { ...settings } } : {}),
    });
  }
  preview(
    dotId: string,
    input: unknown,
    requestSignal: AbortSignal,
  ): Promise<Buffer> {
    if (this.starting || this.previewing || (this.call && !this.call.ended))
      throw Error('End the current audio before previewing a voice.');
    const settings = voiceSettingsSchema.parse(input);
    const controller = new AbortController();
    const signal = AbortSignal.any([
      requestSignal,
      controller.signal,
      this.shutdown.signal,
      AbortSignal.timeout(45000),
    ]);
    const work: { controller: AbortController; done: Promise<Buffer> } = {
      controller,
      done: Promise.resolve(Buffer.alloc(0)),
    };
    this.previewing = work;
    const preview = async () => {
      let worker: LocalSpeechWorker | undefined;
      let release: (() => void) | undefined;
      try {
        signal.throwIfAborted();
        await this.settings(dotId); // Verify the Dot belongs to this workspace.
        if (
          !(await this.status()).ready ||
          (await this.platform.store.settings()).paused
        )
          throw Error('Local speech is unavailable.');
        const foreground = this.platform
          .memory!.enterForeground(signal)
          .then((value) => {
            if (signal.aborted) value();
            else release = value;
          });
        await waitForVoiceOperation(foreground, signal);
        signal.throwIfAborted();
        worker = this.worker('synthesis', settings);
        await worker.warm(signal);
        const pcm = await worker.synthesize(
          personalityFor(settings).previewText,
          signal,
        );
        signal.throwIfAborted();
        return encodeFixtureWav(pcm, 24000);
      } finally {
        try {
          await worker?.close();
        } finally {
          release?.();
          if (this.previewing === work) this.previewing = undefined;
        }
      }
    };
    work.done = (
      this.platform.maintenance
        ? this.platform.maintenance.runWrite(signal, preview)
        : Promise.resolve().then(preview)
    ).finally(() => {
      if (this.previewing === work) this.previewing = undefined;
    });
    return work.done;
  }
  async status(): Promise<LocalVoiceStatus> {
    const unavailable = (reason: string) => ({
      enabled: this.config.enabled,
      ready: false,
      reason,
    });
    if (!this.config.enabled)
      return unavailable(
        'Local voice is disabled. Set LOCAL_VOICE_ENABLED=1 and restart the workspace.',
      );
    if (this.closed) return unavailable('The workspace is shutting down.');
    if (
      this.platform.config.conversationBackend !== 'local' ||
      this.platform.config.llmBackend !== 'subscription' ||
      !this.platform.memory ||
      !this.platform.localConversations
    )
      return unavailable(
        'Local voice requires local conversations and the subscription chat backend.',
      );
    if (this.platform.setup().missing.length)
      return unavailable('Finish the chat setup before starting local voice.');
    try {
      await access(this.config.python, constants.X_OK);
      await access(this.config.worker, constants.R_OK);
      const manifest = JSON.parse(
        await readFile(this.config.manifest, 'utf8'),
      ) as {
        assets: { id: string; filename: string; installedBytes: number }[];
      };
      for (const id of ['whisper', 'kokoro', 'voices', 'vad']) {
        const matches = manifest.assets.filter((asset) => asset.id === id);
        if (matches.length !== 1) throw Error();
        const asset = matches[0];
        if (
          typeof asset.filename !== 'string' ||
          basename(asset.filename) !== asset.filename ||
          !Number.isSafeInteger(asset.installedBytes) ||
          asset.installedBytes <= 0
        )
          throw Error();
        const stat = await lstat(join(this.config.assets, asset.filename));
        if (!stat.isFile() || stat.size !== asset.installedBytes) throw Error();
      }
    } catch {
      return unavailable(
        'Install the pinned local speech runtime and all four model files. See the local voice setup guide.',
      );
    }
    return {
      enabled: true,
      ready: true,
      inferenceRuntime:
        this.config.providerSession &&
        this.platform.config.llmProvider === 'codex'
          ? 'persistent-provider'
          : this.config.inferenceSession
            ? 'warm-session'
            : 'per-request',
      reason:
        'Local speech is installed. Models are verified and warmed when you start a call.',
    };
  }
  async start(threadId: string, dotId: string, signal: AbortSignal) {
    if (this.starting || (this.call && !this.call.ended))
      throw Error('A voice call is already active.');
    this.starting = true;
    const deadline = new AbortController();
    signal = AbortSignal.any([signal, this.shutdown.signal, deadline.signal]);
    const timeout = setTimeout(
      () => deadline.abort(new Error('Call startup timed out.')),
      120000,
    );
    timeout.unref?.();
    let release: (() => void) | undefined;
    try {
      release = await this.platform.maintenance?.enterWrite(signal);
      signal.throwIfAborted();
      if (this.previewing) {
        this.previewing.controller.abort(new Error('Voice preview stopped.'));
        await waitForVoiceOperation(
          this.previewing.done.catch(() => {}),
          signal,
        );
      }
      // An ended call may still be reaping workers or stopping its owned run.
      if (this.call) await waitForVoiceOperation(this.call.end(), signal);
      const status = await waitForVoiceOperation(this.status(), signal);
      if (!status.ready) throw Error(status.reason);
      this.platform.requireReady();
      const binding = await this.platform.workspace.requireThread(
        threadId,
        dotId,
      );
      if (
        binding.dotId !== dotId ||
        (await this.platform.store.settings()).paused
      )
        throw Error('This conversation is unavailable.');
      const snapshot = await waitForVoiceOperation(
        this.platform.localConversations!.getSnapshot(threadId),
        signal,
      );
      if (snapshot.lastRun?.status === 'running')
        throw Error('Wait for the current response before starting a call.');
      signal.throwIfAborted();
      const receipt = await this.platform.workspace.createCall(threadId);
      const voiceSettings = await this.settings(dotId);
      const providerSession =
        this.config.providerSession &&
        this.platform.config.llmProvider === 'codex'
          ? new VoiceProviderSession(receipt.id)
          : undefined;
      const inference =
        providerSession ??
        (this.config.inferenceSession
          ? new VoiceInferenceSession(receipt.id)
          : undefined);
      const call = new LiveVoiceCall(
        {
          id: receipt.id,
          token: randomBytes(32).toString('base64url'),
          threadId,
          dotId,
        },
        {
          voiceTurn: (utterance) => {
            if (utterance)
              setVoiceTurn(this.platform.workspace, {
                callId: receipt.id,
                threadId,
                dotId,
                personality: voiceSettings.personality,
                inference:
                  inference instanceof VoiceInferenceSession
                    ? inference.run
                    : undefined,
                ...(providerSession
                  ? {
                      stream: providerSession.runDecision,
                      commitText: async (
                        messageId: string,
                        assistantId: string,
                        sequence: number,
                        text: string,
                      ) =>
                        await call.commitText(
                          messageId,
                          assistantId,
                          sequence,
                          text,
                        ),
                      finishText: (messageId: string, failed: boolean) =>
                        call.finishText(messageId, failed),
                    }
                  : {}),
                ...utterance,
              });
            else clearVoiceTurn(this.platform.workspace, receipt.id);
          },
          requireThread: async () =>
            await this.platform.workspace.requireThread(threadId, dotId),
          paused: async () => (await this.platform.store.settings()).paused,
          foreground: (s) => this.platform.memory!.enterForeground(s, threadId),
          snapshot: () =>
            this.platform.localConversations!.getSnapshot(threadId),
          stop: (messageId) => this.platform.stopVoiceTurn(threadId, messageId),
          receipt: async (state, text, error) => {
            await this.platform.workspace.setCall(
              receipt.id,
              state,
              text,
              error,
            );
          },
          delivery: async (rows) =>
            await this.platform.workspace.saveVoiceDelivery(receipt.id, rows),
          closed: release,
        },
        () => {
          return {
            recognition: this.worker('recognition'),
            synthesis: this.worker('synthesis', voiceSettings),
            vad: this.worker('vad'),
            inference,
          };
        },
      );
      // The call owns admission through worker cleanup and its final receipts.
      release = undefined;
      this.call = call;
      const abort = () => {
        void call.end('Call startup was cancelled.');
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      try {
        await call.start();
        signal.throwIfAborted();
        return { id: call.scope.id, token: call.scope.token };
      } finally {
        signal.removeEventListener('abort', abort);
      }
    } finally {
      release?.();
      clearTimeout(timeout);
      this.starting = false;
    }
  }
  async require(
    id: string,
    token: string | undefined,
    options: { allowEnded?: boolean } = {},
  ): Promise<LiveVoiceCall> {
    const call = this.call;
    const supplied = Buffer.from(token ?? '');
    const expected = Buffer.from(call?.scope.token ?? '');
    if (
      !call ||
      (call.ended && !options.allowEnded) ||
      call.scope.id !== id ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw Error('Call authorization failed.');
    await this.platform.workspace.requireThread(
      call.scope.threadId,
      call.scope.dotId,
    );
    return call;
  }
  async close() {
    this.closed = true;
    this.shutdown.abort(new Error('The workspace is shutting down.'));
    await this.previewing?.done.catch(() => {});
    await this.call?.end();
  }
}
