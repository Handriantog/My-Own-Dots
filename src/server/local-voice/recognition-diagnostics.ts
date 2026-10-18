/** Internal, content-free recognition metadata; never includes decoder text. */
export const recognitionReasons = [
  'invalid_timestamp',
  'invalid_segment_text',
  'segment_limit',
  'text_limit',
  'unknown',
] as const;
export type RecognitionReason = (typeof recognitionReasons)[number];
