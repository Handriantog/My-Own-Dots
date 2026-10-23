import { spawn } from 'node:child_process';
import type { Binding } from '../../../shared/abilities/types.js';

type VolumeBinding = Pick<
  Binding,
  'dotId' | 'digest' | 'enabled' | 'restored' | 'grants'
> & {
  manifest: {
    permissions: {
      id: string;
      kind: string;
      application?: string;
      actions?: string[];
    }[];
  };
};
export function permitsSpotifyDucking(
  data: {
    bindings: VolumeBinding[];
    installed?: { digest: string; enabled: boolean; restored: boolean }[];
  },
  dotId: string,
): boolean {
  return data.bindings.some(
    (binding) =>
      binding.dotId === dotId &&
      binding.enabled &&
      !binding.restored &&
      data.installed?.some(
        (item) =>
          item.digest === binding.digest && item.enabled && !item.restored,
      ) &&
      binding.manifest.permissions.some(
        (permission) =>
          permission.kind === 'app-control' &&
          permission.application === 'com.spotify.client' &&
          permission.actions?.includes('volume') &&
          binding.grants.includes(permission.id),
      ),
  );
}
export interface VolumeLease {
  heartbeat(): void;
  close(): Promise<void>;
}
type Session = {
  dotId: string;
  abort: AbortController;
  lease?: VolumeLease;
  timer?: ReturnType<typeof setInterval>;
  checking?: boolean;
};

/** One shared session across workspace/companion windows. No model calls or audio cross this boundary. */
export class SpotifyDucking {
  private current?: Session;
  private release?: ReturnType<typeof setTimeout>;
  private operations: Promise<void> = Promise.resolve();
  constructor(
    private readonly authorize: (
      dotId: string,
      signal: AbortSignal,
    ) => Promise<boolean>,
    private readonly open: () => VolumeLease,
  ) {}
  playback(dotId: string, active: boolean): void {
    if (!active) {
      if (this.current?.dotId === dotId && !this.release)
        this.release = setTimeout(() => {
          void this.stop();
        }, 250);
      return;
    }
    clearTimeout(this.release);
    this.release = undefined;
    if (this.current?.dotId === dotId) return;
    void this.stop();
    const session: Session = { dotId, abort: new AbortController() };
    this.current = session;
    this.operations = this.operations
      .then(async () => {
        if (!(await this.allowed(session)) || this.current !== session) return;
        session.lease = this.open();
        session.lease.heartbeat();
        session.timer = setInterval(() => {
          void this.renew(session);
        }, 1000);
        session.timer.unref?.();
      })
      .catch(() => {
        if (this.current === session) void this.stop();
      });
  }
  private async allowed(session: Session): Promise<boolean> {
    try {
      return (
        !session.abort.signal.aborted &&
        (await this.authorize(
          session.dotId,
          AbortSignal.any([session.abort.signal, AbortSignal.timeout(1500)]),
        ))
      );
    } catch {
      return false;
    }
  }
  private async renew(session: Session): Promise<void> {
    if (this.current !== session || session.checking) return;
    session.checking = true;
    const allowed = await this.allowed(session);
    session.checking = false;
    if (this.current !== session) return;
    if (!allowed) {
      void this.stop();
      return;
    }
    session.lease?.heartbeat();
  }
  stop(): Promise<void> {
    clearTimeout(this.release);
    this.release = undefined;
    const session = this.current;
    this.current = undefined;
    session?.abort.abort();
    clearInterval(session?.timer);
    this.operations = this.operations
      .catch(() => {})
      .then(async () => {
        await session?.lease?.close();
      });
    return this.operations;
  }
}

/** The fixed native helper owns restoration even if Electron exits unexpectedly. */
export function openSpotifyVolumeLease(helper: string): VolumeLease {
  const child = spawn(helper, ['--duck'], {
    shell: false,
    cwd: '/',
    env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  let ended = false;
  const closed = new Promise<void>((resolve) => {
    const finish = () => {
      ended = true;
      resolve();
    };
    child.once('error', finish);
    child.once('close', finish);
  });
  child.stdin.on('error', () => {});
  return {
    heartbeat() {
      if (!ended && !child.stdin.destroyed) child.stdin.write('1\n');
    },
    async close() {
      child.stdin.end();
      // EOF/parent loss restores in the helper. A blocked OS reply is bounded too.
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 7000);
      timer.unref?.();
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
