import { expect, it, vi } from 'vitest';
import {
  recoveryView,
  watchWorkspaceStatus,
} from '../../src/desktop/renderer/recovery-state.js';
import type { WorkspaceStatus } from '../../src/desktop/shared/workspace-contract.js';

it('shows real startup stages without inventing a completion percentage', () => {
  const view = recoveryView({
    phase: 'starting',
    stage: 'services',
    message: 'Starting local PostgreSQL with Docker Compose…',
  });
  expect(view.mode).toBe('loading');
  expect(view.activeStep).toBe(1);
  expect(view.status).toBe('Checking your connections');
  expect(view.detail).toContain('PostgreSQL');
  expect(view.showActions).toBe(false);
  expect(view).not.toHaveProperty('percentage');
});

it('reassures during a longer wait without promising an ETA or advancing the stage', () => {
  const state: WorkspaceStatus = {
    phase: 'starting',
    stage: 'backend',
    message: 'Starting…',
  };
  const initial = recoveryView(state);
  const waiting = recoveryView(state, { elapsedMs: 20_000 });
  expect(waiting.activeStep).toBe(initial.activeStep);
  expect(waiting.description).toMatch(/longer|moment/);
  expect(waiting.showActions).toBe(true);
});

it('exposes recovery actions and preserves actionable error details', () => {
  const view = recoveryView({
    phase: 'error',
    message: 'Port 4310 is occupied.',
  });
  expect(view.mode).toBe('error');
  expect(view.showActions).toBe(true);
  expect(view.detail).toBe('Port 4310 is occupied.');
  expect(view.activeStep).toBe(-1);
});

it('distinguishes opening the workspace from deliberately opening setup', () => {
  const state: WorkspaceStatus = {
    phase: 'ready',
    message: 'Workspace ready.',
  };
  expect(recoveryView(state).mode).toBe('ready');
  expect(recoveryView(state)).toMatchObject({
    status: 'Workspace ready',
    showActions: true,
  });
  expect(recoveryView(state, { setup: true })).toMatchObject({
    mode: 'setup',
    showActions: true,
  });
});

it('keeps a degraded ready state actionable and a stopped state restartable', () => {
  const warning = 'Open Docker and retry.';
  expect(
    recoveryView({ phase: 'ready', message: warning, warning }),
  ).toMatchObject({
    detail: warning,
    showActions: true,
    description: expect.stringContaining('needs attention'),
  });
  expect(
    recoveryView({ phase: 'stopped', message: 'Configuration saved.' }),
  ).toMatchObject({ mode: 'stopped', showActions: true });
});

it('does not overwrite a live startup event with an older initial status snapshot', async () => {
  let initial!: (status: WorkspaceStatus) => void;
  let event!: (status: WorkspaceStatus) => void;
  const unsubscribe = vi.fn();
  const render = vi.fn();
  const dispose = watchWorkspaceStatus(
    {
      status: () =>
        new Promise((resolve) => {
          initial = resolve;
        }),
      onStatus: (callback) => {
        event = callback;
        return unsubscribe;
      },
    },
    render,
  );
  event({ phase: 'ready', message: 'Ready' });
  initial({ phase: 'starting', message: 'Old snapshot' });
  await Promise.resolve();
  expect(render).toHaveBeenCalledOnce();
  expect(render).toHaveBeenLastCalledWith({ phase: 'ready', message: 'Ready' });
  dispose();
  event({ phase: 'error', message: 'After teardown' });
  expect(render).toHaveBeenCalledOnce();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it('turns a failed initial connection into recoverable UI without leaking IPC errors', async () => {
  const render = vi.fn();
  const dispose = watchWorkspaceStatus(
    {
      status: async () => {
        throw new Error('internal IPC details');
      },
      onStatus: () => () => {},
    },
    render,
  );
  await vi.waitFor(() => expect(render).toHaveBeenCalled());
  expect(render.mock.calls[0][0]).toMatchObject({
    phase: 'error',
    message: expect.stringMatching(/Retry/),
  });
  expect(render.mock.calls[0][0].message).not.toContain('IPC');
  dispose();
});
