// Offline fixture: real integrator subprocess protocol, no account or network.
import { readFileSync } from 'node:fs';
import { stdout } from 'node:process';
const prompt = readFileSync(0, 'utf8');
const start = prompt.indexOf('{"systemPrompts":');
if (start < 0) throw new Error('Missing application conversation');
// The engine appends the output schema after the application prompt.
const conversation = JSON.parse(prompt.slice(start).split('\n')[0]);
const lastUser = conversation.messages
  .filter((message) => message.role === 'user')
  .at(-1);
const request =
  typeof lastUser?.content === 'string'
    ? lastUser.content
    : JSON.stringify(lastUser?.content);
const tools = conversation.messages.filter(
  (message) => message.role === 'tool',
);
let result;
if (
  request.includes('review-fixture') &&
  !tools.some((tool) => tool.content.includes('approved'))
) {
  result = {
    text: 'Review this draft.',
    toolCalls: [
      {
        name: 'review_space_page',
        argumentsJson: JSON.stringify({
          title: 'Reviewed fixture',
          content: 'A draft for approval.',
          spaceId: conversation.systemPrompts
            .join(' ')
            .match(/Default page destination: ([a-zA-Z0-9-]+)\./)?.[1],
        }),
      },
    ],
  };
} else if (request.includes('save-fixture') && !tools.length) {
  result = {
    text: '',
    toolCalls: [
      {
        name: 'create_space_page',
        argumentsJson: JSON.stringify({
          title: 'Offline fixture note',
          content: 'Saved through the real subscription engine.',
        }),
      },
    ],
  };
} else {
  result = {
    text: `Offline provider completed with ${conversation.messages.length} context messages. Saved note context: ${JSON.stringify(conversation.messages).includes('Offline fixture note') ? 'present' : 'absent'}.`,
    toolCalls: [],
  };
}
stdout.write(JSON.stringify(result) + '\n');
