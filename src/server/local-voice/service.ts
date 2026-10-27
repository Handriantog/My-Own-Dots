import { logError } from '../../shared/error-log.js';
import { timingSafeEqual, randomBytes, createHash } from 'node:crypto';
import { access, lstat, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Platform } from '../platform.js';
import type {
  LocalVoiceStatus,
  VoiceModeStatus,
} from '../../shared/local-voice.js';
import { LiveVoiceCall, waitForVoiceOperation } from './live.js';
import { LocalSpeechWorker } from './worker.js';
import { clearVoiceTurn, setVoiceTurn } from './context.js';
import {
  personalityFor,
  DEFAULT_HIGH_VOICE,
  voiceSettingsSchema,
  voiceSettingsUpdateSchema,
  type VoiceQuality,
  type VoiceSettings,
} from '../../shared/voice-settings.js';
import { encodeFixtureWav } from './audio.js';
import { VoiceInferenceSession, VoiceProviderSession } from './inference.js';
import { CodexConversationSession } from './codex-conversation-intake.js';
import { NativeVoiceWorker } from './native-worker.js';
import { QwenVoiceSession } from './qwen-voice.js';
import { voiceJobReceipt } from './native-runtime.js';
export interface LocalVoiceConfig {
  enabled: boolean;
  inferenceSession?: boolean;
  providerSession?: boolean;
  python: string;
  assets: string;
  worker: string;
  manifest: string;
  nativeRoot?: string;
  nativePython?: string;
  nativeLauncher?: string;
  nativeManifest?: string;
  qwenTtsRoot?: string;
  qwenTtsLauncher?: string;
  qwenTtsManifest?: string;
}
export function localVoiceConfig(env: NodeJS.ProcessEnv): LocalVoiceConfig {
  const root = join(
    homedir(),
    'Library/Application Support/My Own Dots/local-voice',
  );
  const nativeRoot =
    env.LOCAL_VOICE_NATIVE_ROOT ||
    join(homedir(), 'Library/Application Support/My Own Dots/native-voice');
  return {
    enabled: env.LOCAL_VOICE_ENABLED === '1',
    nativeRoot,
    qwenTtsRoot:
      env.LOCAL_VOICE_TTS_ROOT ||
      join(homedir(), 'Library/Application Support/My Own Dots/qwen3-tts'),
    qwenTtsLauncher: resolve(
      env.DOTS_RUNTIME_ROOT || '.',
      'scripts/local-voice/qwen_launcher.py',
    ),
    qwenTtsManifest: resolve(
      env.DOTS_RUNTIME_ROOT || '.',
      'scripts/local-voice/qwen3-tts-model.json',
    ),
    nativePython:
      env.LOCAL_VOICE_NATIVE_PYTHON || join(nativeRoot, 'venv/bin/python'),
    nativeLauncher: resolve(
      env.DOTS_RUNTIME_ROOT || '.',
      'scripts/local-voice/native_launcher.py',
    ),
    nativeManifest: resolve(
      env.DOTS_RUNTIME_ROOT || '.',
      'scripts/local-voice/native-models.json',
    ),
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
  private savingSettings = false;
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
    if (this.savingSettings)
      throw Error('Voice settings are being saved. Please retry.');
    if (
      this.starting ||
      (this.call && !this.call.ended && this.call.scope.dotId === dotId)
    )
      throw Error('End the call before changing its voice.');
    const update = voiceSettingsUpdateSchema.parse(input);
    this.savingSettings = true;
    try {
      // Retain this guard through worker persistence so preview/start cannot
      // observe the previous mode while the new preference is being saved.
      if (this.previewing) {
        this.previewing.controller.abort(new Error('Voice preview stopped.'));
        await this.previewing.done.catch(() => {});
      }
      this.shutdown.signal.throwIfAborted();
      return await this.platform.workspace.setVoiceSettings(dotId, update);
    } finally {
      this.savingSettings = false;
    }
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
  private qwenWorker(settings: VoiceSettings) {
    if (
      !this.config.qwenTtsRoot ||
      !this.config.qwenTtsLauncher ||
      !this.config.nativeRoot ||
      !this.config.nativePython
    )
      throw Error('Install the High voice speech model.');
    return new NativeVoiceWorker({
      executable: this.config.nativePython,
      args: [
        this.config.qwenTtsLauncher,
        '--runtime-root',
        this.config.nativeRoot,
        '--python',
        this.config.nativePython,
        '--tts-root',
        this.config.qwenTtsRoot,
        '--voice',
        settings.highVoiceId ?? DEFAULT_HIGH_VOICE,
        '--personality',
        settings.personality,
      ],
      speechChunkSize: 240,
      timeoutMs: 45000,
    });
  }
  preview(
    dotId: string,
    input: unknown,
    requestSignal: AbortSignal,
  ): Promise<Buffer> {
    if (this.savingSettings)
      throw Error('Voice settings are being saved. Please retry.');
    if (this.starting || this.previewing || (this.call && !this.call.ended))
      throw Error('End the current audio before previewing a voice.');
    const update = voiceSettingsUpdateSchema.parse(input);
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
      let worker: LocalSpeechWorker | NativeVoiceWorker | undefined;
      let release: (() => void) | undefined;
      try {
        signal.throwIfAborted();
        const saved = await this.settings(dotId);
        const settings = voiceSettingsSchema.parse({
          ...saved,
          ...update,
          quality: update.quality ?? saved.quality,
        });
        const high =
          settings.quality === 'high' &&
          this.platform.config.agentEngine === 'codex';
        if (
          !high &&
          (saved.quality !== 'medium' || settings.quality !== 'medium')
        )
          throw Error(
            'Voice preview is available only in Medium. Save Medium quality to preview a voice.',
          );
        if (
          !(high
            ? (await this.status(dotId)).modes?.high.ready
            : (await this.status(dotId)).ready) ||
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
        worker = high
          ? this.qwenWorker(settings)
          : this.worker('synthesis', settings);
        await worker.warm(signal);
        const text = personalityFor(settings).previewText;
        const pcm =
          worker instanceof NativeVoiceWorker
            ? (await worker.speak(text, signal)).pcm
            : await worker.synthesize(text, signal);
        signal.throwIfAborted();
        return encodeFixtureWav(pcm, 24000);
      } catch (error) {
        if (!signal.aborted)
          logError('voice_preview_failed', error, { operation: 'preview' });
        throw error;
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
  async status(dotId?: string): Promise<LocalVoiceStatus> {
    const settings =
      dotId === undefined ? undefined : await this.settings(dotId);
    const selectedQuality = settings?.quality ?? 'medium';
    const settingsRevision = settings
      ? createHash('sha256').update(JSON.stringify(settings)).digest('hex')
      : undefined;
    const mode = (
      audioOutput: boolean,
      ready: boolean,
      reason: string,
    ): VoiceModeStatus => ({
      ready,
      reason,
      audioInput: true,
      audioOutput,
      needsSetup: !ready,
    });
    let high: VoiceModeStatus = {
      ...mode(
        true,
        false,
        'Install the pinned High voice runtime and models. High requires Apple Silicon macOS and local SQLite storage.',
      ),
      speechEngine:
        this.platform.config.agentEngine === 'codex' ? 'qwen3' : 'lfm',
    };
    const unavailable = (reason: string): LocalVoiceStatus => ({
      enabled: this.config.enabled,
      ready: false,
      reason: selectedQuality === 'high' ? high.reason : reason,
      selectedQuality,
      settingsRevision,
      modes: {
        basic: mode(false, false, reason),
        medium: mode(true, false, reason),
        high,
      },
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
    let basic: VoiceModeStatus;
    let medium: VoiceModeStatus;
    try {
      await access(this.config.python, constants.X_OK);
      await access(this.config.worker, constants.R_OK);
      const manifest = JSON.parse(
        await readFile(this.config.manifest, 'utf8'),
      ) as {
        assets: { id: string; filename: string; installedBytes: number }[];
      };
      const verify = async (ids: string[]) => {
        for (const id of ids) {
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
          if (!stat.isFile() || stat.size !== asset.installedBytes)
            throw Error();
        }
      };
      const checkMode = async (
        audioOutput: boolean,
      ): Promise<VoiceModeStatus> => {
        try {
          await verify(
            audioOutput
              ? ['whisper', 'kokoro', 'voices', 'vad']
              : ['whisper', 'vad'],
          );
          return mode(
            audioOutput,
            true,
            audioOutput
              ? 'Local speech is installed. Models are verified and warmed when you start a call.'
              : 'Speech recognition is installed. Dot will reply in text.',
          );
        } catch {
          return mode(
            audioOutput,
            false,
            audioOutput
              ? 'Install the pinned local speech runtime and all four model files. See the local voice setup guide.'
              : 'Install the pinned recognition runtime, Whisper, and Silero VAD. Basic needs no speech output models.',
          );
        }
      };
      [basic, medium] = await Promise.all([checkMode(false), checkMode(true)]);
      try {
        if (
          !this.platform.nativeVoice ||
          process.platform !== 'darwin' ||
          process.arch !== 'arm64' ||
          !this.config.nativeRoot ||
          !this.config.nativePython ||
          !this.config.nativeLauncher ||
          !this.config.nativeManifest
        )
          throw Error();
        await verify(['vad']);
        await access(this.config.nativePython, constants.X_OK);
        await access(this.config.nativeLauncher, constants.R_OK);
        const native = JSON.parse(
          await readFile(this.config.nativeManifest, 'utf8'),
        ) as Record<
          'audio' | 'router',
          { revision: string; files: { path: string; bytes: number }[] }
        >;
        const models = (
          this.platform.config.agentEngine === 'codex'
            ? [native.audio]
            : [native.audio, native.router]
        ).map((model) => ({ model, root: this.config.nativeRoot! }));
        if (this.platform.config.agentEngine === 'codex') {
          if (
            !this.config.qwenTtsRoot ||
            !this.config.qwenTtsLauncher ||
            !this.config.qwenTtsManifest
          )
            throw Error();
          high.reason =
            'Install the Qwen3-TTS High voice model. See the local voice setup guide.';
          await access(this.config.qwenTtsLauncher, constants.R_OK);
          const tts = JSON.parse(
            await readFile(this.config.qwenTtsManifest, 'utf8'),
          ) as { tts: typeof native.audio };
          models.push({ model: tts.tts, root: this.config.qwenTtsRoot });
        }
        for (const { model, root } of models) {
          if (!/^[a-f0-9]{40}$/.test(model.revision) || !model.files.length)
            throw Error();
          for (const file of model.files) {
            const parts = file.path.split('/');
            if (
              parts.some(
                (part) =>
                  !/^[a-zA-Z0-9_.-]+$/.test(part) ||
                  part === '.' ||
                  part === '..',
              ) ||
              !Number.isSafeInteger(file.bytes) ||
              file.bytes < 1
            )
              throw Error();
            let path = root;
            for (const part of ['models', model.revision, ...parts]) {
              if (!(await lstat(path)).isDirectory()) throw Error();
              path = join(path, part);
            }
            const stat = await lstat(path);
            if (!stat.isFile() || stat.size !== file.bytes) throw Error();
          }
        }
        high = {
          ...mode(
            true,
            true,
            this.platform.config.agentEngine === 'codex'
              ? 'Natural speech runs on this Mac. Conversation and tasks use your Codex subscription and approved tools.'
              : 'Local conversation and speech are installed. Replies use your transcribed words; emotion and background sounds do not guide the answer. Tasks use your subscription and existing approvals.',
          ),
          speechEngine: high.speechEngine,
        };
      } catch {
        /* Readiness is separate from Basic and Medium. Hashes are checked at warmup. */
      }
    } catch {
      return unavailable(
        'Install the pinned local speech runtime and asset manifest. See the local voice setup guide.',
      );
    }
    const modes = { basic, medium, high };
    return {
      enabled: true,
      selectedQuality,
      settingsRevision,
      modes,
      ready: modes[selectedQuality].ready,
      inferenceRuntime:
        selectedQuality === 'high'
          ? this.platform.config.agentEngine === 'codex'
            ? 'codex-execution'
            : 'native-local'
          : this.config.providerSession &&
              this.platform.config.llmProvider === 'codex'
            ? 'persistent-provider'
            : this.config.inferenceSession
              ? 'warm-session'
              : 'per-request',
      reason: modes[selectedQuality].reason,
    };
  }
  async start(
    threadId: string,
    dotId: string,
    signal: AbortSignal,
    expectedQuality?: VoiceQuality,
  ) {
    if (this.savingSettings)
      throw Error('Voice settings are being saved. Please retry.');
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
      const voiceSettings = await this.settings(dotId);
      if (
        expectedQuality !== undefined &&
        expectedQuality !== voiceSettings.quality
      )
        throw Error(
          'Voice quality changed. Refresh the settings and start again.',
        );
      const status = await waitForVoiceOperation(this.status(dotId), signal);
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
      if (
        snapshot.lastRun?.status === 'running' &&
        !(
          voiceSettings.quality === 'high' &&
          this.platform.config.agentEngine === 'codex'
        )
      )
        throw Error('Wait for the current response before starting a call.');
      signal.throwIfAborted();
      const receipt = await this.platform.workspace.createCall(
        threadId,
        snapshot.messages.at(-1)?.id,
      );
      const recognition =
        voiceSettings.quality === 'high'
          ? new NativeVoiceWorker({
              executable: this.config.nativePython!,
              args: [
                this.config.nativeLauncher!,
                '--runtime-root',
                this.config.nativeRoot!,
                '--python',
                this.config.nativePython!,
                ...(this.platform.config.agentEngine === 'codex'
                  ? ['--recognition-only']
                  : []),
              ],
            })
          : undefined;
      const native =
        recognition && this.platform.config.agentEngine === 'codex'
          ? new QwenVoiceSession(recognition, this.qwenWorker(voiceSettings))
          : recognition;
      const providerSession =
        !native &&
        this.config.providerSession &&
        this.platform.config.llmProvider === 'codex'
          ? new VoiceProviderSession(receipt.id)
          : undefined;
      const conversation =
        native && this.platform.config.agentEngine === 'codex'
          ? new CodexConversationSession({
              model: this.platform.config.subscriptionModel,
            })
          : undefined;
      const inference =
        conversation ??
        providerSession ??
        (!native && this.config.inferenceSession
          ? new VoiceInferenceSession(receipt.id)
          : undefined);
      const call = new LiveVoiceCall(
        {
          id: receipt.id,
          token: randomBytes(32).toString('base64url'),
          threadId,
          dotId,
          quality: voiceSettings.quality,
        },
        {
          ...(native
            ? {
                nativeContext: () =>
                  this.platform.nativeVoice!.context({
                    callId: receipt.id,
                    threadId,
                    dotId,
                  }),
                nativeTurn: (
                  turn: Parameters<
                    NonNullable<import('./live.js').VoiceCallPort['nativeTurn']>
                  >[0],
                ) =>
                  this.platform.nativeVoice!.turn({
                    ...turn,
                    callId: receipt.id,
                    threadId,
                    dotId,
                    native,
                    ...(conversation
                      ? { intake: (options) => conversation.run(options) }
                      : {}),
                  }),
              }
            : {}),
          voiceTurn: async (utterance) => {
            if (utterance) {
              await this.platform.workspace.recordCallMessages(receipt.id, [
                utterance.messageId,
              ]);
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
            } else clearVoiceTurn(this.platform.workspace, receipt.id);
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
            ...(native
              ? { native }
              : { recognition: this.worker('recognition') }),
            ...(voiceSettings.quality === 'medium'
              ? { synthesis: this.worker('synthesis', voiceSettings) }
              : {}),
            vad: this.worker('vad'),
            inference,
          };
        },
      );
      // The call owns admission through worker cleanup and its final receipts.
      release = undefined;
      this.call = call;
      const detach = native
        ? this.platform.nativeVoice!.listen((job, retainUntilPlayed) => {
            if (
              job.dotId === dotId &&
              job.parentThreadId === threadId &&
              !call.ended
            ) {
              const update = voiceJobReceipt(
                job,
                this.platform.config.agentEngine === 'codex',
              );
              call.nativeUpdate(
                update.id,
                update.spoken,
                this.platform.nativeVoice!.receiptValidator(job),
                {
                  retainUntilPlayed,
                  sourceMessageId: job.sourceMessageId,
                  approval: job.status === 'approval',
                },
              );
            }
          })
        : undefined;
      const detachProgress = native
        ? this.platform.nativeVoice!.listenProgress((progress) => {
            if (
              progress.job.dotId === dotId &&
              progress.job.parentThreadId === threadId &&
              !call.ended
            )
              call.nativeUpdate(
                progress.id,
                progress.text,
                progress.authorize,
                progress.job.status === 'running'
                  ? {
                      sourceMessageId: progress.job.sourceMessageId,
                      approval: false,
                    }
                  : undefined,
              );
          })
        : undefined;
      if (detach)
        call.endSignal.addEventListener('abort', detach, { once: true });
      if (detachProgress)
        call.endSignal.addEventListener('abort', detachProgress, {
          once: true,
        });
      const abort = () => {
        void call.end('Call startup was cancelled.');
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      try {
        await call.start();
        signal.throwIfAborted();
        return {
          id: call.scope.id,
          token: call.scope.token,
          quality: voiceSettings.quality,
        };
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
  async tasks(threadId: string) {
    return this.platform.nativeVoice
      ? this.platform.nativeVoice.list(threadId)
      : [];
  }
  async stopTask(id: string) {
    if (!this.platform.nativeVoice)
      throw Error('Native tasks require local SQLite storage.');
    return this.platform.nativeVoice.cancel(id);
  }
}
