// Offline fixture: real integrator subprocess protocol, no account or network.
import { stdin, stdout } from 'node:process';
// Integrator writes a nonblocking pipe; long tool histories can arrive in chunks.
stdin.setEncoding('utf8');
let prompt = '';
for await (const chunk of stdin) prompt += chunk;
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
if (request.includes('voice-tools-fixture')) {
  const outputs = tools.map((tool) => {
    try {
      return JSON.parse(tool.content);
    } catch {
      return null;
    }
  });
  const read = outputs.find(
    (value) =>
      value?.path === 'notes.txt' && typeof value?.content === 'string',
  );
  const decision = outputs.find((value) => value?.approved === true);
  const access = outputs.find((value) => value?.status === 'approval_required');
  const grants = outputs.find(Array.isArray);
  const grantId = decision?.grantId ?? grants?.[0]?.id;
  const call = (name, args) => ({
    text: '',
    toolCalls: [{ name, argumentsJson: JSON.stringify(args) }],
  });
  if (read) {
    const parentContext = conversation.systemPrompts.join(' ');
    const hasContext =
      parentContext.includes('Read notes.txt in the Test Notes folder.') &&
      parentContext.includes('Your notes say:');
    result = {
      text: `${request.includes('again') ? (hasContext ? 'Prior folder context received. ' : 'Parent folder context missing. ') : ''}Your notes say: ${read.content}`,
      toolCalls: [],
    };
  } else if (grantId) {
    result = call('read_local_file', { grantId, path: 'notes.txt' });
  } else if (access) {
    throw new Error(
      'Folder approval must pause locally without another provider decision.',
    );
  } else if (grants) {
    result = call('request_local_folder_access', {
      reason: 'Read the fixture notes requested by the owner',
      folderHint: 'Test Notes',
      access: 'read',
    });
  } else {
    result = call('list_local_folders', {});
  }
} else if (
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
} else if (request.includes('voice-context-fixture')) {
  result = {
    text: conversation.systemPrompts.join(' ').includes('amber fox')
      ? 'Context received: amber fox.'
      : 'Parent context missing.',
    toolCalls: [],
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
