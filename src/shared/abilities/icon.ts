import { z } from 'zod';

const arities: Record<string, number> = {
  m: 2,
  l: 2,
  h: 1,
  v: 1,
  c: 6,
  s: 4,
  q: 4,
  t: 2,
  a: 7,
};
/** Parse SVG path grammar without accepting markup, attributes or external resources. */
function validPath(path: string): boolean {
  const token =
    /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/gy;
  const tokens: (string | number)[] = [];
  const spellings: string[] = [];
  let offset = 0;
  while (offset < path.length) {
    const separator = /^[\t\n\r ,]*/.exec(path.slice(offset))![0];
    if (
      separator.includes(',') &&
      (separator.indexOf(',') !== separator.lastIndexOf(',') ||
        typeof tokens.at(-1) !== 'number')
    )
      return false;
    offset += separator.length;
    if (offset === path.length)
      return !separator.includes(',') && validTokens(tokens, spellings);
    token.lastIndex = offset;
    const match = token.exec(path);
    if (!match) return false;
    const value = match[0];
    spellings.push(value);
    if (separator.includes(',') && /^[a-z]$/i.test(value)) return false;
    if (/^[a-z]$/i.test(value)) tokens.push(value.toLowerCase());
    else {
      const number = Number(value);
      if (!Number.isFinite(number)) return false;
      tokens.push(number);
    }
    offset = token.lastIndex;
  }
  return validTokens(tokens, spellings);
}
function validTokens(
  tokens: (string | number)[],
  spellings: string[],
): boolean {
  if (tokens[0] !== 'm') return false;
  let index = 0;
  while (index < tokens.length) {
    const command = tokens[index++];
    if (typeof command !== 'string') return false;
    if (command === 'z') continue;
    const arity = arities[command];
    const start = index;
    while (typeof tokens[index] === 'number') index++;
    if (index === start || (index - start) % arity !== 0) return false;
    if (command === 'a') {
      for (let i = start; i < index; i += arity) {
        if (
          (tokens[i] as number) < 0 ||
          (tokens[i + 1] as number) < 0 ||
          !/^[01]$/.test(spellings[i + 3]) ||
          !/^[01]$/.test(spellings[i + 4])
        )
          return false;
      }
    }
  }
  return true;
}
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const abilityIconSchema = z.strictObject({
  background: hexColor,
  foreground: hexColor,
  paths: z
    .array(
      z
        .string()
        .min(1)
        .max(2048)
        .regex(/^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\t\n\r -]+$/)
        .refine(validPath, 'Invalid SVG path geometry'),
    )
    .min(1)
    .max(12),
});
export type AbilityIcon = z.infer<typeof abilityIconSchema>;
