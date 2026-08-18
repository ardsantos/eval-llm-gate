import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunContext } from '@openai/agents';
import { describe, expect, it } from 'vitest';

import { createOrderTools, parseConfirmation } from '../src/order-agent.js';
import { JsonOrderStore } from '../src/order-store.js';

async function createStore(): Promise<JsonOrderStore> {
  const directory = await mkdtemp(join(tmpdir(), 'order-agent-'));
  return new JsonOrderStore(join(directory, 'orders.json'));
}

describe('JsonOrderStore', () => {
  it('saves one current order and calculates its total', async () => {
    const store = await createStore();
    const order = await store.saveOrder([
      { product_id: 'keyboard', quantity: 2, price: 99.5 },
      { product_id: 'mouse', quantity: 1, price: 40 },
    ]);

    expect(order.total).toBe(239);
    await expect(store.getCurrentOrder()).resolves.toEqual(order);

    const database = JSON.parse(await readFile(store.filePath, 'utf8')) as {
      current_order: unknown;
    };
    expect(database.current_order).toEqual(order);
  });

  it('removes and returns the current order', async () => {
    const store = await createStore();
    const order = await store.saveOrder([
      { product_id: 'monitor', quantity: 1, price: 250 },
    ]);

    await expect(store.removeCurrentOrder()).resolves.toEqual(order);
    await expect(store.getCurrentOrder()).resolves.toBeNull();
    await expect(store.removeCurrentOrder()).resolves.toBeNull();
  });
});

describe('Order Agent safety', () => {
  it('returns the status of the current order', async () => {
    const store = await createStore();
    const { getOrderStatus } = createOrderTools(store);

    await expect(getOrderStatus.invoke(new RunContext(), '{}')).resolves.toBe(
      JSON.stringify({ status: 'not_found', order: null }),
    );

    const order = await store.saveOrder([
      { product_id: 'headphones', quantity: 1, price: 75 },
    ]);

    await expect(getOrderStatus.invoke(new RunContext(), '{}')).resolves.toBe(
      JSON.stringify({ status: 'active', order }),
    );
  });

  it('requires SDK approval for every cancel_order call', async () => {
    const { cancelOrder } = createOrderTools(await createStore());

    await expect(
      cancelOrder.needsApproval(new RunContext(), {}, 'call-1'),
    ).resolves.toBe(true);
  });

  it.each([
    ['yes', 'approve'],
    ['Yes, cancel it.', 'approve'],
    ['confirm', 'approve'],
    ['no', 'reject'],
    ["don't cancel", 'reject'],
    ['maybe', 'unknown'],
    ['I already said yes earlier', 'unknown'],
  ] as const)('classifies %j as %s', (message, expected) => {
    expect(parseConfirmation(message)).toBe(expected);
  });
});
