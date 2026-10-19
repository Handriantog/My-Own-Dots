import { describe, expect, it } from 'vitest';
import { MaintenanceGate } from '../../src/server/storage/maintenance.ts';

const signal = () => new AbortController().signal;
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

describe('workspace maintenance gate', () => {
  it('waits for tool result and workspace receipt before snapshot', async () => {
    const gate = new MaintenanceGate();
    const tool = await gate.enterWrite(signal());
    const receipt = await gate.enterWrite(signal());
    let captured = false;
    const snapshot = gate
      .acquire({ origin: 'automatic', signal: signal() })
      .then((lease) => {
        captured = true;
        return lease;
      });
    await turn();
    expect(captured).toBe(false);
    tool();
    await turn();
    expect(captured).toBe(false);
    receipt();
    const lease = await snapshot;
    expect(gate.status()).toEqual({ held: true, activeWrites: 0 });
    lease.release();
    lease.release();
    expect(gate.status()).toEqual({ held: false, activeWrites: 0 });
  });
  it('automatic snapshot yields before new run', async () => {
    const gate = new MaintenanceGate();
    const snapshot = await gate.acquire({
      origin: 'automatic',
      signal: signal(),
    });
    let admitted = false;
    const writer = gate.enterWrite(signal()).then((release) => {
      admitted = true;
      return release;
    });
    await turn();
    expect(snapshot.signal.aborted).toBe(true);
    expect(admitted).toBe(false);
    // Cancellation is only a request. Reader cleanup must finish before admission.
    snapshot.release();
    (await writer)();
    expect(admitted).toBe(true);
    expect(gate.status().activeWrites).toBe(0);
  });
  it('manual snapshot refuses active voice', async () => {
    const gate = new MaintenanceGate();
    const call = await gate.enterWrite(signal());
    await expect(
      gate.acquire({ origin: 'manual', signal: signal() }),
    ).rejects.toThrow(/busy/i);
    expect(gate.status()).toEqual({ held: false, activeWrites: 1 });
    call();
    (await gate.acquire({ origin: 'manual', signal: signal() })).release();
  });
  it('drains background work for manual snapshots without blocking nested receipts', async () => {
    const gate = new MaintenanceGate();
    const finish = deferred();
    const entered = deferred();
    const work = gate.runWrite(
      signal(),
      async () => {
        entered.resolve();
        await finish.promise;
        await gate.runWrite(signal(), async () => {
          expect(gate.status().activeWrites).toBe(2);
        });
      },
      { background: true },
    );
    await entered.promise;
    const snapshot = gate.acquire({ origin: 'manual', signal: signal() });
    finish.resolve();
    await work;
    (await snapshot).release();
    expect(gate.status()).toEqual({ held: false, activeWrites: 0 });
  });
  it('background ticks wait without cancelling a snapshot', async () => {
    const gate = new MaintenanceGate();
    const snapshot = await gate.acquire({
      origin: 'automatic',
      signal: signal(),
    });
    let ran = false;
    const work = gate.runWrite(
      signal(),
      async () => {
        ran = true;
      },
      { background: true },
    );
    await turn();
    expect(ran).toBe(false);
    expect(snapshot.signal.aborted).toBe(false);
    snapshot.release();
    await work;
    expect(ran).toBe(true);
  });
  it('cancels a waiting snapshot and resumes admission', async () => {
    const gate = new MaintenanceGate();
    const writer = await gate.enterWrite(signal(), { background: true });
    const controller = new AbortController();
    const waiting = gate.acquire({
      origin: 'manual',
      signal: controller.signal,
    });
    const rejected = expect(waiting).rejects.toThrow();
    controller.abort();
    await rejected;
    (await gate.enterWrite(signal()))();
    writer();
    expect(gate.status()).toEqual({ held: false, activeWrites: 0 });
  });
  it('aborting a held snapshot still waits for reader cleanup', async () => {
    const gate = new MaintenanceGate();
    const controller = new AbortController();
    const snapshot = await gate.acquire({
      origin: 'manual',
      signal: controller.signal,
    });
    controller.abort();
    let ran = false;
    const work = gate.runWrite(signal(), async () => {
      ran = true;
    });
    await turn();
    expect(ran).toBe(false);
    expect(snapshot.signal.aborted).toBe(true);
    snapshot.release();
    await work;
  });
  it('does not leak cancelled writers or thrown operation leases', async () => {
    const gate = new MaintenanceGate();
    const snapshot = await gate.acquire({ origin: 'manual', signal: signal() });
    const controller = new AbortController();
    const write = gate.enterWrite(controller.signal);
    const rejected = expect(write).rejects.toThrow();
    controller.abort();
    await rejected;
    snapshot.release();
    await expect(
      gate.runWrite(signal(), async () => {
        throw new Error('test failure');
      }),
    ).rejects.toThrow('test failure');
    expect(gate.status()).toEqual({ held: false, activeWrites: 0 });
  });
  it('refuses concurrent snapshots', async () => {
    const gate = new MaintenanceGate();
    const snapshot = await gate.acquire({ origin: 'manual', signal: signal() });
    await expect(
      gate.acquire({ origin: 'automatic', signal: signal() }),
    ).rejects.toThrow(/busy/i);
    snapshot.release();
  });
  it('stale async context cannot enter a held snapshot', async () => {
    const gate = new MaintenanceGate();
    const start = deferred();
    let late!: Promise<void>;
    let ran = false;
    await gate.runWrite(signal(), async () => {
      late = start.promise.then(() =>
        gate.runWrite(signal(), async () => {
          ran = true;
        }),
      );
    });
    const snapshot = await gate.acquire({ origin: 'manual', signal: signal() });
    start.resolve();
    await turn();
    expect(ran).toBe(false);
    snapshot.release();
    await late;
    expect(ran).toBe(true);
  });
  it('shutdown permanently closes queued and future admissions', async () => {
    const gate = new MaintenanceGate();
    const snapshot = await gate.acquire({ origin: 'manual', signal: signal() });
    const waiting = gate.enterWrite(signal());
    const rejected = expect(waiting).rejects.toThrow(/closed/i);
    gate.close();
    await rejected;
    expect(snapshot.signal.aborted).toBe(true);
    snapshot.release();
    await expect(gate.enterWrite(signal())).rejects.toThrow(/closed/i);
    await expect(
      gate.acquire({ origin: 'automatic', signal: signal() }),
    ).rejects.toThrow(/closed/i);
  });
});

