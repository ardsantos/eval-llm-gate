import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  AgentInputItem,
  Session,
  SessionHistoryRewriteArgs,
  SessionHistoryRewriteAwareSession,
} from '@openai/agents';

import type { EvalCaseResult, EvalRun, TraceEvent } from '@gate/contracts';

import type { Order, OrderItem, OrderStore } from './order-store.js';

interface SessionRow {
  id: string;
  model: string;
  created_at: string;
  pending_run_state: string | null;
}

interface OrderRow {
  id: string;
  created_at: string;
  total_cents: number;
}

interface OrderItemRow {
  product_id: string;
  quantity: number;
  price_cents: number;
}

interface EvalRunRow {
  id: string;
  model: string;
  status: EvalRun['status'];
  created_at: string;
  completed_at: string | null;
  passed: number;
  failed: number;
}

interface EvalResultRow {
  name: string;
  label: string;
  status: EvalCaseResult['status'];
  duration_ms: number;
  expected: string;
  actual: string;
  events_json: string;
}

interface ChatMessageRow {
  id: string;
  role: 'user' | 'agent';
  body: string;
  created_at: string;
  status: 'completed' | 'confirmation_required' | null;
  duration_ms: number | null;
  events_json: string | null;
}

export interface PersistedChatMessage {
  id: string;
  role: 'user' | 'agent';
  body: string;
  createdAt: string;
  status?: 'completed' | 'confirmation_required';
  durationMs?: number;
  events?: TraceEvent[];
}

export interface ChatMessageMetadata {
  status: 'completed' | 'confirmation_required';
  durationMs: number;
  events: TraceEvent[];
}

const migrations = [
  `
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      pending_run_state TEXT
    ) STRICT;

    CREATE TABLE agent_items (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      item_json TEXT NOT NULL,
      UNIQUE (session_id, position)
    ) STRICT;

    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT CHECK (status IN ('completed', 'confirmation_required')),
      duration_ms INTEGER,
      events_json TEXT
    ) STRICT;

    CREATE INDEX chat_messages_session_created
      ON chat_messages(session_id, created_at, id);

    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('active', 'cancelled', 'replaced')),
      total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
      created_at TEXT NOT NULL,
      closed_at TEXT
    ) STRICT;

    CREATE UNIQUE INDEX orders_one_active_per_session
      ON orders(session_id) WHERE status = 'active';

    CREATE TABLE order_items (
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      product_id TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      PRIMARY KEY (order_id, position)
    ) STRICT;

    CREATE TABLE eval_runs (
      id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed')),
      created_at TEXT NOT NULL,
      completed_at TEXT,
      passed INTEGER NOT NULL DEFAULT 0 CHECK (passed >= 0),
      failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0)
    ) STRICT;

    CREATE INDEX eval_runs_created ON eval_runs(created_at DESC);

    CREATE TABLE eval_results (
      run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      name TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
      duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
      expected TEXT NOT NULL,
      actual TEXT NOT NULL,
      events_json TEXT NOT NULL,
      PRIMARY KEY (run_id, position)
    ) STRICT;
  `,
];

export class GateDatabase {
  readonly filePath: string;
  private readonly database: DatabaseSync;

