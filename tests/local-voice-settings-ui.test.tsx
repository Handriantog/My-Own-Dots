import { createElement, createRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  VoiceSettings,
  type VoiceSettingsHandle,
  type VoiceSettingsProps,
} from '../src/client/local-voice/VoiceSettings';
import { WorkspaceDialog } from '../src/client/WorkspaceDialog';
import type { Dot, State, WorkspaceState } from '../src/shared/types';

vi.mock('../src/client/api', () => ({
  authHeaders: () => ({ Authorization: 'Bearer owner-token' }),
  api: vi.fn(async () => []),
}));
vi.mock('../src/client/LocalLearningSettings', () => ({
  LocalLearningSettings: () => null,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

// No real audio device or provider is used by these tests.
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = 'suspended';
  destination = {};
  source = {
    buffer: null,
    onended: null as (() => void) | null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  decodeAudioData = vi.fn(async () => ({ duration: 1 }));
  createBufferSource = vi.fn(() => this.source);
  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

let root: ReactTestRenderer | undefined;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const defaults = { voiceId: 'af_heart', personality: 'natural' };
const props: VoiceSettingsProps = {
  dotId: 'dot-a',
  callActive: false,
  previewReady: true,
};

function button(label: string) {
  return root!.root.findByProps({ 'aria-label': label });
}
function select(label: string) {
  return root!.root.findByProps({ 'aria-label': label });
}
async function click(label: string) {
  await act(async () => button(label).props.onClick());
}
async function change(label: string, value: string) {
  await act(async () => select(label).props.onChange({ target: { value } }));
}
async function mount(next: VoiceSettingsProps = props) {
  await act(async () => {
    root = create(createElement(VoiceSettings, next));
  });
  await click('Voice & personality');
}
function settingsCalls(method: string) {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === method);
}
function wav() {
  return new Response(new Uint8Array([82, 73, 70, 70]), {
    headers: { 'Content-Type': 'audio/wav' },
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  FakeAudioContext.instances = [];
  fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'POST') return wav();
    return Response.json(
      init?.method === 'PUT' ? JSON.parse(String(init.body)) : defaults,
    );
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('loads the Dot settings on expansion and saves edits only after explicit Save', async () => {
  await act(async () => {
    root = create(createElement(VoiceSettings, props));
  });
  expect(fetchMock).not.toHaveBeenCalled();
  await click('Voice & personality');
  expect(select('Voice').props.value).toBe('af_heart');
  expect(
    root!.root.findAllByType('optgroup').map((g) => g.props.label),
  ).toEqual([
    'American · Female',
    'American · Male',
    'British · Female',
    'British · Male',
  ]);
  expect(select('Voice').findAllByType('option')).toHaveLength(28);
  await change('Voice', 'bm_george');
  await change('Personality', 'calm');
  expect(settingsCalls('PUT')).toHaveLength(0);
  await click('Save voice settings');
  expect(settingsCalls('PUT')).toHaveLength(1);
  const [url, init] = settingsCalls('PUT')[0];
  expect(url).toBe('/api/local-voice/dots/dot-a/settings');
  expect(JSON.parse(String(init!.body))).toEqual({
    voiceId: 'bm_george',
    personality: 'calm',
    quality: 'medium',
  });
  expect(init!.headers).toMatchObject({ Authorization: 'Bearer owner-token' });
  expect(button('Save voice settings').props.disabled).toBe(true);
  expect(JSON.stringify(root!.toJSON())).toContain('Saved');
});

it('saves all three quality choices before setup, refreshes readiness, and never previews Basic or High', async () => {
  const onSaved = vi.fn();
  await mount({ ...props, previewReady: false, onSaved });
  expect(
    select('Voice chat quality')
      .findAllByType('option')
      .map((option) => option.props.value),
  ).toEqual(['basic', 'medium', 'high']);
  await change('Voice chat quality', 'basic');
  expect(select('Voice').props.disabled).toBe(true);
  await click('Preview voice');
  expect(FakeAudioContext.instances).toHaveLength(0);
  await click('Save voice settings');
  expect(JSON.parse(String(settingsCalls('PUT')[0][1]!.body))).toEqual({
    ...defaults,
    quality: 'basic',
  });
  expect(onSaved).toHaveBeenCalledOnce();
  await change('Voice chat quality', 'high');
  expect(
    select('Voice')
      .findAllByType('option')
      .map((option) => option.children.join('')),
  ).toEqual(['Model voice']);
  expect(JSON.stringify(root!.toJSON())).toContain('not available yet');
  await click('Save voice settings');
  expect(JSON.parse(String(settingsCalls('PUT')[1][1]!.body)).quality).toBe(
    'high',
  );
  expect(FakeAudioContext.instances).toHaveLength(0);
  await change('Voice chat quality', 'medium');
  expect(select('Voice').props.value).toBe('af_heart');
});

it('makes the persisted quality selector available directly in the existing Dot settings before setup', async () => {
  const dot = {
    id: 'dot-a',
    name: 'Dot',
    spaceId: 'space',
    spaceIds: ['space'],
  } as Dot;
  const onSaved = vi.fn();
  await act(async () => {
    root = create(
      <WorkspaceDialog
        embedded
        dialog={{ type: 'dot', dot, spaceId: 'space' }}
        state={{ settings: {} } as State}
        workspace={
          {
            spaces: [{ id: 'space', name: 'Space' }],
            setup: { conversationBackend: 'local', llmBackend: 'subscription' },
          } as WorkspaceState
        }
        voiceStatus={{
          enabled: false,
          ready: false,
          reason: 'Speech models need setup.',
        }}
        onVoiceSettingsSaved={onSaved}
        onClose={() => {}}
        mutate={vi.fn()}
      />,
    );
  });
  await act(async () =>
    root!.root
      .findByProps({ 'aria-label': 'Voice', type: 'button' })
      .props.onClick(),
  );
  expect(select('Voice chat quality').props.disabled).toBe(false);
  await change('Voice chat quality', 'basic');
  await act(async () =>
    root!.root
      .findByProps({ 'aria-label': 'General', type: 'button' })
      .props.onClick(),
  );
  await act(async () =>
    root!.root
      .findByProps({ 'aria-label': 'Voice', type: 'button' })
      .props.onClick(),
  );
  expect(select('Voice chat quality').props.value).toBe('basic');
  await click('Save voice settings');
  expect(settingsCalls('PUT')[0][0]).toBe(
    '/api/local-voice/dots/dot-a/settings',
  );
  expect(onSaved).toHaveBeenCalledOnce();
  expect(root!.root.findAllByType('form')).toHaveLength(1);
  expect(FakeAudioContext.instances).toHaveLength(0);
});

it('keeps unsaved choices and allows retry after a failed save', async () => {
  await mount();
  await change('Personality', 'cheerful');
  fetchMock.mockResolvedValueOnce(
    Response.json({ error: 'Storage unavailable' }, { status: 503 }),
  );
  await click('Save voice settings');
  expect(select('Personality').props.value).toBe('cheerful');
  expect(root!.root.findByProps({ role: 'alert' }).children.join('')).toContain(
    'Storage unavailable',
  );
  expect(button('Save voice settings').props.disabled).toBe(false);
  await click('Save voice settings');
  expect(button('Save voice settings').props.disabled).toBe(true);
});

it('refreshes both settings surfaces and stops preview when one saves a different quality', async () => {
  let persisted = { ...defaults, quality: 'medium' };
  fetchMock.mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') return wav();
    if (init?.method === 'PUT') persisted = JSON.parse(String(init.body));
    return Response.json(persisted);
  });
  const views = () => (
    <div>
      {[0, 1].map((key) => (
        <VoiceSettings
          key={key}
          {...props}
          initiallyOpen
          status={{
            enabled: true,
            ready: true,
            reason: '',
            selectedQuality: persisted.quality as 'basic' | 'medium',
            settingsRevision: JSON.stringify(persisted),
          }}
          onSaved={() => root!.update(views())}
        />
      ))}
    </div>
  );
  await act(async () => {
    root = create(views());
  });
  const control = (index: number, label: string) => {
    const panel = root!.root.findAllByType(VoiceSettings)[index];
    return panel.findByProps({ 'aria-label': label });
  };
  await act(async () => control(1, 'Preview voice').props.onClick());
  const context = FakeAudioContext.instances[0];
  expect(context.source.start).toHaveBeenCalledOnce();
  await act(async () =>
    control(0, 'Voice chat quality').props.onChange({
      target: { value: 'basic' },
    }),
  );
  await act(async () => control(0, 'Save voice settings').props.onClick());
  expect(control(1, 'Voice chat quality').props.value).toBe('basic');
  expect(control(1, 'Preview voice').props.disabled).toBe(true);
  expect(context.close).toHaveBeenCalledOnce();
  await act(async () =>
    control(1, 'Personality').props.onChange({ target: { value: 'calm' } }),
  );
  await act(async () => control(1, 'Save voice settings').props.onClick());
  expect(persisted).toMatchObject({ quality: 'basic', personality: 'calm' });
  expect(control(0, 'Personality').props.value).toBe('calm');
});

it('aborts an old Dot save and ignores its response after switching Dots', async () => {
  await mount();
  await change('Voice', 'bm_george');
  const oldSave = deferred<Response>();
  fetchMock.mockReturnValueOnce(oldSave.promise);
  await click('Save voice settings');
  const signal = settingsCalls('PUT')[0][1]!.signal!;
  await act(async () =>
    root!.update(createElement(VoiceSettings, { ...props, dotId: 'dot-b' })),
  );
  expect(signal.aborted).toBe(true);
  await click('Voice & personality');
  await act(async () =>
    oldSave.resolve(
      Response.json({ voiceId: 'bm_george', personality: 'natural' }),
    ),
  );
  expect(select('Voice').props.value).toBe('af_heart');
  await change('Personality', 'serious');
  await click('Save voice settings');
  expect(settingsCalls('PUT')[1][0]).toBe(
    '/api/local-voice/dots/dot-b/settings',
  );
});

it('unlocks audio in the Preview gesture, previews unsaved choices, and releases playback on completion', async () => {
  await mount();
  await change('Voice', 'bf_emma');
  const audioResponse = deferred<Response>();
  fetchMock.mockImplementationOnce(() => {
    expect(FakeAudioContext.instances[0].resume).toHaveBeenCalledTimes(1);
    return audioResponse.promise;
  });
  await click('Preview voice');
  expect(settingsCalls('PUT')).toHaveLength(0);
  expect(JSON.parse(String(settingsCalls('POST')[0][1]!.body))).toEqual({
    voiceId: 'bf_emma',
    personality: 'natural',
    quality: 'medium',
  });
  const context = FakeAudioContext.instances[0];
  expect(context.source.start).not.toHaveBeenCalled();
  await act(async () => audioResponse.resolve(wav()));
  expect(context.source.start).toHaveBeenCalledTimes(1);
  await act(async () => context.source.onended?.());
  expect(context.close).toHaveBeenCalledTimes(1);
  expect(context.source.disconnect).toHaveBeenCalledTimes(1);
  expect(button('Preview voice').props.disabled).toBe(false);
});

it.each(['selection', 'close', 'call', 'unmount', 'explicit stop'])(
  'cancels a pending preview on %s and never starts its late audio',
  async (reason) => {
    const handle = createRef<VoiceSettingsHandle>();
    await mount({ ...props, ref: handle });
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    await click('Preview voice');
    const signal = settingsCalls('POST')[0][1]!.signal!;
    if (reason === 'selection') await change('Personality', 'calm');
    if (reason === 'close') await click('Voice & personality');
    if (reason === 'call')
      await act(async () =>
        root!.update(
          createElement(VoiceSettings, {
            ...props,
            ref: handle,
            callActive: true,
          }),
        ),
      );
    if (reason === 'unmount') {
      await act(async () => root!.unmount());
      root = undefined;
    }
    if (reason === 'explicit stop')
      await act(async () => handle.current!.stopPreview());
    expect(signal.aborted).toBe(true);
    const context = FakeAudioContext.instances[0];
    expect(context.state).toBe('closed');
    await act(async () => pending.resolve(wav()));
    expect(context.source.start).not.toHaveBeenCalled();
  },
);

it('stops playing audio when a selection changes and disables controls during a call', async () => {
  await mount();
  await click('Preview voice');
  const context = FakeAudioContext.instances[0];
  expect(context.source.start).toHaveBeenCalledTimes(1);
  await change('Voice', 'af_bella');
  expect(context.source.stop).toHaveBeenCalledTimes(1);
  expect(context.state).toBe('closed');
  await act(async () =>
    root!.update(createElement(VoiceSettings, { ...props, callActive: true })),
  );
  expect(select('Voice').props.disabled).toBe(true);
  expect(select('Personality').props.disabled).toBe(true);
  expect(button('Save voice settings').props.disabled).toBe(true);
  expect(button('Preview voice').props.disabled).toBe(true);
});

it('shows preview errors and releases the audio context without changing saved settings', async () => {
  await mount();
  fetchMock.mockResolvedValueOnce(
    Response.json({ error: 'Local speech unavailable' }, { status: 503 }),
  );
  await click('Preview voice');
  expect(FakeAudioContext.instances[0].state).toBe('closed');
  expect(root!.root.findByProps({ role: 'alert' }).children.join('')).toContain(
    'Local speech unavailable',
  );
  expect(settingsCalls('PUT')).toHaveLength(0);
  expect(button('Preview voice').props.disabled).toBe(false);
});

it('bounds a stuck preview, aborts its fetch, and releases audio for retry', async () => {
  vi.useFakeTimers();
  await mount();
  fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));
  await click('Preview voice');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30001);
  });
  expect(settingsCalls('POST')[0][1]!.signal!.aborted).toBe(true);
  expect(FakeAudioContext.instances[0].state).toBe('closed');
  expect(root!.root.findByProps({ role: 'alert' }).children.join('')).toContain(
    'timed out',
  );
  expect(button('Preview voice').props.disabled).toBe(false);
});

