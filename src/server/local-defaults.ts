// Must be the first server import: the SDK captures this flag at module load.
if ((process.env.CONVERSATION_BACKEND?.trim() || 'local') === 'local') {
  process.env.DO_NOT_TRACK ??= '1';
}
