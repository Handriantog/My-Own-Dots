import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/abilities/manifest.json';
import { parseManifest } from '../../src/shared/abilities/manifest';
import {
  capabilitySchema,
  capabilityReplySchema,
} from '../../src/shared/abilities/protocol';
import { permissionDiff } from '../../src/shared/abilities/permissions';

const permission = {
  id: 'player',
  kind: 'app-control',
  application: 'com.spotify.client',
  actions: ['play', 'pause', 'volume'],
  purpose: 'Control Spotify playback.',
};
describe('scoped application control contract', () => {
  it.each(['play', 'search'])(
    'rejects mixed visibility across a Spotify %s package',
    (action) => {
      expect(() =>
        parseManifest({
          ...fixture,
          permissions: [{ ...permission, actions: [action] }],
          tools: [
            ...structuredClone(fixture.tools),
            {
              ...fixture.tools[0],
              id: 'forward_private_state',
              visibility: 'model-visible',
              output: { type: 'string', maxLength: 200 },
            },
          ],
        }),
      ).toThrow('Spotify app-control requires owner-only tools');
    },
  );
  it('accepts only the supported application and declared action vocabulary', () => {
    const manifest = parseManifest({ ...fixture, permissions: [permission] });
    expect(manifest.permissions).toEqual([permission]);
    for (const change of [
      { application: 'com.apple.Terminal' },
      { actions: ['run_script'] },
      { actions: [] },
      { actions: ['play', 'play'] },
      { script: 'do shell script' },
    ])
      expect(() =>
        parseManifest({
          ...fixture,
          permissions: [{ ...permission, ...change }],
        }),
      ).toThrow();
  });
  it('requires fresh review when UI access is added', () => {
    const before = parseManifest({ ...fixture, permissions: [permission] });
    const after = parseManifest({
      ...fixture,
      permissions: [
        { ...permission, actions: ['play', 'pause', 'volume', 'search'] },
      ],
    });
    expect(permissionDiff(before, after)).toContainEqual({
      key: 'permission:player',
      kind: 'changed',
      requiresConsent: true,
    });
  });
  it.each([
    { action: 'play' },
    { action: 'pause' },
    { action: 'next' },
    { action: 'previous' },
    { action: 'volume', percent: 0 },
    { action: 'volume', percent: 100 },
    { action: 'seek', seconds: 30.5 },
    { action: 'shuffle', enabled: true },
    { action: 'repeat', enabled: false },
    { action: 'play_uri', uri: 'spotify:track:0123456789012345678901' },
    { action: 'search', query: 'Example song', category: 'tracks' },
    { action: 'playlists' },
    { action: 'save_current' },
    { action: 'create_playlist', name: 'Dot test' },
    {
      action: 'add_to_playlist',
      query: 'Example song',
      playlistName: 'Test playlist',
      trackUri: 'spotify:track:0123456789012345678901',
    },
  ])('validates structured command %j', (command) => {
    const request = { kind: 'app-control', ruleId: 'player', command };
    expect(capabilitySchema.parse(request)).toEqual(request);
  });
  it.each([
    { action: 'play', script: 'arbitrary' },
    { action: 'volume', percent: 101 },
    { action: 'volume', percent: -1 },
    { action: 'volume', percent: 1.5 },
    { action: 'seek', seconds: -1 },
    { action: 'seek', seconds: Infinity },
    { action: 'shuffle', enabled: 'true' },
    { action: 'play_uri', uri: 'spotify:track:abc" & do shell script "id' },
    { action: 'search', query: '', category: 'tracks' },
    { action: 'create_playlist', name: 'Dot test', public: true },
    {
      action: 'add_to_playlist',
      playlistUri: 'file:///tmp/target',
      trackUri: 'spotify:track:0123456789012345678901',
    },
  ])('rejects invalid command %j', (command) => {
    expect(
      capabilitySchema.safeParse({
        kind: 'app-control',
        ruleId: 'player',
        command,
      }).success,
    ).toBe(false);
  });
  it('preserves uncertain delivery without accepting raw native errors', () => {
    expect(
      capabilityReplySchema.parse({
        ok: true,
        kind: 'app-control',
        status: 'uncertain',
      }),
    ).toEqual({ ok: true, kind: 'app-control', status: 'uncertain' });
    expect(
      capabilityReplySchema.safeParse({
        ok: true,
        kind: 'app-control',
        status: 'success',
        stderr: 'private output',
      }).success,
    ).toBe(false);
  });
});
