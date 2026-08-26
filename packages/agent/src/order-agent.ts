import {
  Agent,
  RunState,
  type Session,
  type RunToolApprovalItem,
  run,
  tool,
} from '@openai/agents';
import { z } from 'zod';

import type { OrderStore } from './order-store.js';

const orderItemSchema = z.object({
  product_id: z.string().trim().min(1),
  quantity: z.number().int().positive(),
  price: z.number().nonnegative(),
});

export function createOrderTools(store: OrderStore) {
  const createOrder = tool({
    name: 'create_order',
    description:
      'Create the current order after the user has supplied every product ID, quantity, and unit price.',
    parameters: z.object({
      items: z.array(orderItemSchema).min(1),
    }),
    async execute({ items }) {
      const order = await store.saveOrder(items);
      return JSON.stringify({ success: true, order });
    },
  });

  const cancelOrder = tool({
    name: 'cancel_order',
    description:
      'Remove the current order. This is destructive and always requires explicit user approval before execution.',
    parameters: z.object({}),
    needsApproval: true,
    async execute() {
      const removedOrder = await store.removeCurrentOrder();

      return JSON.stringify(
        removedOrder
          ? { success: true, cancelled_order_id: removedOrder.id }
          : { success: false, reason: 'There is no current order to cancel.' },
      );
    },
  });

  const getOrderStatus = tool({
    name: 'get_order_status',
    description:
      'Get the status and details of the current order, if one exists.',
    parameters: z.object({}),
    async execute() {
      const order = await store.getCurrentOrder();

      return JSON.stringify(
        order
          ? { status: 'active', order }
          : { status: 'not_found', order: null },
      );
    },
  });

  return { cancelOrder, createOrder, getOrderStatus };
}

export function createOrderAgent(store: OrderStore, model = 'gpt-5.6') {
  const { cancelOrder, createOrder, getOrderStatus } = createOrderTools(store);

  return new Agent<undefined>({
    name: 'Order Agent',
    model,
    instructions: `You manage one current customer order.

- To create an order, collect product_id, quantity, and price for every item. Ask for any missing values. Never invent them. Then call create_order.
- When the user asks about their current order or its status, call get_order_status. Report that there is no current order when it returns not_found.
- When the user requests cancellation, call cancel_order immediately. Do not ask for confirmation in your response before calling it: the tool call itself pauses and makes the application ask for confirmation. Never claim that an order was cancelled unless that tool returns success.
- Cancellation requires a separate, explicit confirmation. The application enforces this by pausing every cancel_order call for approval before the tool can execute. Do not bypass, weaken, or simulate that approval.
- Be concise and clearly report tool failures.`,
    tools: [createOrder, getOrderStatus, cancelOrder],
  });
}

export type ConfirmationDecision = 'approve' | 'reject' | 'unknown';

export function parseConfirmation(message: string): ConfirmationDecision {
  const normalized = message
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[.!]+$/u, '')
    .replace(/\s+/gu, ' ');

  const approvals = new Set([
    'yes',
    'yes cancel it',
    'yes, cancel it',
    'confirm',
    'confirmed',
    'proceed',
    'go ahead',
  ]);
  const rejections = new Set([
    'no',
    'no keep it',
    'no, keep it',
    'do not cancel',
    "don't cancel",
    'keep it',
    'abort',
    'never mind',
    'nevermind',
  ]);

  if (approvals.has(normalized)) return 'approve';
  if (rejections.has(normalized)) return 'reject';
  return 'unknown';
}

export type OrderAgentResponse =
  | { status: 'completed'; message: string }
  | { status: 'confirmation_required'; message: string };

type OrderAgent = ReturnType<typeof createOrderAgent>;

interface PendingApproval {
  state: RunState<undefined, OrderAgent>;
  interruptions: RunToolApprovalItem[];
}

export interface PersistentAgentSession extends Session {
  getPendingRunState(): Promise<string | undefined>;
  setPendingRunState(state: string | undefined): Promise<void>;
}

export class OrderAgentSession {
  readonly agent: OrderAgent;
  private pendingApproval: PendingApproval | undefined;
  private persistenceLoaded = false;

  constructor(
    store: OrderStore,
    model = 'gpt-5.6',
    private readonly persistence?: PersistentAgentSession,
  ) {
    this.agent = createOrderAgent(store, model);
  }

  async send(message: string): Promise<OrderAgentResponse> {
    await this.loadPendingApproval();
    if (this.pendingApproval) {
      return this.resolveConfirmation(message);
    }

    const result = this.persistence
      ? await run(this.agent, message, { session: this.persistence })
      : await run(this.agent, message);

    if (result.interruptions.length > 0) {
      this.pendingApproval = {
        state: result.state,
        interruptions: result.interruptions,
      };
      await this.persistence?.setPendingRunState(result.state.toString());
      return confirmationRequired();
    }

    await this.persistence?.setPendingRunState(undefined);
    return {
      status: 'completed',
      message: result.finalOutput ?? 'The agent completed without a response.',
    };
  }

  private async resolveConfirmation(
    message: string,
  ): Promise<OrderAgentResponse> {
    const decision = parseConfirmation(message);
    if (decision === 'unknown') return confirmationRequired();

    const pending = this.pendingApproval;
    if (!pending) throw new Error('No cancellation is awaiting confirmation.');

    for (const interruption of pending.interruptions) {
      if (decision === 'approve') {
        pending.state.approve(interruption);
      } else {
        pending.state.reject(interruption, {
          message: 'The user explicitly declined the cancellation.',
        });
      }
    }

    const result = this.persistence
      ? await run(this.agent, pending.state, { session: this.persistence })
      : await run(this.agent, pending.state);

    if (result.interruptions.length > 0) {
      this.pendingApproval = {
        state: result.state,
        interruptions: result.interruptions,
      };
      await this.persistence?.setPendingRunState(result.state.toString());
      return confirmationRequired();
    }

    this.pendingApproval = undefined;
    await this.persistence?.setPendingRunState(undefined);

    return {
      status: 'completed',
      message:
        result.finalOutput ??
        (decision === 'approve'
          ? 'The cancellation was processed.'
          : 'The order was not cancelled.'),
    };
  }

  private async loadPendingApproval(): Promise<void> {
    if (this.persistenceLoaded || !this.persistence) return;
    this.persistenceLoaded = true;
    const serialized = await this.persistence.getPendingRunState();
    if (!serialized) return;

    let state: RunState<undefined, OrderAgent>;
    try {
      state = await RunState.fromString<undefined, OrderAgent>(
        this.agent,
        serialized,
      );
    } catch (error) {
      await this.persistence.setPendingRunState(undefined);
      throw new Error(
        'The saved approval could not be restored. Ask to cancel the order again.',
        { cause: error },
      );
    }
    const interruptions = state.getInterruptions();
    if (interruptions.length === 0) {
      await this.persistence.setPendingRunState(undefined);
      return;
    }
    this.pendingApproval = { state, interruptions };
  }
}

function confirmationRequired(): OrderAgentResponse {
  return {
    status: 'confirmation_required',
    message:
      'Are you sure you want to cancel the current order? Reply exactly “yes” to confirm or “no” to keep it.',
  };
}
