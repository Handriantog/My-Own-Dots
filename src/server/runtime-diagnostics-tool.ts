import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import type { AbilityService } from './abilities/service.js';

export const runtimeDiagnosticInstructions =
  'When the owner reports a failed Ability or asks you to debug Dot, first call inspect_dot_runtime and the relevant available status tool. Distinguish a tool call returning from its intended effect being active. Report observed state and error codes; do not claim success from a plan or earlier conversation. Source-code access is not needed for these runtime checks. Request a source folder only if runtime evidence is insufficient and the owner wants code inspection; never assume an old grant, the workspace data folder, or a parent project is the installed application source. If no exact source folder was supplied, leave folderHint empty so the owner can choose. Read/edit folder grants do not authorize commands. The Codex execution engine can run tests only in a project with explicit execute access; other engines require a configured execution tool. Explain a missing diagnostic capability precisely instead of saying the LLM cannot debug.';

export function runtimeDiagnosticsTool(
  abilities: AbilityService | undefined,
  dotId: string,
  threadId: string,
  capabilities: {
    isolatedComputerConfigured: boolean;
    localFolderToolsAvailable: boolean;
    maxIterations: number | null;
    agentEngine?: 'legacy' | 'codex';
    turnTimeLimitMs: number;
    channel: 'text' | 'voice';
    interactive: boolean;
  },
  check: () => void | Promise<void>,
  signal: AbortSignal,
) {
  return defineTool({
    name: 'inspect_dot_runtime',
    description:
      'Read this Dot’s execution capabilities, Ability host connectivity, enabled installations and recent execution status in this conversation. Use this before asking for source files when an Ability fails. Does not execute, restart or change anything; excludes private tool results and credentials. Historical receipts are not current activity status.',
    parameters: z.object({}).strict(),
    execute: async () => {
      signal.throwIfAborted();
      await check();
      const report = abilities
        ? await abilities.diagnose(
            dotId,
            threadId,
            capabilities.channel,
            capabilities.interactive,
          )
        : null;
      await check();
      signal.throwIfAborted();
      const build = process.env.DOTS_RUNTIME_ROOT
        ? await readFile(
            join(process.env.DOTS_RUNTIME_ROOT, 'build-identity.json'),
            'utf8',
          )
            .then((value) => JSON.parse(value))
            .catch(() => ({ identified: false }))
        : { identified: false, mode: 'development' };
      return {
        build,
        capabilities: {
          ...capabilities,
          hostShellAvailable: false,
          projectCommands:
            capabilities.agentEngine === 'codex'
              ? 'requires_explicit_execute_grant'
              : 'unavailable',
        },
        abilities: report,
      };
    },
  });
}
