import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/server/workspace';
import {
  DEFAULT_VOICE_SETTINGS,
  VOICES,
  voiceSettingsSchema,
} from '../src/shared/voice-settings';

it('persists voice and personality per Dot across restarts without altering role instructions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dot-voice-settings-'));
  let workspace = new WorkspaceStore(join(dir, 'workspace.sqlite'), 'owner');
  try {
    const dot = workspace.dots()[0];
    const other = workspace.createDot(
      dot.spaceId,
      'Other',
      'Original role',
      false,
      false,
    );
    expect(workspace.voiceSettings(dot.id)).toEqual(DEFAULT_VOICE_SETTINGS);
    workspace.setVoiceSettings(dot.id, {
      voiceId: 'bm_george',
      personality: 'serious',
    });
    workspace.close();
    workspace = new WorkspaceStore(join(dir, 'workspace.sqlite'), 'owner');
    expect(workspace.voiceSettings(dot.id)).toEqual({
      voiceId: 'bm_george',
      personality: 'serious',
      quality: 'medium',
    });
    expect(workspace.voiceSettings(other.id)).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(workspace.dot(dot.id)?.instructions).toBe(dot.instructions);
    expect(() =>
      workspace.setVoiceSettings('missing', DEFAULT_VOICE_SETTINGS),
    ).toThrow();
    expect(() =>
      workspace.setVoiceSettings(dot.id, {
        voiceId: '../../model',
        personality: 'serious',
      }),
    ).toThrow();
  } finally {
    workspace.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('normalizes legacy records and preserves an explicit quality on older updates', () => {
  const database = new DatabaseSync(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner', database);
  try {
    const dot = workspace.dots()[0];
    const legacy = { voiceId: 'af_heart', personality: 'calm' };
    database
      .prepare('INSERT INTO dot_voice_settings VALUES (?,?)')
      .run(dot.id, JSON.stringify(legacy));
    expect(workspace.voiceSettings(dot.id)).toEqual({
      ...legacy,
      quality: 'medium',
    });
    workspace.setVoiceSettings(dot.id, { ...legacy, quality: 'high' });
    expect(
      workspace.setVoiceSettings(dot.id, { ...legacy, personality: 'serious' }),
    ).toEqual({ ...legacy, personality: 'serious', quality: 'high' });
    expect(() =>
      workspace.setVoiceSettings(dot.id, { ...legacy, quality: 'ultra' }),
    ).toThrow();
  } finally {
    workspace.close();
    database.close();
  }
});

it('only accepts installed English presets and the four supported personalities', () => {
  expect(VOICES).toHaveLength(28);
  expect(new Set(VOICES.map((v) => v.id)).size).toBe(28);
  for (const voice of VOICES)
    expect(
      voiceSettingsSchema.parse({ voiceId: voice.id, personality: 'calm' })
        .voiceId,
    ).toBe(voice.id);
  for (const invalid of [
    { voiceId: 'jf_alpha', personality: 'natural' },
    { voiceId: 'af_heart', personality: 'angry' },
    { ...DEFAULT_VOICE_SETTINGS, speed: 10 },
  ])
    expect(voiceSettingsSchema.safeParse(invalid).success).toBe(false);
});
