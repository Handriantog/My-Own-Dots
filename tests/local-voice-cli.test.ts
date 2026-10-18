import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.skipIf(
  !existsSync('node_modules/myown-llm-integrator/python/.venv/bin/python'),
)(
  'cancels during PostgreSQL startup without proceeding to inference or leaving a hung process',
  async () => {
    const sockets = new Set<Socket>();
    let connected!: () => void;
    const connection = new Promise<void>((resolve) => {
      connected = resolve;
    });
    const server = createServer((socket) => {
      sockets.add(socket);
      connected();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing fixture port');
    const pending = promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'scripts/local-voice-prototype.mjs', '--fixture'],
      {
        timeout: 14000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          LOCAL_TEST_DATABASE_URL: `postgresql://fixture:unused@127.0.0.1:${address.port}/fixture`,
        },
      },
    );
    const result = pending.then(
      () => {
        throw new Error('Expected cancellation');
      },
      (error) => error,
    );
    try {
      await connection;
      pending.child.kill('SIGTERM');
      const error = await result;
      expect(error.signal).toBe(null);
      expect(error.code).toBe(1);
      expect(error.stdout).toBe('');
      expect(error.stderr).not.toContain('Offline provider completed');
    } finally {
      pending.child.kill('SIGKILL');
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  16000,
);