it('releases the context even when playback cannot start or stop its source', async () => {
  await mount();
  fetchMock.mockImplementationOnce(async () => {
    const source = FakeAudioContext.instances[0].source;
    source.start.mockImplementationOnce(() => {
      throw new Error('Speaker unavailable');
    });
    source.stop.mockImplementationOnce(() => {
      throw new DOMException('Source has not started', 'InvalidStateError');
    });
    return wav();
  });
  await click('Preview voice');
  expect(FakeAudioContext.instances[0].state).toBe('closed');
  expect(root!.root.findByProps({ role: 'alert' }).children.join('')).toContain(
    'Speaker unavailable',
  );
});

it('selects and previews High voices separately from the retained Medium voice', async () => {
  await mount({
    ...props,
    status: {
      enabled: true,
      ready: true,
      reason: '',
      modes: {
        high: {
          ready: true,
          reason: '',
          needsSetup: false,
          audioInput: true,
          audioOutput: true,
          speechEngine: 'qwen3',
        },
      },
    } as VoiceSettingsProps['status'],
  });
  await change('Voice', 'bm_george');
  await change('Voice chat quality', 'high');
  expect(select('Voice').props.disabled).toBe(false);
  expect(select('Voice').props.value).toBe('vivian');
  expect(select('Voice').findAllByType('option')).toHaveLength(9);
  await change('Voice', 'ryan');
  fetchMock.mockResolvedValueOnce(wav());
  await click('Preview voice');
  expect(JSON.parse(String(settingsCalls('POST')[0][1]!.body))).toMatchObject({
    quality: 'high',
    highVoiceId: 'ryan',
    voiceId: 'bm_george',
  });
  await change('Voice chat quality', 'medium');
  expect(select('Voice').props.value).toBe('bm_george');
  expect(FakeAudioContext.instances[0].state).toBe('closed');
  await change('Voice chat quality', 'high');
  expect(select('Voice').props.value).toBe('ryan');
  await click('Save voice settings');
  expect(JSON.parse(String(settingsCalls('PUT')[0][1]!.body))).toMatchObject({
    highVoiceId: 'ryan',
    quality: 'high',
  });
});

it('cancels High preview when its engine becomes unavailable', async () => {
  const status = {
    enabled: true,
    ready: false,
    reason: '',
    modes: {
      high: {
        ready: true,
        reason: '',
        needsSetup: false,
        audioInput: true,
        audioOutput: true,
        speechEngine: 'qwen3',
      },
    },
  } as VoiceSettingsProps['status'];
  await mount({ ...props, previewReady: false, status });
  await change('Voice chat quality', 'high');
  const pending = deferred<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  await click('Preview voice');
  const signal = settingsCalls('POST')[0][1]!.signal!;
  await act(async () =>
    root!.update(
      createElement(VoiceSettings, {
        ...props,
        previewReady: false,
        status: {
          ...status!,
          modes: {
            ...status!.modes!,
            high: { ...status!.modes!.high, ready: false },
          },
        },
      }),
    ),
  );
  expect(signal.aborted).toBe(true);
  await act(async () => pending.resolve(wav()));
  expect(FakeAudioContext.instances[0].source.start).not.toHaveBeenCalled();
});
