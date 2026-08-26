import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { loadEnvFile, stdin, stdout } from 'node:process';
import { resolve } from 'node:path';

import { GateDatabase } from './database.js';
import { OrderAgentSession } from './order-agent.js';
import type { Order } from './order-store.js';

loadEnvFile(resolve(process.cwd(), '../../.env'));

if (!process.env.OPENAI_API_KEY) {
  throw new Error(
    'Set OPENAI_API_KEY in .env before starting the Order Agent.',
  );
}

const terminal = createInterface({ input: stdin, output: stdout });
const model = process.env.OPENAI_MODEL || 'gpt-5.6';
const database = new GateDatabase(
  resolve(
    process.cwd(),
    '../..',
    process.env.GATE_DB_PATH || 'data/gate.sqlite',
  ),
);
const sessionId = 'cli';
database.ensureSession(sessionId, model);
await importLegacyOrder();
const session = new OrderAgentSession(
  database.createOrderStore(sessionId),
  model,
  database.createAgentSession(sessionId),
);

console.log('Order Agent ready. Type "exit" to quit.');

try {
  while (true) {
    const message = await terminal.question('You: ');
    if (['exit', 'quit'].includes(message.trim().toLowerCase())) break;

    const response = await session.send(message);
    console.log(`Agent: ${response.message}`);
  }
} finally {
  terminal.close();
  database.close();
}

async function importLegacyOrder(): Promise<void> {
  const legacyPath = resolve(
    process.cwd(),
    '../..',
    process.env.ORDER_DB_PATH || 'data/orders.json',
  );
  try {
    const legacy = JSON.parse(await readFile(legacyPath, 'utf8')) as {
      current_order?: Order | null;
    };
    if (legacy.current_order)
      database.importCurrentOrder(sessionId, model, legacy.current_order);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    console.warn(
      `Could not import legacy order file ${legacyPath}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
