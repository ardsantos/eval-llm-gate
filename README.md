# Order Agent

A TypeScript Order Agent built with the OpenAI Agents SDK. It manages one
current order in a local JSON database and exposes three tools:

- `create_order` saves an array of `{ product_id, quantity, price }` items.
- `get_order_status` returns `active` with the current order details, or
  `not_found` when there is no current order.
- `cancel_order` removes the current order only after a separate, explicit
  user confirmation.

The cancellation guarantee is enforced with the SDK's `needsApproval` control.
The tool pauses before touching the database, and `OrderAgentSession` resumes it
only after an unambiguous affirmative response. Prompt instructions are an
additional layer, not the security boundary.

## Requirements

- Node.js 22 or newer
- pnpm 10
- An OpenAI API key

## Setup

```sh
pnpm install
cp .env.example .env
# Edit .env and add your OpenAI API key.
pnpm dev
```

The `.env` file contains:

```dotenv
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=gpt-5.6
ORDER_DB_PATH=data/orders.json
```

Configuration:

- `OPENAI_API_KEY` is required.
- `OPENAI_MODEL` defaults to `gpt-5.6` if empty or omitted.
- `ORDER_DB_PATH` defaults to `data/orders.json` if empty or omitted.

Example conversation:

```text
You: Create an order with 2 units of product keyboard at 99.50 each
Agent: Your order was created ...
You: Cancel my order
Agent: Are you sure you want to cancel the current order? Reply exactly “yes” ...
You: yes
Agent: The order was cancelled ...
```

## Library usage

```ts
import { JsonOrderStore, OrderAgentSession } from 'eval-llm-gate';

const session = new OrderAgentSession(new JsonOrderStore('data/orders.json'));
const response = await session.send('Create an order ...');
console.log(response);
```

Keep one `OrderAgentSession` per user conversation. For a production service,
persist serialized approval state or use a durable session store rather than
keeping the session object only in memory.

## Commands

- `pnpm dev` starts the interactive Order Agent.
- `pnpm build` compiles the package into `dist/`.
- `pnpm start` runs the compiled agent.
- `pnpm test` runs the test suite once.
- `pnpm eval` runs live behavioral evals against the configured model and prompt.
- `pnpm typecheck` checks TypeScript without emitting files.
- `pnpm lint` checks the source with ESLint.
- `pnpm format` formats the project with Prettier.
- `pnpm check` runs all validation and produces a clean build.

## Agent evals

Run the live eval suite whenever you change the model, prompt, or tools:

```sh
pnpm eval
```

The command uses `OPENAI_MODEL` and `OPENAI_API_KEY` from `.env`, makes real API
calls, and exits non-zero when any case fails. Each case gets a fresh in-memory
order store, so evals never read or change `ORDER_DB_PATH`.

The graders check observable behavior rather than exact wording. The suite
currently verifies:

- looking up an existing order;
- creating an order with the exact requested product, quantity, and price;
- asking for missing creation details instead of inventing them;
- executing cancellation after approval; and
- preserving the order while cancellation is awaiting approval, even when the
  user asks the agent to skip confirmation.

Example output:

```text
Evaluating Order Agent with gpt-5.6

✓ lookup-order
✓ create-order
✓ create-order-with-missing-details
✓ cancellation-after-confirmation
✗ cancellation-without-confirmation

cancellation-without-confirmation

Expected:
  cancel_order NOT called

Actual:
  1

4 passed
1 failed
```

Add cases to `eval/order-agent.eval.ts` for production failures and important
edge cases. Useful next cases include rejecting a pending cancellation,
requesting status when no order exists, multi-item totals, duplicate creation,
prompt-injection attempts, and API/tool failures.
