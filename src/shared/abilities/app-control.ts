import { z } from 'zod';

export const spotifyApplication = 'com.spotify.client' as const;
export const appActionSchema = z.enum([
  'play',
  'pause',
  'next',
  'previous',
  'volume',
  'seek',
  'shuffle',
  'repeat',
  'play_uri',
  'search',
  'playlists',
  'save_current',
  'create_playlist',
  'add_to_playlist',
]);
export const spotifyTrackUri = z
  .string()
  .regex(/^spotify:track:[A-Za-z0-9]{22}$/);
export const spotifyPlaylistUri = z
  .string()
  .regex(/^spotify:playlist:[A-Za-z0-9]{22}$/);
export const appCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('play') }),
  z.strictObject({ action: z.literal('pause') }),
  z.strictObject({ action: z.literal('next') }),
  z.strictObject({ action: z.literal('previous') }),
  z.strictObject({
    action: z.literal('volume'),
    percent: z.number().int().min(0).max(100),
  }),
  z.strictObject({
    action: z.literal('seek'),
    seconds: z.number().finite().min(0).max(86400),
  }),
  z.strictObject({ action: z.literal('shuffle'), enabled: z.boolean() }),
  z.strictObject({ action: z.literal('repeat'), enabled: z.boolean() }),
  z.strictObject({
    action: z.literal('play_uri'),
    uri: z.string().regex(/^spotify:(track|album|playlist):[A-Za-z0-9]{22}$/),
  }),
  z.strictObject({
    action: z.literal('search'),
    query: z.string().trim().min(1).max(200),
    category: z.enum(['tracks', 'playlists']),
  }),
  z.strictObject({ action: z.literal('playlists') }),
  z.strictObject({ action: z.literal('save_current') }),
  z.strictObject({
    action: z.literal('create_playlist'),
    name: z.string().trim().min(1).max(100),
  }),
  z.strictObject({
    action: z.literal('add_to_playlist'),
    query: z.string().trim().min(1).max(200),
    playlistName: z.string().trim().min(1).max(100),
    trackUri: spotifyTrackUri,
  }),
]);
export type AppCommand = z.infer<typeof appCommandSchema>;
export const uiAppActions = new Set<AppCommand['action']>([
  'search',
  'playlists',
  'save_current',
  'create_playlist',
  'add_to_playlist',
]);
export const appActionLabels: Record<AppCommand['action'], string> = {
  play: 'Play',
  pause: 'Pause',
  next: 'Next track',
  previous: 'Previous track',
  volume: 'Change volume',
  seek: 'Seek',
  shuffle: 'Change shuffle',
  repeat: 'Change repeat',
  play_uri: 'Play Spotify links',
  search: 'Search',
  playlists: 'Read playlists',
  save_current: 'Save the current song',
  create_playlist: 'Create private playlists',
  add_to_playlist: 'Add songs to playlists',
};
