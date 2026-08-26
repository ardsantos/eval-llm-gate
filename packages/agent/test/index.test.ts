import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunContext } from '@openai/agents';
import type { AgentInputItem } from '@openai/agents';
import { describe, expect, it } from 'vitest';

import { GateDatabase } from '../src/database.js';
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

describe('GateDatabase', () => {
  it('persists relational orders across database connections', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gate-database-'));
    const filePath = join(directory, 'gate.sqlite');
    const first = new GateDatabase(filePath);
    first.ensureSession('session-1', 'test-model');
    const created = await first.createOrderStore('session-1').saveOrder([
      { product_id: 'keyboard', quantity: 2, price: 99.5 },
      { product_id: 'mouse', quantity: 1, price: 40 },
    ]);
    first.close();

    const second = new GateDatabase(filePath);
    await expect(
      second.createOrderStore('session-1').getCurrentOrder(),
    ).resolves.toEqual(created);
    second.close();
  });

  it('persists SDK conversation items and paused run state', async () => {
    const database = new GateDatabase(':memory:');
    database.ensureSession('session-1', 'test-model');
    const session = database.createAgentSession('session-1');
    const item: AgentInputItem = { role: 'user', content: 'Hello' };

    await session.addItems([item]);
    await session.setPendingRunState('{"paused":true}');

    await expect(session.getItems()).resolves.toEqual([item]);
    await expect(session.getPendingRunState()).resolves.toBe('{"paused":true}');
    database.close();
  });

  it('persists evaluation results and trace payloads', () => {
    const database = new GateDatabase(':memory:');
    database.saveEvalRun({
      id: 'run-1',
      model: 'test-model',
      status: 'passed',
      createdAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      passed: 1,
      failed: 0,
      results: [
        {
          name: 'case-1',
          label: 'Case 1',
          status: 'passed',
          durationMs: 12,
          expected: 'success',
          actual: 'success',
          events: [
            {
              id: 'event-1',
              kind: 'response',
              label: 'Completed',
              detail: 'success',
              elapsedMs: 12,
              payload: { durable: true },
            },
          ],
        },
      ],
    });

    expect(database.getEvalRun('run-1')).toEqual(database.listEvalRuns()[0]);
    expect(
      database.getEvalRun('run-1')?.results[0]?.events[0]?.payload,
    ).toEqual({ durable: true });
    database.close();
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
