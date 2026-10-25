import { z } from 'zod';

export const VOICES = [
  {
    id: 'af_alloy',
    name: 'Alloy',
    accent: 'American',
    gender: 'Female',
    language: 'en-us',
  },
  {
    id: 'af_aoede',
    name: 'Aoede',
    accent: 'American',
    gender: 'Female',
    language: 'en-us',
  },
  {
    id: 'af_bella',
    name: 'Bella',
    accent: 'American',
    gender: 'Female',
    language: 'en-us',
  },
  {
    id: 'af_heart',
    name: 'Heart',
    accent: 'American',
    gender: 'Female',
    language: 'en-us',
  },
  {
    id: 'af_jessica',
    name: 'Jessica',
    accent: 'American',
    gender: 'Female',
    language: 'en-us',
  },
  {
    id: 'af_kore',
    name: 'Kore',
    accent: 'American',
    gender: 'Female',
    language: 'en-us',
  },
  {
    id: 'af_nicole',
    name: 'Nicole',
    accent: 'American',
    gender: 'Female',
    language: 'en-us',
  },
  {
    id: 'af_nova',
    name: 'Nova',
    accent: 'American',
    gender: 'Female',
    language: 'en-us',
  },
  {
    id: 'af_river',
    name: 'River',
    accent: 'American',
    gender: 'Female',
    language: 'en-us',
  },
  {
    id: 'af_sarah',
    name: 'Sarah',
    accent: 'American',
    gender: 'Female',
    language: 'en-us',
  },
  {
    id: 'af_sky',
    name: 'Sky',
    accent: 'American',
    gender: 'Female',
    language: 'en-us',
  },
  {
    id: 'am_adam',
    name: 'Adam',
    accent: 'American',
    gender: 'Male',
    language: 'en-us',
  },
  {
    id: 'am_echo',
    name: 'Echo',
    accent: 'American',
    gender: 'Male',
    language: 'en-us',
  },
  {
    id: 'am_eric',
    name: 'Eric',
    accent: 'American',
    gender: 'Male',
    language: 'en-us',
  },
  {
    id: 'am_fenrir',
    name: 'Fenrir',
    accent: 'American',
    gender: 'Male',
    language: 'en-us',
  },
  {
    id: 'am_liam',
    name: 'Liam',
    accent: 'American',
    gender: 'Male',
    language: 'en-us',
  },
  {
    id: 'am_michael',
    name: 'Michael',
    accent: 'American',
    gender: 'Male',
    language: 'en-us',
  },
  {
    id: 'am_onyx',
    name: 'Onyx',
    accent: 'American',
    gender: 'Male',
    language: 'en-us',
  },
  {
    id: 'am_puck',
    name: 'Puck',
    accent: 'American',
    gender: 'Male',
    language: 'en-us',
  },
  {
    id: 'am_santa',
    name: 'Santa',
    accent: 'American',
    gender: 'Male',
    language: 'en-us',
  },
  {
    id: 'bf_alice',
    name: 'Alice',
    accent: 'British',
    gender: 'Female',
    language: 'en-gb',
  },
  {
    id: 'bf_emma',
    name: 'Emma',
    accent: 'British',
    gender: 'Female',
    language: 'en-gb',
  },
  {
    id: 'bf_isabella',
    name: 'Isabella',
    accent: 'British',
    gender: 'Female',
    language: 'en-gb',
  },
  {
    id: 'bf_lily',
    name: 'Lily',
    accent: 'British',
    gender: 'Female',
    language: 'en-gb',
  },
  {
    id: 'bm_daniel',
    name: 'Daniel',
    accent: 'British',
    gender: 'Male',
    language: 'en-gb',
  },
  {
    id: 'bm_fable',
    name: 'Fable',
    accent: 'British',
    gender: 'Male',
    language: 'en-gb',
  },
  {
    id: 'bm_george',
    name: 'George',
    accent: 'British',
    gender: 'Male',
    language: 'en-gb',
  },
  {
    id: 'bm_lewis',
    name: 'Lewis',
    accent: 'British',
    gender: 'Male',
    language: 'en-gb',
  },
] as const;

