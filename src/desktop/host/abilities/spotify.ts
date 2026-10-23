import { execFile } from 'node:child_process';
import {
  appCommandSchema,
  uiAppActions,
} from '../../../shared/abilities/app-control.js';
import { capabilityReplySchema } from '../../../shared/abilities/protocol.js';
import type { CapabilityReply } from '../../../shared/abilities/types.js';
import { AbilityFailure } from '../../../shared/abilities/bridge.js';
import { openSpotifySurface } from './spotify-ui-session.js';
import { runSpotifyUI } from './spotify-ui.js';
import type { AppControlTransport } from './app-control.js';
/** Fixed bundled executable; this factory is never called with manifest/IPC paths. */
export function createSpotifyTransport(helper: string): AppControlTransport {
  return async (input, signal) => {
    const parsed = appCommandSchema.safeParse(input);
    if (!parsed.success) return { ok: false, code: 'permission_denied' };
    if (signal.aborted) return { ok: false, code: 'cancelled' };
    if (uiAppActions.has(parsed.data.action)) {
      let surface: Awaited<ReturnType<typeof openSpotifySurface>> | undefined;
      try {
        surface = await openSpotifySurface(helper, signal);
        return await runSpotifyUI(parsed.data, surface, signal);
      } catch (error) {
        return {
          ok: false,
          code: error instanceof AbilityFailure ? error.code : 'setup_needed',
        };
      } finally {
        surface?.close();
      }
    }
    return new Promise<CapabilityReply>((resolve) => {
      const uncertain: CapabilityReply = {
        ok: true,
        kind: 'app-control',
        status: 'uncertain',
      };
      const abort = () => {
        child.kill('SIGKILL');
      };
      const child = execFile(
        helper,
        [],
        {
          shell: false,
          cwd: '/',
          env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
          timeout: 31_000,
          killSignal: 'SIGKILL',
          maxBuffer: 256 * 1024,
          encoding: 'utf8',
        },
        (error, stdout) => {
          signal.removeEventListener('abort', abort);
          if (signal.aborted) {
            resolve(uncertain);
            return;
          }
          if (error) {
            resolve(
              (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? { ok: false, code: 'setup_needed' }
                : uncertain,
            );
            return;
          }
          try {
            const reply = capabilityReplySchema.parse(JSON.parse(stdout));
            resolve(
              !reply.ok || reply.kind === 'app-control' ? reply : uncertain,
            );
          } catch {
            resolve(uncertain);
          }
        },
      );
      child.stdin?.on('error', () => {});
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else child.stdin?.end(JSON.stringify(parsed.data));
    });
  };
}
