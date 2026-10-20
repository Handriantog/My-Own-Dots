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
it('distinguishes snapshotting from a verified backup', async () => {
  let listener: (value: StorageStatus) => void = () => {};
  const status: StorageStatus = {
    secureStorage: false,
    destination: '/external/backups',
    automatic: false,
    operation: { id: 'snapshot-id', kind: 'backup', phase: 'snapshot' },
  };
  const bridge: DesktopStorageBridge = {
    status: vi.fn(async () => status),
    chooseBackupDirectory: vi.fn(),
    backupNow: vi.fn(),
    setAutomatic: vi.fn(),
    previewRestore: vi.fn(),
    previewMigration: vi.fn(),
    migrate: vi.fn(),
    restore: vi.fn(),
    cancel: vi.fn(),
    onStatus: (callback) => {
      listener = callback;
      return () => {};
    },
  };
  await act(async () => {
    root = create(<StorageSettings bridge={bridge} />);
  });
  expect(JSON.stringify(root.toJSON())).toContain(
    'Creating a consistent snapshot',
  );
  expect(JSON.stringify(root.toJSON())).not.toContain('Backup verified');
  await act(async () => {
    listener({
      ...status,
      lastSuccess: new Date(0).toISOString(),
      operation: { id: 'snapshot-id', kind: 'backup', phase: 'ready' },
    });
  });
  expect(JSON.stringify(root.toJSON())).toContain('Backup verified');
  expect(
    root.root.findByProps({ 'aria-label': 'Remember recovery password' }).props
      .disabled,
  ).toBe(true);
  expect(
    root.root.findByProps({ 'aria-label': 'Automatic daily backups' }).props
      .disabled,
  ).toBe(true);
});
