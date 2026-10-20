import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { StorageSettings } from '../src/client/StorageSettings';
import type {
  DesktopStorageBridge,
  StorageStatus,
} from '../src/desktop/shared/storage-contract.js';
let root: ReactTestRenderer;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
});
function fixture(initial: Partial<StorageStatus> = {}) {
  let state: StorageStatus = {
    workspaceDirectory: '/workspace',
    secureStorage: false,
    automatic: false,
    ...initial,
  };
  let listener: (value: StorageStatus) => void = () => {};
  const bridge: DesktopStorageBridge = {
    status: vi.fn(async () => state),
    chooseBackupFile: vi.fn(async () => '/backups/My Dots.dotbackup'),
    chooseRestoreArchive: vi.fn(async () => ({
      name: 'My Dots.dotbackup',
      encrypted: false,
    })),
    chooseBackupDirectory: vi.fn(),
    backupNow: vi.fn(),
    setAutomatic: vi.fn(),
    previewRestore: vi.fn(),
    previewMigration: vi.fn(),
    migrate: vi.fn(),
    openWorkspaceFolder: vi.fn(),
    chooseWorkspaceMove: vi.fn(),
    moveWorkspace: vi.fn(),
    restore: vi.fn(),
    cancel: vi.fn(),
    onStatus: (callback) => {
      listener = callback;
      return () => {};
    },
  };
  const input = { value: '', focus: vi.fn() };
  return {
    bridge,
    input,
    async mount() {
      await act(async () => {
        root = create(<StorageSettings bridge={bridge} />, {
          createNodeMock: (node) =>
            (node.props as { type?: string }).type === 'password'
              ? input
              : null,
        });
      });
    },
    async update(value: Partial<StorageStatus>) {
      state = { ...state, ...value };
      await act(async () => listener(state));
    },
  };
}
function button(label: string) {
  return root.root
    .findAllByType('button')
    .find((node) => node.children.join('') === label)!;
}
const content = () => JSON.stringify(root.toJSON());
it('opens a native save picker first and creates a backup without a password by default', async () => {
  const f = fixture();
  await f.mount();
  expect(root.root.findAllByType('input')).toHaveLength(0);
  await act(async () => button('Backup').props.onClick());
  expect(f.bridge.chooseBackupFile).toHaveBeenCalledOnce();
  expect(f.bridge.backupNow).not.toHaveBeenCalled();
  expect(content()).toContain('/backups/My Dots.dotbackup');
  await act(async () => button('Save backup').props.onClick());
  expect(f.bridge.backupNow).toHaveBeenCalledExactlyOnceWith({
    passphrase: '',
    remember: false,
  });
  expect(f.bridge.previewMigration).not.toHaveBeenCalled();
});
it('only requires a password after protection is selected and clears it on submit', async () => {
  const f = fixture();
  await f.mount();
  await act(async () => button('Backup').props.onClick());
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'Protect with a password' })
      .props.onChange({ target: { checked: true } }),
  );
  await act(async () => button('Save backup').props.onClick());
  expect(f.bridge.backupNow).not.toHaveBeenCalled();
  expect(f.input.focus).toHaveBeenCalledOnce();
  f.input.value = 'private test phrase';
  await act(async () => button('Save backup').props.onClick());
  expect(f.bridge.backupNow).toHaveBeenCalledExactlyOnceWith({
    passphrase: 'private test phrase',
    remember: false,
  });
  expect(f.input.value).toBe('');
});
it('prevents duplicate pickers and leaves the home view on cancellation', async () => {
  const f = fixture();
  let finish: (value: string | undefined) => void = () => {};
  f.bridge.chooseBackupFile = vi.fn(
    () =>
      new Promise<string | undefined>((resolve) => {
        finish = resolve;
      }),
  );
  await f.mount();
  await act(async () => button('Backup').props.onClick());
  expect(button('Backup').props.disabled).toBe(true);
  expect(button('Restore').props.disabled).toBe(true);
  await act(async () => finish(undefined));
  expect(button('Backup').props.disabled).toBe(false);
  expect(button('Save backup')).toBeUndefined();
});
it.each([false, true])(
  'only asks for a restore password when encrypted=%s',
  async (encrypted) => {
    const f = fixture();
    f.bridge.chooseRestoreArchive = vi.fn(async () => ({
      name: 'My Dots.dotbackup',
      encrypted,
    }));
    await f.mount();
    await act(async () => button('Restore').props.onClick());
    expect(f.bridge.chooseRestoreArchive).toHaveBeenCalledOnce();
    expect(root.root.findAllByProps({ type: 'password' })).toHaveLength(
      encrypted ? 1 : 0,
    );
    if (encrypted) {
      await act(async () => button('Review backup').props.onClick());
      expect(f.bridge.previewRestore).not.toHaveBeenCalled();
      f.input.value = 'private test phrase';
    }
    await act(async () => button('Review backup').props.onClick());
    expect(f.bridge.previewRestore).toHaveBeenCalledExactlyOnceWith({
      passphrase: encrypted ? 'private test phrase' : '',
    });
    expect(f.input.value).toBe('');
  },
);
it('restores a verified preview after remount with one restore action', async () => {
  const f = fixture({
    preview: {
      operationId: 'preview-id',
      workspaceId: 'workspace-id',
      counts: { memory_items: 3 },
      coverage: [],
      warnings: [],
      destination: '/restored',
    },
  });
  await f.mount();
  expect(content()).toContain('3');
  expect(button('Backup')).toBeUndefined();
  await act(async () => button('Restore').props.onClick());
  expect(f.bridge.restore).toHaveBeenCalledExactlyOnceWith({
    operationId: 'preview-id',
    mode: 'new',
  });
});
it('keeps the storage upgrade in details and includes its backup in the guided flow', async () => {
  const f = fixture({ migrationAvailable: true });
  await f.mount();
  expect(
    root.root
      .findAllByType('details')
      .some((node) =>
        node
          .findAllByType('button')
          .some((b) => b.children.join('') === 'Upgrade storage'),
      ),
  ).toBe(true);
  await act(async () => button('Upgrade storage').props.onClick());
  await act(async () => button('Start upgrade').props.onClick());
  expect(f.bridge.previewMigration).toHaveBeenCalledExactlyOnceWith({
    passphrase: '',
  });
  expect(f.bridge.backupNow).not.toHaveBeenCalled();
  await f.update({ migrationAvailable: false, storageEngine: 'sqlite' });
  expect(button('Upgrade storage')).toBeUndefined();
});
it('clears startup errors on a status update and distinguishes progress from completion', async () => {
  const f = fixture();
  vi.mocked(f.bridge.status).mockRejectedValueOnce(
    new Error('Workspace starting'),
  );
  await f.mount();
  expect(content()).toContain('Workspace starting');
  await f.update({
    operation: { id: 'id', kind: 'backup', phase: 'snapshot' },
  });
  expect(content()).not.toContain('Workspace starting');
  expect(content()).toContain('Creating a snapshot');
  expect(content()).not.toContain('Backup saved');
  await f.update({
    operation: { id: 'id', kind: 'backup', phase: 'ready' },
    lastSuccess: new Date(0).toISOString(),
  });
  expect(content()).toContain('Backup saved');
});

it('allows cancellation while the backup request is still running', async () => {
  const f = fixture();
  let finish: () => void = () => {};
  f.bridge.backupNow = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await f.mount();
  await act(async () => button('Backup').props.onClick());
  await act(async () => button('Save backup').props.onClick());
  await f.update({
    operation: { id: 'active-operation', kind: 'backup', phase: 'archive' },
  });
  expect(button('Cancel operation').props.disabled).not.toBe(true);
  await act(async () => button('Cancel operation').props.onClick());
  expect(f.bridge.cancel).toHaveBeenCalledExactlyOnceWith('active-operation');
  await act(async () => finish());
});
it('shows active backup progress instead of an earlier success message', async () => {
  const f = fixture();
  await f.mount();
  await act(async () => button('Backup').props.onClick());
  await act(async () => button('Save backup').props.onClick());
  expect(content()).toContain('Backup saved to');
  await f.update({
    operation: { id: 'automatic-operation', kind: 'backup', phase: 'snapshot' },
  });
  expect(content()).toContain('Creating a snapshot');
  expect(content()).not.toContain('Backup saved to');
});
