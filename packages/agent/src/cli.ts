import { createInterface } from 'node:readline/promises';
import { loadEnvFile, stdin, stdout } from 'node:process';
import { resolve } from 'node:path';

import { OrderAgentSession } from './order-agent.js';
import { JsonOrderStore } from './order-store.js';

loadEnvFile(resolve(process.cwd(), '../../.env'));

if (!process.env.OPENAI_API_KEY) {
  throw new Error(
    'Set OPENAI_API_KEY in .env before starting the Order Agent.',
  );
}

const terminal = createInterface({ input: stdin, output: stdout });
const session = new OrderAgentSession(
  new JsonOrderStore(
    resolve(
      process.cwd(),
      '../..',
      process.env.ORDER_DB_PATH || 'data/orders.json',
    ),
  ),
  process.env.OPENAI_MODEL || 'gpt-5.6',
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
}
