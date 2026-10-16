export type MemoryCommand =
  | { kind: 'compact' | 'dream' | 'dream-log' }
  | { kind: 'dream-restore'; id: string };
export function parseMemoryCommand(text: string): MemoryCommand | null {
  const command = text.trim();
  if (command === '/compact') return { kind: 'compact' };
  if (command === '/dream') return { kind: 'dream' };
  if (command === '/dream-log') return { kind: 'dream-log' };
  const match = /^\/dream-restore ([A-Za-z0-9_.:-]{1,200})$/.exec(command);
  return match ? { kind: 'dream-restore', id: match[1] } : null;
}