  constructor(filePath = 'data/gate.sqlite') {
    this.filePath = filePath;
    if (filePath !== ':memory:')
      mkdirSync(dirname(filePath), { recursive: true });
    this.database = new DatabaseSync(filePath);
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec('PRAGMA busy_timeout = 5000');
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec('PRAGMA synchronous = NORMAL');
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  ensureSession(id: string, model: string): SessionRow {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO sessions (id, model, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(id, model, now, now);
    const row = this.database
      .prepare(
        `SELECT id, model, created_at, pending_run_state
         FROM sessions WHERE id = ?`,
      )
      .get(id) as unknown as SessionRow | undefined;
    if (!row) throw new Error(`Could not create session ${id}.`);
    return row;
  }

  createOrderStore(sessionId: string): SqliteOrderStore {
    return new SqliteOrderStore(this, sessionId);
  }

  createAgentSession(sessionId: string): SqliteAgentSession {
    return new SqliteAgentSession(this, sessionId);
  }

  saveChatMessage(
    sessionId: string,
    message: Omit<PersistedChatMessage, 'status' | 'durationMs' | 'events'>,
    metadata?: ChatMessageMetadata,
  ): void {
    this.database
      .prepare(
        `INSERT INTO chat_messages
           (id, session_id, role, body, created_at, status, duration_ms, events_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        sessionId,
        message.role,
        message.body,
        message.createdAt,
        metadata?.status ?? null,
        metadata?.durationMs ?? null,
        metadata ? JSON.stringify(metadata.events) : null,
      );
    this.touchSession(sessionId);
  }

  listChatMessages(sessionId: string): PersistedChatMessage[] {
    const rows = this.database
      .prepare(
        `SELECT id, role, body, created_at, status, duration_ms, events_json
         FROM chat_messages
         WHERE session_id = ?
         ORDER BY created_at, rowid`,
      )
      .all(sessionId) as unknown as ChatMessageRow[];
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      body: row.body,
      createdAt: row.created_at,
      ...(row.status ? { status: row.status } : {}),
      ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
      ...(row.events_json
        ? { events: parseJson<TraceEvent[]>(row.events_json) }
        : {}),
    }));
  }

  saveEvalRun(run: EvalRun): void {
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO eval_runs
             (id, model, status, created_at, completed_at, passed, failed)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             model = excluded.model,
             status = excluded.status,
             completed_at = excluded.completed_at,
             passed = excluded.passed,
             failed = excluded.failed`,
        )
        .run(
          run.id,
          run.model,
          run.status,
          run.createdAt,
          run.completedAt ?? null,
          run.passed,
          run.failed,
        );
      this.database
        .prepare('DELETE FROM eval_results WHERE run_id = ?')
        .run(run.id);
      const insert = this.database.prepare(
        `INSERT INTO eval_results
           (run_id, position, name, label, status, duration_ms, expected, actual, events_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      run.results.forEach((result, position) => {
        insert.run(
          run.id,
          position,
          result.name,
          result.label,
          result.status,
          result.durationMs,
          result.expected,
          result.actual,
          JSON.stringify(result.events),
        );
      });
    });
  }

  getEvalRun(id: string): EvalRun | undefined {
    const row = this.database
      .prepare(
        `SELECT id, model, status, created_at, completed_at, passed, failed
         FROM eval_runs WHERE id = ?`,
      )
      .get(id) as unknown as EvalRunRow | undefined;
    return row ? this.hydrateEvalRun(row) : undefined;
  }

  listEvalRuns(): EvalRun[] {
    const rows = this.database
      .prepare(
        `SELECT id, model, status, created_at, completed_at, passed, failed
         FROM eval_runs ORDER BY created_at DESC, rowid DESC`,
      )
      .all() as unknown as EvalRunRow[];
    return rows.map((row) => this.hydrateEvalRun(row));
  }

  failInterruptedEvalRuns(): void {
    for (const run of this.listEvalRuns()) {
      if (run.status !== 'queued' && run.status !== 'running') continue;
      run.status = 'failed';
      run.failed += 1;
      run.completedAt = new Date().toISOString();
      run.results.push({
        name: 'evaluation-runner',
        label: 'Evaluation runner',
        status: 'failed',
        durationMs: 0,
        expected: 'Evaluation run to complete before shutdown',
        actual: 'The API process stopped before this evaluation run completed.',
        events: [],
      });
      this.saveEvalRun(run);
    }
  }

  importCurrentOrder(sessionId: string, model: string, order: Order): void {
    this.ensureSession(sessionId, model);
    const exists = this.database
      .prepare('SELECT 1 AS found FROM orders WHERE id = ?')
      .get(order.id);
    if (exists) return;
    this.insertOrder(sessionId, order);
  }

  getCurrentOrder(sessionId: string): Order | null {
    const row = this.database
      .prepare(
        `SELECT id, created_at, total_cents
         FROM orders WHERE session_id = ? AND status = 'active'`,
      )
      .get(sessionId) as unknown as OrderRow | undefined;
    return row ? this.hydrateOrder(row) : null;
  }

  saveOrder(sessionId: string, items: OrderItem[]): Order {
    const normalizedItems = items.map((item) => ({
      product_id: item.product_id,
      quantity: item.quantity,
      price: cents(item.price) / 100,
    }));
    const order: Order = {
      id: randomUUID(),
      items: normalizedItems,
      total:
        normalizedItems.reduce(
          (sum, item) => sum + item.quantity * cents(item.price),
          0,
        ) / 100,
      created_at: new Date().toISOString(),
    };
    this.insertOrder(sessionId, order);
    return order;
  }

  removeCurrentOrder(sessionId: string): Order | null {
    return this.transaction(() => {
      const order = this.getCurrentOrder(sessionId);
      if (!order) return null;
      this.database
        .prepare(
          `UPDATE orders SET status = 'cancelled', closed_at = ?
           WHERE id = ? AND status = 'active'`,
        )
        .run(new Date().toISOString(), order.id);
      return order;
    });
  }

  getAgentItems(sessionId: string, limit?: number): AgentInputItem[] {
    const statement =
      limit === undefined
        ? this.database.prepare(
            `SELECT item_json FROM agent_items
           WHERE session_id = ? ORDER BY position`,
          )
        : this.database.prepare(
            `SELECT item_json FROM (
             SELECT item_json, position FROM agent_items
             WHERE session_id = ? ORDER BY position DESC LIMIT ?
           ) ORDER BY position`,
          );
    const rows = (limit === undefined
      ? statement.all(sessionId)
      : statement.all(sessionId, limit)) as unknown as Array<{
      item_json: string;
    }>;
    return rows.map((row) => parseJson<AgentInputItem>(row.item_json));
  }

  addAgentItems(sessionId: string, items: AgentInputItem[]): void {
    if (items.length === 0) return;
    this.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT COALESCE(MAX(position), -1) AS position
           FROM agent_items WHERE session_id = ?`,
        )
        .get(sessionId) as unknown as { position: number };
      const insert = this.database.prepare(
        `INSERT INTO agent_items (session_id, position, item_json)
         VALUES (?, ?, ?)`,
      );
      items.forEach((item, offset) => {
        insert.run(sessionId, row.position + offset + 1, JSON.stringify(item));
      });
      this.touchSession(sessionId);
    });
  }

