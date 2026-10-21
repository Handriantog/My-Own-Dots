import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  LocalSpeechWorker,
  RecognitionInputError,
} from '../src/server/local-voice/worker.js';

const launch = (mode = 'normal', pidFile?: string) =>
  new LocalSpeechWorker({
    executable: '/usr/bin/python3',
    args: [
      '-B',
      resolve('tests/fixtures/voice-worker.py'),
      mode,
      ...(pidFile ? [pidFile] : []),
    ],
  });
it('preserves bounded rejection and recovery reasons without exposing worker error text', async () => {
  const worker = launch('recognition-diagnostics');
  const signal = new AbortController().signal;
  try {
    await worker.warm(signal);
    const error = await worker
      .transcribe(Buffer.alloc(16000), 'en', signal)
      .catch((error) => error);
    expect(error).toBeInstanceOf(RecognitionInputError);
    expect(error).toMatchObject({
      reason: 'invalid_segment_text',
      fallbackReason: 'invalid_timestamp',
    });
    expect(error.message).not.toContain('PRIVATE');
    expect(
      await worker.transcribe(Buffer.alloc(16000), 'en', signal),
    ).toMatchObject({
      text: 'Hello Dot',
      fallbackReason: 'invalid_timestamp',
    });
  } finally {
    await worker.close();
  }
});
it('passes bounded English recognition context to the worker and rejects invalid hints before decoding', async () => {
  const worker = launch('recognition-context');
  const signal = new AbortController().signal;
  try {
    await worker.warm(signal);
    await expect(
      worker.transcribe(
        Buffer.alloc(16000),
        'en',
        signal,
        'Sapa, mountain views.',
      ),
    ).resolves.toMatchObject({ text: 'Hello Dot' });
    for (const hint of ['x'.repeat(601), 'bad\u0000hint'])
      await expect(
        worker.transcribe(Buffer.alloc(16000), 'en', signal, hint),
      ).rejects.toThrow(/context/i);
    await expect(
      worker.transcribe(Buffer.alloc(16000), 'id', signal, 'English hint'),
    ).rejects.toThrow(/context/i);
  } finally {
    await worker.close();
  }
});
it('passes selected voice/personality without changing legacy synthesis requests', async () => {
  const worker = new LocalSpeechWorker({
    executable: '/usr/bin/python3',
    args: ['-B', resolve('tests/fixtures/voice-worker.py'), 'selected-voice'],
    voiceSettings: {
      voiceId: 'bm_george',
      personality: 'calm',
      quality: 'medium',
    },
  });
  try {
    const signal = new AbortController().signal;
    await worker.warm(signal);
    expect(await worker.synthesize('Hello.', signal)).toHaveLength(4800);
  } finally {
    await worker.close();
  }
});
it('keeps the worker usable after an explicitly recoverable utterance error', async () => {
  const worker = launch('recognition-input');
  const signal = new AbortController().signal;
  try {
    await worker.warm(signal);
    await expect(
      worker.transcribe(Buffer.alloc(16000), 'en', signal),
    ).rejects.toBeInstanceOf(RecognitionInputError);
    expect(
      (await worker.transcribe(Buffer.alloc(16000), 'en', signal)).text,
    ).toBe('Hello Dot');
  } finally {
    await worker.close();
  }
});
it('reuses one warm worker for recognition and synthesis with bounded valid PCM', async () => {
  const worker = launch();
  const signal = new AbortController().signal;
  try {
    await worker.warm(signal);
    await worker.warm(signal);
    expect(
      await worker.transcribe(Buffer.alloc(16000), 'en', signal),
    ).toMatchObject({ text: 'Hello Dot', language: 'en' });
    expect(await worker.synthesize('Hello', signal)).toHaveLength(4800);
  } finally {
    await worker.close();
  }
  await expect(worker.warm(signal)).rejects.toThrow(/closed/);
});
it.each(['bad-id', 'oversized'])(
  'rejects %s worker protocol before using any output',
  async (mode) => {
    const worker = launch(mode);
    try {
      await expect(worker.warm(new AbortController().signal)).rejects.toThrow(
        /protocol|limit/i,
      );
    } finally {
      await worker.close();
    }
  },
);
it('rejects malformed base64 audio', async () => {
  const worker = launch('invalid-pcm');
  const signal = new AbortController().signal;
  try {
    await worker.warm(signal);
    await expect(worker.synthesize('Hello', signal)).rejects.toThrow(/PCM/);
  } finally {
    await worker.close();
  }
});
it('keeps VAD state across frames and resets it without restarting the worker', async () => {
  const worker = launch();
  const signal = new AbortController().signal;
  try {
    await worker.warm(signal);
    expect(await worker.detect(Buffer.alloc(1024), signal)).toBe(0.25);
    expect(await worker.detect(Buffer.alloc(1024), signal)).toBe(0.5);
    await worker.reset(signal);
    expect(await worker.detect(Buffer.alloc(1024), signal)).toBe(0.25);
    for (const bytes of [0, 512, 1023, 1025, 2048])
      await expect(worker.detect(Buffer.alloc(bytes), signal)).rejects.toThrow(
        /PCM/,
      );
    expect(await worker.detect(Buffer.alloc(1024), signal)).toBe(0.5);
  } finally {
    await worker.close();
  }
});
it.each([
  'vad-negative',
  'vad-overflow',
  'vad-text',
  'vad-extra',
  'reset-invalid',
])('rejects %s VAD results', async (mode) => {
  const worker = launch(mode);
  const signal = new AbortController().signal;
  try {
    await worker.warm(signal);
    await expect(
      mode === 'reset-invalid'
        ? worker.reset(signal)
        : worker.detect(Buffer.alloc(1024), signal),
    ).rejects.toThrow();
  } finally {
    await worker.close();
  }
});
it('cancelling synthesis leaves the separate recognition and VAD workers warm', async () => {
  const recognition = launch();
  const synthesis = launch('synthesis-hang');
  const vad = launch();
  const signal = new AbortController().signal;
  const cancellation = new AbortController();
  try {
    await Promise.all([
      recognition.warm(signal),
      synthesis.warm(signal),
      vad.warm(signal),
    ]);
    expect(await vad.detect(Buffer.alloc(1024), signal)).toBe(0.25);
    const pending = expect(
      synthesis.synthesize('Hello', cancellation.signal),
    ).rejects.toThrow(/cancel/i);
    cancellation.abort(new DOMException('Cancelled', 'AbortError'));
    await pending;
    expect(
      (await recognition.transcribe(Buffer.alloc(16000), 'en', signal)).text,
    ).toBe('Hello Dot');
    expect(await vad.detect(Buffer.alloc(1024), signal)).toBe(0.5);
  } finally {
    await Promise.all([recognition.close(), synthesis.close(), vad.close()]);
  }
});
it('aborts and reaps a busy worker; no automatic restart or late response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-worker-'));
  const file = join(directory, 'pid');
  const worker = launch('hang', file);
  const controller = new AbortController();
  try {
    await worker.warm(controller.signal);
    const pid = Number(await readFile(file, 'utf8'));
    const pending = worker.transcribe(
      Buffer.alloc(16000),
      'en',
      controller.signal,
    );
    const rejected = expect(pending).rejects.toThrow(/cancel/i);
    controller.abort(new DOMException('Cancelled', 'AbortError'));
    await rejected;
    await worker.close();
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
