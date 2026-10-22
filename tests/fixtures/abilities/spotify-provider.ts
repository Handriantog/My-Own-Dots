// Synthetic HTTPS transport only. Production grant/DNS/TLS/header/body checks still run.
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import type { AbilityHttpsTransport } from '../../../src/desktop/host/abilities/http.ts';
export const sentinel = 'SPOTIFY_SENTINEL<script>private</script>';
export const trackId = '1'.repeat(22),
  playlistId = '3'.repeat(22);
export const trackUri = 'spotify:track:' + trackId;
export const playlistUri = 'spotify:playlist:' + playlistId;
export const track = {
  id: trackId,
  uri: trackUri,
  type: 'track',
  name: sentinel,
  artists: [{ name: 'Synthetic Artist' }],
  is_playable: true,
};
export const playlist = {
  id: playlistId,
  uri: playlistUri,
  type: 'playlist',
  name: sentinel,
  public: false,
};
export function spotifyProvider() {
  const state = {
    urls: [] as URL[],
    requests: [] as {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
    }[],
    refreshes: 0,
    creations: 0,
    token: 'FAKE_ACCESS_TOKEN_SENTINEL',
    failure: undefined as
      | { path: string; kind: 'reject' | 'drop' | 'stall'; status?: number }
      | undefined,
    rejectAuth: false,
    beforeRefresh: async () => {},
  };
  const transport: AbilityHttpsTransport = {
    lookup: async (hostname) => {
      if (!['api.spotify.com', 'accounts.spotify.com'].includes(hostname))
        throw Error('Unexpected fixture origin');
      return [{ address: '93.184.215.14', family: 4 }];
    },
    request: ((
      url: URL,
      options: RequestOptions,
      respond: (response: IncomingMessage) => void,
    ) => {
      const request = new EventEmitter() as ClientRequest;
      let destroyed = false;
      const abort = () =>
        request.destroy(new Error('Synthetic aborted transport'));
      request.destroy = (error?: Error) => {
        if (destroyed) return request;
        destroyed = true;
        options.signal?.removeEventListener('abort', abort);
        if (error) queueMicrotask(() => request.emit('error', error));
        return request;
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      request.end = ((bytes?: string | Buffer) => {
        if (destroyed) return request;
        const body = String(bytes ?? '');
        state.requests.push({
          url: url.href,
          method: options.method!,
          headers: { ...(options.headers as Record<string, string>) },
          body,
        });
        void (async () => {
          let status = 200,
            result: unknown = {};
          if (url.hostname === 'accounts.spotify.com') {
            if (url.pathname !== '/api/token' || options.method !== 'POST')
              throw Error('Unexpected token request');
            const form = new URLSearchParams(body);
            if (form.has('client_secret')) throw Error('Secret is forbidden');
            if (form.get('grant_type') === 'refresh_token') {
              state.refreshes++;
              await state.beforeRefresh();
              state.token = 'FAKE_ROTATED_TOKEN_SENTINEL';
            } else {
              const { createHash } = await import('node:crypto');
              const authorization = state.urls.at(-1)!;
              if (
                form.get('redirect_uri') !==
                  authorization.searchParams.get('redirect_uri') ||
                createHash('sha256')
                  .update(form.get('code_verifier')!)
                  .digest('base64url') !==
                  authorization.searchParams.get('code_challenge')
              )
                throw Error('PKCE mismatch');
            }
            result = {
              access_token: state.token,
              refresh_token: 'FAKE_REFRESH_TOKEN_SENTINEL',
              token_type: 'Bearer',
              expires_in: 3600,
            };
          } else {
            if (state.rejectAuth) {
              state.rejectAuth = false;
              status = 401;
            } else if (
              (options.headers as Record<string, string>).Authorization !==
              'Bearer ' + state.token
            )
              status = 401;
            else if (state.failure?.path === url.pathname) {
              const failure = state.failure;
              state.failure = undefined;
              if (
                url.pathname === '/v1/me/playlists' &&
                options.method === 'POST'
              )
                state.creations++;
              if (failure.kind === 'drop') throw Error(sentinel);
              if (failure.kind === 'stall') await new Promise(() => {});
              status = failure.status ?? 503;
              result = { error: { message: sentinel } };
            } else if (url.pathname === '/v1/search')
              result = {
                tracks: {
                  items: [
                    track,
                    {
                      ...track,
                      id: '2'.repeat(22),
                      uri: 'spotify:track:' + '2'.repeat(22),
                    },
                  ],
                },
              };
            else if (url.pathname === '/v1/me/player/devices')
              result = {
                devices: [
                  {
                    id: 'fixture-player',
                    name: sentinel,
                    is_active: true,
                    is_restricted: false,
                    supports_volume: true,
                  },
                ],
              };
            else if (
              url.pathname === '/v1/me/player' &&
              options.method === 'GET'
            )
              result = { item: track, is_playing: true };
            else if (
              url.pathname === '/v1/me/playlists' &&
              options.method === 'GET'
            )
              result = { items: [playlist], total: 1 };
            else if (url.pathname === '/v1/me/playlists') {
              state.creations++;
              status = 201;
              result = playlist;
            } else if (url.pathname === '/v1/playlists/' + playlistId)
              result = playlist;
            else {
              status = 204;
              result = '';
            }
          }
          if (destroyed) return;
          options.signal?.removeEventListener('abort', abort);
          const response = Readable.from([
            typeof result === 'string' ? result : JSON.stringify(result),
          ]) as IncomingMessage;
          response.statusCode = status;
          response.headers = { 'content-type': 'application/json' };
          respond(response);
        })().catch((error) => request.destroy(error));
        return request;
      }) as ClientRequest['end'];
      queueMicrotask(() => {
        if (destroyed) return;
        const socket = Object.assign(new EventEmitter(), {
          encrypted: true,
          connecting: true,
          authorized: false,
          remoteAddress: '93.184.215.14',
        });
        request.emit('socket', socket);
        socket.connecting = false;
        socket.authorized = true;
        socket.emit('secureConnect');
      });
      return request;
    }) as AbilityHttpsTransport['request'],
  };
  return { state, transport };
}
