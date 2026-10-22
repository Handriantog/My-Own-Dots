import { z } from 'zod';

/** Website navigation only; never hand file or application protocols to the OS. */
export const websiteUrl = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => {
    if (/[\s\p{Cc}\p{Cf}\\]/u.test(value)) return false;
    try {
      const url = new URL(value);
      return (
        /^https?:\/\//i.test(value) &&
        ['http:', 'https:'].includes(url.protocol) &&
        !!url.hostname &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, 'Use an HTTP or HTTPS website URL without credentials.')
  .transform((value) => new URL(value).href);

export const browserRequest = z
  .object({
    type: z.literal('dots:open-website'),
    id: z.string().regex(/^[a-f0-9]{64}$/),
    url: websiteUrl,
    expiresAt: z.number().int().positive(),
  })
  .strict();
export const browserResult = z
  .object({
    url: websiteUrl,
    status: z.enum(['opened', 'failed', 'unknown']),
    error: z.string().max(300).optional(),
  })
  .strict();
export const browserReply = z
  .object({
    type: z.literal('dots:website-result'),
    id: z.string().regex(/^[a-f0-9]{64}$/),
    result: browserResult,
  })
  .strict();
export type BrowserRequest = z.infer<typeof browserRequest>;
export type BrowserResult = z.infer<typeof browserResult>;
export type BrowserReply = z.infer<typeof browserReply>;
export type OpenWebsite = (
  url: string,
  id: string,
  signal: AbortSignal,
) => Promise<BrowserResult>;