  popAgentItem(sessionId: string): AgentInputItem | undefined {
    return this.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT id, item_json FROM agent_items
           WHERE session_id = ? ORDER BY position DESC LIMIT 1`,
        )
        .get(sessionId) as unknown as
        { id: number; item_json: string } | undefined;
      if (!row) return undefined;
      this.database.prepare('DELETE FROM agent_items WHERE id = ?').run(row.id);
      this.touchSession(sessionId);
      return parseJson<AgentInputItem>(row.item_json);
    });
  }

  clearAgentItems(sessionId: string): void {
    this.database
      .prepare('DELETE FROM agent_items WHERE session_id = ?')
      .run(sessionId);
    this.touchSession(sessionId);
  }

  rewriteAgentHistory(
    sessionId: string,
    mutations: SessionHistoryRewriteArgs['mutations'],
  ): void {
    const items = this.getAgentItems(sessionId);
    for (const mutation of mutations) {
      if (mutation.type !== 'replace_function_call') continue;
      const index = items.findIndex(
        (item) =>
          item.type === 'function_call' && item.callId === mutation.callId,
      );
      if (index >= 0) items[index] = mutation.replacement;
    }
    this.transaction(() => {
      this.database
        .prepare('DELETE FROM agent_items WHERE session_id = ?')
        .run(sessionId);
      const insert = this.database.prepare(
        `INSERT INTO agent_items (session_id, position, item_json)
         VALUES (?, ?, ?)`,
      );
      items.forEach((item, position) => {
        insert.run(sessionId, position, JSON.stringify(item));
      });
      this.touchSession(sessionId);
    });
  }

  getPendingRunState(sessionId: string): string | undefined {
    const row = this.database
      .prepare('SELECT pending_run_state FROM sessions WHERE id = ?')
      .get(sessionId) as unknown as
      { pending_run_state: string | null } | undefined;
    return row?.pending_run_state ?? undefined;
  }

  setPendingRunState(sessionId: string, state: string | undefined): void {
    this.database
      .prepare(
        `UPDATE sessions SET pending_run_state = ?, updated_at = ? WHERE id = ?`,
      )
      .run(state ?? null, new Date().toISOString(), sessionId);
  }

  private insertOrder(sessionId: string, order: Order): void {
    this.transaction(() => {
      const closedAt = new Date().toISOString();
      this.database
        .prepare(
          `UPDATE orders SET status = 'replaced', closed_at = ?
           WHERE session_id = ? AND status = 'active'`,
        )
        .run(closedAt, sessionId);
      this.database
        .prepare(
          `INSERT INTO orders (id, session_id, status, total_cents, created_at)
           VALUES (?, ?, 'active', ?, ?)`,
        )
        .run(order.id, sessionId, cents(order.total), order.created_at);
      const insertItem = this.database.prepare(
        `INSERT INTO order_items
           (order_id, position, product_id, quantity, price_cents)
         VALUES (?, ?, ?, ?, ?)`,
      );
      order.items.forEach((item, position) => {
        insertItem.run(
          order.id,
          position,
          item.product_id,
          item.quantity,
          cents(item.price),
        );
      });
      this.touchSession(sessionId);
    });
  }

  private hydrateOrder(row: OrderRow): Order {
    const items = this.database
      .prepare(
        `SELECT product_id, quantity, price_cents FROM order_items
         WHERE order_id = ? ORDER BY position`,
      )
      .all(row.id) as unknown as OrderItemRow[];
    return {
      id: row.id,
      items: items.map((item) => ({
        product_id: item.product_id,
        quantity: item.quantity,
        price: item.price_cents / 100,
      })),
      total: row.total_cents / 100,
      created_at: row.created_at,
    };
  }

  private hydrateEvalRun(row: EvalRunRow): EvalRun {
    const results = this.database
      .prepare(
        `SELECT name, label, status, duration_ms, expected, actual, events_json
         FROM eval_results WHERE run_id = ? ORDER BY position`,
      )
      .all(row.id) as unknown as EvalResultRow[];
    return {
      id: row.id,
      model: row.model,
      status: row.status,
      createdAt: row.created_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      passed: row.passed,
      failed: row.failed,
      results: results.map((result) => ({
        name: result.name,
        label: result.label,
        status: result.status,
        durationMs: result.duration_ms,
        expected: result.expected,
        actual: result.actual,
        events: parseJson<TraceEvent[]>(result.events_json),
      })),
    };
  }

  private touchSession(sessionId: string): void {
    this.database
      .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), sessionId);
  }

  private migrate(): void {
    const row = this.database
      .prepare('PRAGMA user_version')
      .get() as unknown as {
      user_version: number;
    };
    for (let index = row.user_version; index < migrations.length; index += 1) {
      const migration = migrations[index];
      if (!migration)
        throw new Error(`Missing database migration ${index + 1}.`);
      this.transaction(() => {
        this.database.exec(migration);
        this.database.exec(`PRAGMA user_version = ${index + 1}`);
      });
    }
  }

  private transaction<T>(action: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

export class SqliteOrderStore implements OrderStore {
  constructor(
    private readonly database: GateDatabase,
    readonly sessionId: string,
  ) {}

  getCurrentOrder(): Promise<Order | null> {
    return Promise.resolve(this.database.getCurrentOrder(this.sessionId));
  }

  saveOrder(items: OrderItem[]): Promise<Order> {
    return Promise.resolve(this.database.saveOrder(this.sessionId, items));
  }

  removeCurrentOrder(): Promise<Order | null> {
    return Promise.resolve(this.database.removeCurrentOrder(this.sessionId));
  }
}

export class SqliteAgentSession
  implements Session, SessionHistoryRewriteAwareSession
{
  constructor(
    private readonly database: GateDatabase,
    readonly sessionId: string,
  ) {}

  getSessionId(): Promise<string> {
    return Promise.resolve(this.sessionId);
  }

  getItems(limit?: number): Promise<AgentInputItem[]> {
    return Promise.resolve(this.database.getAgentItems(this.sessionId, limit));
  }

  addItems(items: AgentInputItem[]): Promise<void> {
    this.database.addAgentItems(this.sessionId, items);
    return Promise.resolve();
  }

  popItem(): Promise<AgentInputItem | undefined> {
    return Promise.resolve(this.database.popAgentItem(this.sessionId));
  }

  clearSession(): Promise<void> {
    this.database.clearAgentItems(this.sessionId);
    return Promise.resolve();
  }

  applyHistoryMutations(args: SessionHistoryRewriteArgs): Promise<void> {
    this.database.rewriteAgentHistory(this.sessionId, args.mutations);
    return Promise.resolve();
  }

  getPendingRunState(): Promise<string | undefined> {
    return Promise.resolve(this.database.getPendingRunState(this.sessionId));
  }

  setPendingRunState(state: string | undefined): Promise<void> {
    this.database.setPendingRunState(this.sessionId, state);
    return Promise.resolve();
  }
}

function cents(value: number): number {
  const result = Math.round(value * 100);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error('Order prices and totals must fit in integer cents.');
  return result;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
