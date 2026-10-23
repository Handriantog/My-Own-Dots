import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { memoryRepositories } from '../fixtures/memory-repositories.ts';
import { AbilityService } from '../../src/server/abilities/service.ts';
import { AbilityHostBridge } from '../../src/server/abilities/host-bridge.ts';
import { DesktopAbilityBridge } from '../../src/desktop/host/abilities/bridge.ts';
import type { JsonValue } from '../../src/shared/abilities/types.ts';
import type { AppCommand } from '../../src/shared/abilities/app-control.ts';
const sentinel = 'LOCAL_PRIVATE_SENTINEL',
  trackUri = 'spotify:track:0000000000000000000000';
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
  'packaged Spotify Local through the production host',
  () => {
    let root: string,
      bundle: string,
      runtime: typeof import('../../src/desktop/host/abilities/distribution.ts');
    let descriptorBytes: Buffer, bytes: Buffer;
    beforeAll(async () => {
      // Missing fixture is a failure, never a fallback to a live account or network.
      descriptorBytes = await readFile(
        'tests/fixtures/abilities/spotify-local/spotify-local-0.1.0.json',
      );
      bytes = await readFile(
        'tests/fixtures/abilities/spotify-local/spotify-local-0.1.0.dot-ability.tar.gz',
      );
      root = await realpath(
        await mkdtemp(join(tmpdir(), 'spotify-production-')),
      );
      bundle = join(root, 'bundle');
      const builder = await import(
        pathToFileURL(resolve('scripts/abilities/build.mjs')).href
      );
      await builder.buildAbilityRuntime(process.cwd(), bundle);
      runtime = createRequire(import.meta.url)(
        join(bundle, 'ability-runtime.cjs'),
      );
    });
    afterAll(async () => {
      if (root) await rm(root, { recursive: true, force: true });
    });
    async function fixture() {
      const data = await memoryRepositories('sqlite');
      cleanup.push(data.close);
      const home = await mkdtemp(join(root, 'workspace-'));
      const dot = (await data.workspace.dots())[0];
      const threadId = randomUUID();
      await data.workspace.bindThread(threadId, dot.id, 'Spotify acceptance');
      await data.conversations.getOrCreateThread({
        threadId,
        userId: data.owner,
        agentId: dot.id,
      });
      const descriptor = runtime.parseReleaseDescriptor(
        JSON.parse(descriptorBytes.toString()),
      );
      const review = {
        id: randomUUID(),
        expiresAt: Date.now() + 60000,
        descriptor,
        descriptorSha256: createHash('sha256')
          .update(descriptorBytes)
          .digest('hex'),
        descriptorUrl:
          'https://github.com/handriantog/my-own-dot-abilities/releases/download/' +
          encodeURIComponent(descriptor.releaseTag) +
          '/spotify-local-0.1.0.json',
        archiveUrl:
          'https://api.github.com/repos/handriantog/my-own-dot-abilities/releases/assets/1',
      };
      const backend = new AbilityHostBridge(data.owner);
      let service = new AbilityService(data.workspace, backend, {
        workspaceId: data.owner,
        resolve: async () => ({ ...structuredClone(review), id: randomUUID() }),
      });
      backend.setAuthority((context) => service.authorize(context));
      cleanup.push(() => backend.stop());
      const token = 'offline-owner-token-at-least-thirty-two-bytes';
      const app = new Hono();
      app.route('/ability-host/v1', backend.routes(token));
      const server = serve({
        fetch: app.fetch,
        hostname: '127.0.0.1',
        port: 0,
      });
      await once(server, 'listening');
      cleanup.push(async () => {
        (server as Server).closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
      });
      const effects: AppCommand[] = [];
      let mode: 'normal' | 'uncertain' | 'pending' = 'normal',
        aborted = false;
      const executable = await realpath(process.execPath);
      const installer = new runtime.AbilityInstaller(
        join(home, 'installation'),
        {
          resolve: async () => structuredClone(review),
          download: async () => bytes,
        },
      );
      const host: InstanceType<typeof runtime.AbilityHost> =
        new runtime.AbilityHost({
          workspaceId: data.owner,
          packageRoot: join(home, 'installation'),
          stateRoot: join(home, 'state'),
          controlRoot: join(home, 'control'),
          credentialRoot: join(home, 'credentials'),
          launcher: join(bundle, 'native/ability-launcher'),
          runtimes: {
            javascript: {
              executable,
              readRoots: [dirname(dirname(executable))],
            },
          },
          installer,
          appControl: async (command, signal) => {
            effects.push(command);
            if (mode === 'pending')
              await new Promise<void>((resolve) =>
                signal.addEventListener(
                  'abort',
                  () => {
                    aborted = true;
                    resolve();
                  },
                  { once: true },
                ),
              );
            if (mode !== 'normal')
              return { ok: true, kind: 'app-control', status: 'uncertain' };
            return {
              ok: true,
              kind: 'app-control',
              status: 'success',
              ...(command.action === 'search'
                ? {
                    result: {
                      kind: 'list',
                      title: 'Results',
                      items: [{ label: sentinel, action: { uri: trackUri } }],
                    },
                  }
                : command.action === 'playlists'
                  ? {
                      result: {
                        kind: 'list',
                        title: 'Playlists',
                        items: [
                          {
                            label: sentinel,
                            action: { playlistName: 'Fixture list' },
                          },
                        ],
                      },
                    }
                  : {}),
            };
          },
          storage: {
            isEncryptionAvailable: () => false,
            encryptString: () => {
              throw Error('No credentials');
            },
            decryptString: () => {
              throw Error('No credentials');
            },
          },
          session: () => desktop.session,
          binding: (id) => service.get(id),
          authorize: (context) => desktop.authorize(context),
          open: async () => {
            throw Error('No external account flow');
          },
        });
      const desktop: DesktopAbilityBridge = new DesktopAbilityBridge(
        {
          url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
          workspaceId: data.owner,
          ownerToken: token,
        },
        host,
      );
      cleanup.push(() => desktop.stop());
      await desktop.start();
      const approved = await service.review(dot.id, review.descriptorUrl);
      expect(await service.list(dot.id)).toEqual([]);
      expect(effects).toEqual([]);
      const binding = await service.teach(dot.id, approved.id, {});
      const invoke = (
        tool: string,
        args: Record<string, JsonValue> = {},
        extra: Record<string, unknown> = {},
      ) =>
        service.invoke(
          {
            dotId: dot.id,
            bindingId: binding.id,
            threadId,
            tool,
            invocationId: randomUUID(),
            arguments: args,
            ...extra,
          },
          new AbortController().signal,
        );
      return {
        ...data,
        home,
        dot,
        threadId,
        binding,
        descriptor,
        host,
        desktop,
        backend,
        effects,
        mode: (value: typeof mode) => {
          mode = value;
        },
        aborted: () => aborted,
        invoke,
        service,
        restartService: () => {
          service = new AbilityService(data.workspace, backend, {
            workspaceId: data.owner,
          });
          return service;
        },
      };
    }
    it('seals the real worker, admits voice, keeps choices private, and applies the selected track and playlist once', async () => {
      const f = await fixture();
      expect(await f.service.tools(f.dot.id, 'voice')).toHaveLength(13);
      const other = await f.workspace.createDot(
        f.dot.spaceId,
        'Other',
        'Fixture',
        true,
        true,
      );
      expect(await f.service.tools(other.id, 'voice')).toEqual([]);
      const args = { query: 'synthetic recording' };
      const first = await f.invoke('add_to_playlist', args, {
        channel: 'voice',
      });
      expect(first.status).toBe('selection_needed');
      expect(JSON.stringify(first)).not.toContain(sentinel);
      if (!('resultRef' in first) || !first.resultRef) throw Error('No result');
      expect(
        await f.host.readResult(other.id, first.resultRef),
      ).toBeUndefined();
      const tracks = await f.host.readResult(f.dot.id, first.resultRef);
      if (tracks?.kind !== 'list') throw Error('No list');
      expect(tracks.items[0].label).toBe(sentinel);
      const selected = await f.host.select(
        f.dot.id,
        first.resultRef,
        tracks.items[0].id,
      );
      const second = await f.invoke('add_to_playlist', args, {
        selectionRef: selected,
        channel: 'voice',
      });
      expect(second.status).toBe('selection_needed');
      if (!('resultRef' in second) || !second.resultRef)
        throw Error('No result');
      const lists = await f.host.readResult(f.dot.id, second.resultRef);
      if (lists?.kind !== 'list') throw Error('No list');
      const destination = await f.host.select(
        f.dot.id,
        second.resultRef,
        lists.items[0].id,
      );
      expect(
        await f.invoke('add_to_playlist', args, {
          selectionRef: destination,
          channel: 'voice',
        }),
      ).toEqual({ status: 'success' });
      expect(f.effects).toEqual([
        { action: 'search', query: args.query, category: 'tracks' },
        { action: 'playlists' },
        {
          action: 'add_to_playlist',
          query: args.query,
          trackUri,
          playlistName: 'Fixture list',
        },
      ]);
      expect(
        await f.invoke('add_to_playlist', args, { selectionRef: destination }),
      ).toMatchObject({ status: 'error' });
      expect(f.effects).toHaveLength(3);
    });
    it('does not replay uncertainty and disables active owned control', async () => {
      const f = await fixture();
      f.mode('uncertain');
      expect(await f.invoke('next')).toEqual({ status: 'uncertain' });
      expect(f.effects).toEqual([{ action: 'next' }]);
      f.mode('pending');
      const pending = f.invoke('pause');
      await expect.poll(() => f.effects.length).toBe(2);
      await f.service.disable(f.binding.id);
      expect(await pending).toEqual({ status: 'uncertain' });
      await expect.poll(f.aborted).toBe(true);
      expect(await f.service.tools(f.dot.id, 'voice')).toEqual([]);
      expect(await f.invoke('play')).toMatchObject({ status: 'error' });
      expect(f.effects).toHaveLength(2);
    });
  },
);
