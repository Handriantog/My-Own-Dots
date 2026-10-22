// First-party probes: only disposable paths, ports and PIDs from the harness.
import fs from 'node:fs';
import net from 'node:net';
import { spawnSync } from 'node:child_process';

const [op, ...args] = process.argv.slice(2);
let result = -1;
let error = 0;
try {
  if (op === 'race') {
    result = 0;
    for (let i = 0; i < 5000; i++) {
      try {
        const fd = fs.openSync(args[0], 'r+');
        try {
          result += fs.writeSync(fd, 'x');
        } finally {
          fs.closeSync(fd);
        }
      } catch (failure) {
        if (!['EPERM', 'EACCES'].includes(failure.code)) throw failure;
      }
    }
  } else if (op === 'read') {
    const fd = fs.openSync(args[0], 'r');
    try {
      result = fs.readSync(fd, Buffer.alloc(1), 0, 1, null);
    } finally {
      fs.closeSync(fd);
    }
  } else if (op === 'write') {
    fs.writeFileSync(args[0], 'x');
    result = 1;
  } else if (op === 'hardlink') {
    fs.linkSync(args[0], args[1]);
    result = 0;
  } else if (op === 'network' || op === 'unix') {
    await new Promise((resolve, reject) => {
      const connection = net.createConnection(
        op === 'network'
          ? { host: '127.0.0.1', port: Number(args[0]) }
          : { path: args[0] },
      );
      connection.once('error', reject);
      connection.once('connect', () => {
        connection.destroy();
        resolve();
      });
    });
    result = 0;
  } else if (op === 'fork') {
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    if (child.error) throw child.error;
    result = child.pid;
  } else if (op === 'signal') {
    process.kill(Number(args[0]), 'SIGUSR1');
    result = 0;
  } else if (op === 'fd') {
    result = fs.readSync(Number(args[0]), Buffer.alloc(1), 0, 1, null);
  } else if (op === 'env') {
    result = ['ABILITY_TEST_SECRET', 'NODE_OPTIONS', 'PYTHONPATH'].some(
      (key) => key in process.env,
    )
      ? 1
      : 0;
  } else if (op === 'linger') {
    process.on('SIGTERM', () => {});
    console.log(JSON.stringify({ pid: process.pid }));
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  } else throw new Error('unknown probe');
} catch (failure) {
  error = Math.abs(
    failure.errno ?? { EPERM: 1, EACCES: 13, EBADF: 9 }[failure.code] ?? -1,
  );
}
console.log(JSON.stringify({ result, errno: error, pid: process.pid }));
