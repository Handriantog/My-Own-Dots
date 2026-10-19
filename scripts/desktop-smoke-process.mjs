/** Stop only the supplied child, with bounded escalation and no dangling timers. */
export async function stopProcess(child, { timeoutMs = 5000 } = {}) {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (exited() || !child.pid) return { forced: false };
  const wait = (timeout) =>
    new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        child.removeListener('exit', finish);
        resolve(exited());
      };
      const timer = setTimeout(finish, timeout);
      child.once('exit', finish);
      if (exited()) finish();
    });
  const graceful = wait(timeoutMs);
  child.kill('SIGTERM');
  if (await graceful) return { forced: false };
  const forced = wait(1000);
  child.kill('SIGKILL');
  if (!(await forced))
    throw new Error('Smoke child did not exit after SIGKILL.');
  return { forced: true };
}
