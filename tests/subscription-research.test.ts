import { afterEach, expect, it, vi } from 'vitest';
import { research } from '../src/server/research.js';
const engine = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock('myown-llm-integrator', () => engine);
afterEach(() => vi.restoreAllMocks());
it('writes a research brief using the subscription and supplied browser evidence', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      title: 'Source',
      url: 'https://example.com',
      text: 'Verified source text',
    }),
  );
  engine.runAgent.mockResolvedValue({
    result: { text: 'A grounded subscription brief.' },
    usage: {},
  });
  const result = await research(
    'Read https://example.com',
    [],
    {
      mode: 'live',
      llmBackend: 'subscription',
      llmProvider: 'codex',
      baseUrl: '',
      webSearchProvider: 'browser',
      browserUrl: 'http://localhost:4311',
      browserSecret: 'fixture',
    },
    new AbortController().signal,
    () => {},
  );
  expect(result.text).toBe('A grounded subscription brief.');
  expect(result.sources[0].url).toBe('https://example.com');
  expect(network).toHaveBeenCalledTimes(1);
  expect(engine.runAgent.mock.calls[0][0].prompt).toContain(
    'Verified source text',
  );
});
