import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceDialog } from '../src/client/WorkspaceDialog';
import type { Dot, State, WorkspaceState } from '../src/shared/types';

vi.mock('../src/client/api', () => ({
  authHeaders: () => ({}),
  api: vi.fn(async () => []),
}));
const dot = {
  id: 'dot-a',
  createdAt: 1,
  name: 'Researcher',
  instructions: 'Compare evidence.',
  spaceId: 'one',
  spaceIds: ['one'],
  researchAllowed: true,
  memoryAllowed: true,
  appsAllowed: false,
  composioToolkits: [],
} as Dot;
const workspace = {
  spaces: [
    { id: 'one', name: 'Personal' },
    { id: 'two', name: 'Work' },
  ],
  setup: { conversationBackend: 'local', llmBackend: 'openai' },
} as WorkspaceState;
let root: ReactTestRenderer;
const mutate = vi.fn(async () => true);
const close = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback());
});
afterEach(async () => {
  await act(async () => root?.unmount());
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => {
    root = create(
      <WorkspaceDialog
        embedded
        dialog={{ type: 'dot', dot, spaceId: 'one' }}
        state={{ settings: {} } as State}
        workspace={workspace}
        mutate={mutate}
        onClose={close}
      />,
    );
  });
}
async function category(label: string) {
  const nav = root.root.findByProps({
    'aria-label': 'Dot settings categories',
  });
  const button = nav
    .findAllByType('button')
    .find((b) => b.props['aria-label'] === label)!;
  await act(async () => button.props.onClick());
}
async function field(id: string, value: string) {
  await act(async () =>
    root.root.findByProps({ id }).props.onChange({ target: { value } }),
  );
}
async function save() {
  await act(async () =>
    root.root.findByType('form').props.onSubmit({ preventDefault() {} }),
  );
}

it('keeps name and access drafts across sections and saves them together', async () => {
  await mount();
  await field('entity-name', 'Analyst');
  await category('Access');
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'Access Work' })
      .props.onChange({ target: { checked: true } }),
  );
  await field('default-space', 'two');
  await category('Connections');
  await field('composio-toolkits', 'gmail, google_calendar');
  await category('General');
  expect(root.root.findByProps({ id: 'entity-name' }).props.value).toBe(
    'Analyst',
  );
  await save();
  expect(mutate).toHaveBeenCalledWith(
    '/dots/dot-a',
    'PUT',
    expect.objectContaining({
      name: 'Analyst',
      spaceId: 'two',
      spaceIds: ['one', 'two'],
      composioToolkits: ['gmail', 'google_calendar'],
    }),
  );
  expect(close).toHaveBeenCalledOnce();
});

it('reveals invalid access instead of silently saving from another section', async () => {
  await mount();
  await category('Access');
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'Access Personal' })
      .props.onChange({ target: { checked: false } }),
  );
  await category('General');
  await save();
  expect(mutate).not.toHaveBeenCalled();
  expect(
    root.root.findByProps({ 'aria-label': 'Access', 'aria-current': 'page' }),
  ).toBeTruthy();
  expect(root.root.findByProps({ role: 'alert' }).children.join('')).toContain(
    'Space',
  );
});

it('keeps edits and permits retry when saving rejects', async () => {
  await mount();
  await field('entity-name', 'Analyst');
  mutate.mockRejectedValueOnce(new Error('Connection lost'));
  await save();
  expect(close).not.toHaveBeenCalled();
  expect(root.root.findByProps({ role: 'alert' }).children.join('')).toContain(
    'Connection lost',
  );
  expect(root.root.findByProps({ id: 'entity-name' }).props.value).toBe(
    'Analyst',
  );
  await save();
  expect(close).toHaveBeenCalledOnce();
});

it('targets customization at the edited Dot and offers one desktop selection', async () => {
  const openPreferences = vi.fn(async () => {});
  const selectDesktopDot = vi.fn(async () => {});
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      dotWorkspace: { openPreferences, selectDesktopDot },
    }),
  );
  await mount();
  const button = (label: string) =>
    root.root
      .findAllByType('button')
      .find((b) => b.children.join('') === label)!;
  await act(async () => button('Customize…').props.onClick());
  expect(openPreferences).toHaveBeenCalledWith('dot-a');
  await act(async () => button('Use on desktop').props.onClick());
  expect(selectDesktopDot).toHaveBeenCalledWith('dot-a');
  expect(button('On desktop').props.disabled).toBe(true);
});
