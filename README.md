# Gate

Gate is a TypeScript monorepo for developing and evaluating an OpenAI-powered
order agent. It includes a browser playground, a structured behavioral eval
runner, a local API, and the original interactive command-line agent.

## Workspace

```text
apps/
  api/          Local HTTP API for sessions, traces, and eval runs
  web/          Dashboard with Playground and Evaluations views
packages/
  agent/        Order agent, approval flow, and order stores
  contracts/    Shared API and UI types
  evals/        Reusable behavioral evaluation runner
```

The browser never receives the OpenAI API key. Agent conversations and evals
run through `apps/api`, while the frontend consumes typed JSON responses.
At startup, the API loads the models available to that key from OpenAI's
`GET /v1/models` endpoint and exposes them to both dashboard model selectors.

## Requirements

- Node.js 22 or newer
- pnpm 10
- An OpenAI API key

## Setup

```sh
pnpm install
cp .env.example .env
# Add your OpenAI API key to .env
pnpm dev
```

The dashboard opens at `http://localhost:3000` and the API listens at
`http://localhost:8787`.

Configuration:

```dotenv
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=gpt-5.6
ORDER_DB_PATH=data/orders.json
PORT=8787
WEB_ORIGIN=http://localhost:3000
```

## Dashboard

The **Playground** keeps a server-side agent session, supports the destructive
tool approval flow, and shows timing, tool input, and tool output for the latest
turn.

The **Evaluations** view starts a background evaluation run, polls its progress,
and shows pass/fail status, duration, expected behavior, actual output, and a
trace for every case. Run records currently live for the lifetime of the API
process; durable database-backed history is the next production step.

## Commands

- `pnpm dev` starts the dashboard and API together.
- `pnpm dev:agent` starts the interactive terminal agent.
- `pnpm eval` runs the behavioral suite directly.
- `pnpm test` runs workspace tests.
- `pnpm typecheck` checks every package.
- `pnpm build` builds every deployable/package workspace.
- `pnpm check` runs the complete validation pipeline.

## Safety model

Cancellation remains protected by the Agents SDK `needsApproval` control. The
agent run pauses before `cancel_order` touches storage and resumes only after a
separate, explicit affirmative message. The dashboard uses the same
`OrderAgentSession` implementation as the CLI.
