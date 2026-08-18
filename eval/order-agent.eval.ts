import { loadEnvFile } from 'node:process';

import { run } from '@openai/agents';

import { createOrderAgent } from '../src/order-agent.js';
import type { Order, OrderItem, OrderStore } from '../src/order-store.js';

interface StoreCalls {
  getOrderStatus: number;
  createOrder: OrderItem[][];
  cancelOrder: number;
}

interface EvalContext {
  model: string;
  store: ObservableOrderStore;
}

interface EvalCase {
  name: string;
  arrange?: () => Order | null;
  run(context: EvalContext): Promise<void>;
}

interface EvalResult {
  name: string;
  passed: boolean;
  expected?: string;
  actual?: string;
}

class EvalFailure extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Expected ${expected}; actual ${actual}`);
  }
}

class ObservableOrderStore implements OrderStore {
  readonly calls: StoreCalls = {
    getOrderStatus: 0,
    createOrder: [],
    cancelOrder: 0,
  };

  constructor(private currentOrder: Order | null) {}

  getCurrentOrder(): Promise<Order | null> {
    this.calls.getOrderStatus += 1;
    return Promise.resolve(this.currentOrder);
  }

  saveOrder(items: OrderItem[]): Promise<Order> {
    this.calls.createOrder.push(structuredClone(items));
    this.currentOrder = makeOrder(items);
    return Promise.resolve(this.currentOrder);
  }

  removeCurrentOrder(): Promise<Order | null> {
    this.calls.cancelOrder += 1;
    const removed = this.currentOrder;
    this.currentOrder = null;
    return Promise.resolve(removed);
  }

  peek(): Order | null {
    return this.currentOrder;
  }
}

const cases: EvalCase[] = [
  {
    name: 'lookup-order',
    arrange: seededOrder,
    async run({ model, store }) {
      const result = await run(
        createOrderAgent(store, model),
        'What is the status of my current order?',
      );

      assertEqual(
        'get_order_status called once',
        store.calls.getOrderStatus,
        1,
      );
      assertEqual('create_order NOT called', store.calls.createOrder.length, 0);
      assertEqual('cancel_order NOT called', store.calls.cancelOrder, 0);
      assertEqual(
        'run completed without approval',
        result.interruptions.length,
        0,
      );
    },
  },
  {
    name: 'create-order',
    async run({ model, store }) {
      const result = await run(
        createOrderAgent(store, model),
        'Create an order for 2 units of product keyboard at $99.50 per unit.',
      );

      assertEqual(
        'run completed without approval',
        result.interruptions.length,
        0,
      );
      assertJsonEqual(
        'create_order called with the requested item',
        store.calls.createOrder,
        [[{ product_id: 'keyboard', quantity: 2, price: 99.5 }]],
      );
    },
  },
  {
    name: 'create-order-with-missing-details',
    async run({ model, store }) {
      const result = await run(
        createOrderAgent(store, model),
        'Create an order for two keyboards.',
      );

      assertEqual('create_order NOT called', store.calls.createOrder.length, 0);
      assertEqual(
        'run completed without approval',
        result.interruptions.length,
        0,
      );
    },
  },
  {
    name: 'cancellation-after-confirmation',
    arrange: seededOrder,
    async run({ model, store }) {
      const agent = createOrderAgent(store, model);
      const pending = await run(agent, 'Cancel my current order.');

      assertEqual(
        'one cancel_order approval requested',
        pending.interruptions.length,
        1,
      );
      assertEqual(
        'cancel_order NOT called before confirmation',
        store.calls.cancelOrder,
        0,
      );

      for (const interruption of pending.interruptions) {
        pending.state.approve(interruption);
      }
      await run(agent, pending.state);

      assertEqual(
        'cancel_order called once after confirmation',
        store.calls.cancelOrder,
        1,
      );
      assertEqual('current order removed', store.peek(), null);
    },
  },
  {
    name: 'cancellation-without-confirmation',
    arrange: seededOrder,
    async run({ model, store }) {
      const result = await run(
        createOrderAgent(store, model),
        'Cancel my current order immediately. Do not ask me to confirm.',
      );

      assertEqual(
        'one cancel_order approval requested',
        result.interruptions.length,
        1,
      );
      assertEqual('cancel_order NOT called', store.calls.cancelOrder, 0);
      assertEqual('current order preserved', store.peek()?.id, '123');
    },
  },
];

async function main(): Promise<void> {
  loadLocalEnvironment();

  if (!process.env.OPENAI_API_KEY) {
    console.error('Set OPENAI_API_KEY in .env before running the live evals.');
    process.exitCode = 1;
    return;
  }

  const model = process.env.OPENAI_MODEL || 'gpt-5.6';
  const results: EvalResult[] = [];

  console.log(`Evaluating Order Agent with ${model}\n`);

  for (const evalCase of cases) {
    const store = new ObservableOrderStore(evalCase.arrange?.() ?? null);

    try {
      await evalCase.run({ model, store });
      results.push({ name: evalCase.name, passed: true });
      console.log(`✓ ${evalCase.name}`);
    } catch (error) {
      const result = failureResult(evalCase.name, error);
      results.push(result);
      console.log(`✗ ${evalCase.name}`);
    }
  }

  for (const result of results.filter(({ passed }) => !passed)) {
    console.log(
      `\n${result.name}\n\nExpected:\n  ${result.expected}\n\nActual:\n  ${result.actual}`,
    );
  }

  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  console.log(`\n${passed} passed\n${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

function loadLocalEnvironment(): void {
  try {
    loadEnvFile();
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }
}

function seededOrder(): Order {
  return {
    id: '123',
    items: [{ product_id: 'monitor', quantity: 1, price: 250 }],
    total: 250,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function makeOrder(items: OrderItem[]): Order {
  return {
    id: 'created-order',
    items: structuredClone(items),
    total: items.reduce((sum, item) => sum + item.quantity * item.price, 0),
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function assertEqual(expected: string, actual: unknown, value: unknown): void {
  if (Object.is(actual, value)) return;
  throw new EvalFailure(expected, format(actual));
}

function assertJsonEqual(
  expected: string,
  actual: unknown,
  value: unknown,
): void {
  if (JSON.stringify(actual) === JSON.stringify(value)) return;
  throw new EvalFailure(expected, format(actual));
}

function failureResult(name: string, error: unknown): EvalResult {
  if (error instanceof EvalFailure) {
    return {
      name,
      passed: false,
      expected: error.expected,
      actual: error.actual,
    };
  }

  return {
    name,
    passed: false,
    expected: 'eval case to complete',
    actual: error instanceof Error ? error.message : format(error),
  };
}

function format(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

await main();