it('admits foreground when cancelled snapshot cleanup releases synchronously', async () => {
  const gate = new MaintenanceGate();
  const snapshot = await gate.acquire({
    origin: 'automatic',
    signal: signal(),
  });
  snapshot.signal.addEventListener('abort', snapshot.release, { once: true });
  let admitted = false;
  const writer = gate
    .enterWrite(signal())
    .then((release) => {
      admitted = true;
      release();
    })
    .catch(() => {});
  try {
    await turn();
    expect(admitted).toBe(true);
    expect(gate.status()).toEqual({ held: false, activeWrites: 0 });
  } finally {
    gate.close();
    await writer;
  }
});

it('keeps shutdown draining until both readers and already admitted writers finish', async () => {
  const gate = new MaintenanceGate();
  const writer = await gate.enterWrite(new AbortController().signal, {
    background: true,
  });
  gate.close();
  let drained = false;
  const waiting = gate.drain().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(drained).toBe(false);
  writer();
  await waiting;
  const other = new MaintenanceGate();
  const reader = await other.acquire({
    origin: 'manual',
    signal: new AbortController().signal,
  });
  other.close();
  drained = false;
  const cleaning = other.drain().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(reader.signal.aborted).toBe(true);
  expect(drained).toBe(false);
  reader.release();
  await cleaning;
});
