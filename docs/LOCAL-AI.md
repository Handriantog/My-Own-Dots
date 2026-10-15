# Your subscriptions and local conversations

My Own Dots is a fork of OpenDots for MyOwnStack. It keeps the workspace, specialist Dots, saved pages, tools, approvals and scheduled work. Its default backend uses the published `myown-llm-integrator@0.1.0` npm package and PostgreSQL on your machine. No CopilotKit account or model API key is required for this configuration.

## Start locally

Install Node.js 24+, Docker with Compose, [uv](https://docs.astral.sh/uv/getting-started/installation/), and an AI CLI supported by [MyOwnLlmIntegrator](https://github.com/Handriantog/My-Own-LLM-Integrator). Log in to that CLI using the subscription account you want to use. Codex is the default; the integrator requires its ChatGPT login rather than API-key authentication.

```sh
npm ci
npm run setup:local
npm run conversations:up
npm run setup:llm
npm run llm:check
npm run dev
```

Open http://127.0.0.1:5173. For the built app, run `npm run build && npm start` and open http://127.0.0.1:4310.

`setup:local` creates `.env` with a random database password and preserves existing nonempty settings. `llm:check` validates provider configuration and executable availability; it does not make an inference request or prove login, quota or model access. Your first conversation verifies the account connection. The npm dependency includes the engine; the sibling integrator checkout is needed only when developing that package.

Docker runs PostgreSQL only, on loopback port 5434. The web app, runtime, Python engine and logged-in AI CLI run on the host, as Researcher's application and CLI do. CLI credentials stay in the normal host profile; do not mount your entire home directory into a container. `compose.yml` remains the optional legacy app-container deployment with explicit hosted backends. `compose.local.yml` is the default local backend.

## Provider configuration

```dotenv
CONVERSATION_BACKEND=local
LLM_BACKEND=subscription
LLM_PROVIDER=codex
# Optional; unset inherits CODEX_MODEL/AGENT_MODEL or the CLI's default.
LLM_MODEL=
AGENT_RUN_TIMEOUT_MS=900000
```

Change `LLM_PROVIDER` to an integrator provider ID, such as `claude-code`, `gemini`, or `cursor`, after installing and authenticating that provider's CLI. Restart the app after configuration changes. The package's provider guide documents provider-specific limits. Model IDs and access belong to the selected account. Other CLIs retain their configured authentication/billing behavior; selecting a provider does not itself establish subscription billing.

`CODEX_BIN`, `AGENT_BIN`, `CODEX_MODEL`, `AGENT_MODEL` and `MYOWN_LLM_PYTHON` are optional trusted server settings supported by the package. Browser requests cannot override them. `AGENT_RUN_TIMEOUT_MS` bounds an entire turn, including queueing and tool steps; the package also has separate execution/queue deadlines documented in its README.

The integrator returns one structured result per model step. Text appears after that step finishes; token-by-token provider streaming is unavailable. Tool decisions are returned to the app, which validates and executes its existing permitted tools. Approval cards still pause for the owner. Pausing work, revoking permissions or stopping a turn cancels inference. Provider CLI restrictions are not an OS sandbox: inspect the integrator's provider guide, especially before using shared deployments or untrusted prompts.

## What is stored where

| Data                                                                  | Storage                                                         |
| --------------------------------------------------------------------- | --------------------------------------------------------------- |
| Conversation messages, tool calls/results, run events and state       | PostgreSQL Docker volume `my-own-dots-local_conversations-data` |
| Pages, Dots, Spaces, settings, memories, approvals and scheduled work | `DATABASE_PATH`, default `data/opendots.sqlite`                 |
| Provider authentication                                               | Selected CLI's host profile                                     |

Keep `OWNER_ID` stable. Back up both PostgreSQL and SQLite; neither backup alone contains the complete workspace. Stop app writes when taking a consistent backup. `npm run conversations:down` stops the service and preserves its volume. Start it again with `npm run conversations:up`. Never use `down -v` unless you intend to delete saved conversation data.

One application server per local workspace is supported. Per-thread database locks reject overlapping turns, and saved events allow reconnect after app restarts. Interrupted turns are not silently re-executed; inspect any completed actions before asking the Dot to retry. Turning a provider failure into a successful answer or falling back to hosted storage is not supported.

## Optional services

- **Managed Slack and Automatic Learning:** unavailable in local mode. The app's explicit memories and MCP connections continue to work. Use an explicit Intelligence backend only if you want those managed features.
- **Voice:** the current realtime speech adapter still requires `VOICE_API_KEY` and `VOICE_MODEL`; a text subscription does not supply realtime speech. Voice is disabled until configured.
- **Web research:** disabled by default. Select `WEB_SEARCH_PROVIDER=browser` with the local browser worker for URL reading, or explicitly select `parallel` to use that third-party search service. See [setup](SETUP.md#browser-tool).
- **Connected apps:** Composio remains optional and disabled until configured and permitted. Direct MCP connections offer a separate integration path.
- **Dot computers:** remain optional isolated OpenBot containers. See [computers](COMPUTERS.md).
- **Telemetry:** local mode opts out by default (`DO_NOT_TRACK=1`). Model requests still go to your selected provider; local conversation storage does not make remote inference offline.

## Existing installations

Run `npm ci`, `npm run setup:local`, and `npm run setup:llm`. Select `CONVERSATION_BACKEND=local` and `LLM_BACKEND=subscription`, then start PostgreSQL and restart the app. Existing SQLite pages and settings remain. Existing hosted conversation history is not automatically migrated; old thread bindings cannot recover cloud messages from the new empty local database. Create a new conversation, or keep the old backend while exporting history. Existing page-bound chats start with empty local history when first used in local mode; the cloud copy remains in the old backend.

To retain the original deployment deliberately:

```dotenv
CONVERSATION_BACKEND=intelligence
LLM_BACKEND=openai
# Configure Intelligence project/API/gateway and OPENAI_API_KEY/OPENAI_MODEL.
```

The backends are independent: subscription inference can also be used with Intelligence storage. Old API keys never select hosted mode automatically. CopilotKit's [official local Docker evaluation](https://docs.copilotkit.ai/intelligence/self-hosting-local) still requires an account and renewable license; [production self-hosting](https://docs.copilotkit.ai/intelligence/self-hosting) is licensed. The default local backend is an independent conversation replacement, not a copy of that proprietary service or its dashboard.

## Troubleshooting

Use `npm run conversations:logs` for database startup errors. Ensure `LOCAL_DATABASE_URL` matches the Compose password and port; changing the password in `.env` does not reset credentials in an existing PostgreSQL volume. Preserve or deliberately rotate the existing database password instead of deleting the volume.

For missing CLI/Python errors, run `npm run setup:llm` and `npm run llm:check` in the same shell that starts the app. Ensure the provider CLI is on that shell's `PATH`, or set its explicit executable path. Log in to the CLI directly if authentication has expired. Provider failures appear in chat without fabricated replies.

Automated tests use fake inference; they do not consume your subscription allowance. CI provisions PostgreSQL and the package's Python engine to exercise persistence, restart recovery, tools and approval continuation through the real npm/Python subprocess and SSE runtime. To run those tests locally, complete `npm run setup:llm`, then run `npm test` with `LOCAL_TEST_DATABASE_URL` pointing to a dedicated test database. Do not use a production database for tests.
