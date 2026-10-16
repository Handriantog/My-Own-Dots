import { expect, it } from 'vitest';
import type { Message } from '@ag-ui/core';
import { ContextBuilder } from '../src/server/context-builder.js';
import { renderSubscriptionPrompt } from '../src/server/subscription-prompt.js';
import { DreamPublication } from '../src/server/dream-publication.js';
import { publicationFixture } from './fixtures/memory.js';
it('withholds forgotten source spans from recall and model history while preserving tool identities', async () => {
  const f = await publicationFixture();
  try {
    const { record, message } = f.add(
      'private exact value',
      'tool-run',
      'tool',
      'call',
    );
    const item = f.workspace.memory.create({
      scope: { kind: 'dot', id: f.dot.id },
      title: 'Private',
      text: record.text,
      sources: [record.source],
    });
    const publication = new DreamPublication(f.recall);
    publication.forget(item.id, 1);
    await expect(f.recall.read(f.dot.id, item.id)).rejects.toThrow(/access/);
    await expect(f.recall.readSource(f.dot.id, record.id)).rejects.toThrow(
      /access/,
    );
    const canonical: Message[] = [
      {
        id: 'assistant',
        role: 'assistant',
        toolCalls: [
          {
            id: 'call',
            type: 'function',
            function: { name: 'read_space_page', arguments: '{}' },
          },
        ],
      },
      message as Message,
    ];
    const masked = f.workspace.memory.maskMessages('thread', canonical);
    expect(masked[1]).toMatchObject({
      id: message.id,
      role: 'tool',
      toolCallId: 'call',
      content: '[Memory content withheld]',
    });
    expect(canonical[1].content).toBe('private exact value');
    const builder = new ContextBuilder(f.recall);
    const projected = await builder.project(
      {
        systemPrompts: [],
        messages: [
          {
            id: message.id,
            role: 'tool',
            toolCallId: 'call',
            content: record.text,
          },
        ],
        availableTools: [],
      },
      {
        ownerId: 'owner',
        dotId: f.dot.id,
        threadId: 'thread',
        runId: 'next',
        canonicalMessages: canonical,
      },
      new AbortController().signal,
    );
    expect(renderSubscriptionPrompt(projected)).not.toContain(
      'private exact value',
    );

    expect(f.workspace.memory.sourceSuppressed(record.source)).toBe(true);
    expect(f.workspace.memory.suppressionGeneration()).toBeGreaterThan(0);
  } finally {
    f.close();
  }
});