export const PERSONALITIES = [
  {
    id: 'natural',
    name: 'Natural',
    description: 'Warm and balanced',
    speed: 1,
    sentencePause: 0.25,
    clausePause: 0.1,
    instruction: 'Use a natural, thoughtful conversational style.',
    previewText:
      'Hello, I am your Dot. We can work through your ideas together, one step at a time.',
  },
  {
    id: 'cheerful',
    name: 'Cheerful',
    description: 'Upbeat, with a livelier pace',
    speed: 1.06,
    sentencePause: 0.18,
    clausePause: 0.08,
    instruction:
      'Use an upbeat, friendly tone with light enthusiasm. Keep it sincere and avoid excessive exclamation marks.',
    previewText:
      'Hello! I am your Dot. I am happy to help you explore your ideas and get things moving.',
  },
  {
    id: 'calm',
    name: 'Calm',
    description: 'Gentle, with more breathing room',
    speed: 0.94,
    sentencePause: 0.32,
    clausePause: 0.14,
    instruction:
      'Use a calm, reassuring tone and clear, unhurried phrasing. Avoid urgency unless the situation requires it.',
    previewText:
      'Hello, I am your Dot. Take your time. We can think things through together, one step at a time.',
  },
  {
    id: 'serious',
    name: 'Serious',
    description: 'Measured and direct',
    speed: 0.98,
    sentencePause: 0.28,
    clausePause: 0.12,
    instruction:
      'Use a measured, professional tone. Be direct and precise, with minimal banter.',
    previewText:
      'Hello. I am your Dot. Let us review the facts, identify the priorities, and decide what to do next.',
  },
] as const;
export const voiceQualitySchema = z.enum(['basic', 'medium', 'high']);
export type VoiceQuality = z.infer<typeof voiceQualitySchema>;
export const VOICE_QUALITIES = [
  {
    id: 'basic',
    name: 'Basic',
    description: 'Speak to Dot; receive text replies. Lowest local processing.',
  },
  {
    id: 'medium',
    name: 'Medium',
    description:
      'Speak to Dot; receive spoken replies. Current voice experience.',
  },
  {
    id: 'high',
    name: 'High',
    description:
      'Local speech with the full task agent. Requires more memory and processing.',
  },
] as const;
export function usesSpeechOutput(quality: VoiceQuality): boolean {
  return quality !== 'basic';
}
export const HIGH_VOICES = [
  { id: 'vivian', name: 'Vivian' },
  { id: 'serena', name: 'Serena' },
  { id: 'ryan', name: 'Ryan' },
  { id: 'aiden', name: 'Aiden' },
  { id: 'uncle_fu', name: 'Uncle Fu' },
  { id: 'ono_anna', name: 'Ono Anna' },
  { id: 'sohee', name: 'Sohee' },
  { id: 'dylan', name: 'Dylan' },
  { id: 'eric', name: 'Eric' },
] as const;
export const DEFAULT_HIGH_VOICE = 'vivian';
/** Updates keep omission intact until the storage worker merges the saved value. */
export const voiceSettingsUpdateSchema = z
  .object({
    voiceId: z.enum(VOICES.map((voice) => voice.id)),
    personality: z.enum(PERSONALITIES.map((personality) => personality.id)),
    quality: voiceQualitySchema.optional(),
    highVoiceId: z.enum(HIGH_VOICES.map((voice) => voice.id)).optional(),
  })
  .strict();
export const voiceSettingsSchema = voiceSettingsUpdateSchema.extend({
  quality: voiceQualitySchema.default('medium'),
});
export type VoiceSettings = z.infer<typeof voiceSettingsSchema>;
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  voiceId: 'af_heart',
  personality: 'natural',
  quality: 'medium',
};
export function personalityFor(settings: VoiceSettings) {
  return PERSONALITIES.find(
    (personality) => personality.id === settings.personality,
  )!;
}
export function personalityInstruction(settings: VoiceSettings): string {
  return `${personalityFor(settings).instruction} Personality affects communication style only; preserve accuracy, detail appropriate to the task, tool permissions, and approval requirements.`;
}
