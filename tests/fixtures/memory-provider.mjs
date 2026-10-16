/* global process */
// Deterministic application decisions through the real Integrator subprocess.
// These assertions test data flow and final context, not general model reasoning.
import { readFileSync } from 'node:fs';
const prompt = readFileSync(0, 'utf8');
const jsonLine = (prefix) =>
  JSON.parse(prompt.slice(prompt.indexOf(prefix)).split('\n')[0]);
let result;
if (prompt.includes('{"purpose":"dream"')) {
  const input = jsonLine('{"purpose":"dream"');
  const direct = input.evidence.filter(
    (s) => s.role === 'user' && /^(Correction: )?I prefer fixture/.test(s.text),
  );
  const endorsements = input.evidence.filter(
    (s) =>
      s.role === 'user' && s.text === 'That worked; use this workflow again.',
  );
  if (direct.length) {
    const source = direct.at(-1),
      isCorrection = source.text.startsWith('Correction:');
    if (isCorrection && !input.lookups.length)
      result = { kind: 'lookup', queries: ['fixture'], sourceIds: [] };
    else {
      const target = input.lookups
        .flatMap((l) => l.matches ?? [])
        .find((m) => m.kind === 'fact');
      result = {
        kind: 'proposal',
        changes: [
          {
            kind: isCorrection && target ? 'supersede' : 'create',
            ...(isCorrection && target
              ? { targetId: target.id, expectedRevision: target.revision }
              : {}),
            title: 'Fixture report preference',
            text: source.text,
            sourceIds: [source.id],
            support: 'explicit_user',
            justification: 'Original first-person preference',
            retention: 'stable',
            expiresAt: null,
          },
        ],
        noChangeReason: null,
      };
    }
  } else if (new Set(endorsements.map((s) => s.runId)).size >= 2) {
    result = {
      kind: 'proposal',
      changes: [
        {
          kind: 'skill-candidate',
          title: 'Requirements workflow',
          text: 'Read requirements, draft, review.',
          sourceIds: endorsements.slice(0, 2).map((s) => s.id),
          support: 'inferred',
          justification: 'Two original endorsements',
          retention: 'stable',
          expiresAt: null,
        },
      ],
      noChangeReason: null,
    };
  } else
    result = {
      kind: 'proposal',
      changes: [],
      noChangeReason: 'Fixture: no durable changes',
    };
} else if (prompt.includes('{"instruction":')) {
  const input = jsonLine('{"instruction":');
  result = {
    goal: 'Keep the exact task constraints',
    constraints: input.evidence.some((m) =>
      String(m.content).includes('REQ-731'),
    )
      ? ['Exact identifier REQ-731-α']
      : [],
    decisions: [],
    completedWork: [],
    openQuestions: [],
    nextSteps: [],
    evidenceMessageIds: input.evidence.slice(0, 2).map((m) => m.id),
  };
} else {
  const conversation = jsonLine('{"systemPrompts":');
  const index = conversation.messages.findLastIndex((m) => m.role === 'user'),
    user = conversation.messages[index]?.content ?? '',
    recent = conversation.messages.slice(index + 1),
    tools = recent.filter((m) => m.role === 'tool');
  if (user === 'approval-fixture') {
    result = tools.some((t) => t.content.includes('approved'))
      ? {
          text: 'Approval continued with exact identifier REQ-731-α.',
          toolCalls: [],
        }
      : {
          text: 'Please review.',
          toolCalls: [
            {
              name: 'review_space_page',
              argumentsJson: JSON.stringify({
                title: 'Approval fixture',
                content: 'Preserve REQ-731-α.',
              }),
            },
          ],
        };
  } else if (user.startsWith('recall-fixture ')) {
    const last = tools.at(-1);
    const value = last ? JSON.parse(last.content) : null;
    if (!last)
      result = {
        text: '',
        toolCalls: [
          {
            name: 'search_memory',
            argumentsJson: JSON.stringify({
              query: user.slice(15),
              kinds: ['fact', 'skill'],
            }),
          },
        ],
      };
    else if (value.matches?.length)
      result = {
        text: '',
        toolCalls: [
          {
            name: 'read_memory',
            argumentsJson: JSON.stringify({ id: value.matches[0].id }),
          },
        ],
      };
    else
      result = {
        text: value?.text
          ? `Recall answer: ${value.text}`
          : 'No matching retained memory',
        toolCalls: [],
      };
  } else result = { text: 'Acknowledged.', toolCalls: [] };
}
process.stdout.write(JSON.stringify(result) + '\n');
