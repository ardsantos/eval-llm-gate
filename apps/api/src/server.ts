import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';

import { JsonOrderStore, OrderAgentSession } from '@gate/agent';
import type { Order, OrderItem, OrderStore } from '@gate/agent';
import type {
  ApiError,
  ChatResponse,
  EvalRun,
  ModelsResponse,
  TraceEvent,
} from '@gate/contracts';
import { evaluationCount, runOrderAgentEvaluations } from '@gate/evals';

try {
  loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  /* environment may already be configured */
}

const port = Number(process.env.PORT || 8787);
const configuredModel = process.env.OPENAI_MODEL || 'gpt-5.6';
let defaultModel = configuredModel;
let availableModels = [configuredModel];
interface ApiSession {
  agent: OrderAgentSession;
  model: string;
  trace: TraceEvent[];
}
const sessions = new Map<string, ApiSession>();
const evalRuns = new Map<string, EvalRun>();

const server = createServer((request, response) => {
  void handleRequest(request, response);
});

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  setCors(response);
  if (request.method === 'OPTIONS') return empty(response, 204);

  try {
    const url = new URL(
      request.url || '/',
      `http://${request.headers.host || 'localhost'}`,
    );

    if (request.method === 'GET' && url.pathname === '/health') {
      return json(response, 200, {
        status: 'ready',
        model: defaultModel,
        evaluationCount,
        configured: Boolean(process.env.OPENAI_API_KEY),
      });
    }

    if (request.method === 'GET' && url.pathname === '/models') {
      return json(response, 200, {
        defaultModel,
        models: availableModels,
      } satisfies ModelsResponse);
    }

    if (request.method === 'POST' && url.pathname === '/sessions') {
      const body = await readJson(request);
      const selectedModel = getRequestedModel(body);
      const id = randomUUID();
      sessions.set(id, createSession(id, selectedModel));
      return json(response, 201, { sessionId: id });
    }

    const messageMatch = url.pathname.match(
      /^\/sessions\/([a-f0-9-]+)\/messages$/u,
    );
    if (request.method === 'POST' && messageMatch?.[1]) {
      requireApiKey();
      const body = await readJson(request);
      if (typeof body.message !== 'string' || !body.message.trim())
        return json(response, 400, {
          error: 'Message is required.',
        } satisfies ApiError);
      const sessionId = messageMatch[1];
      const session =
        sessions.get(sessionId) ?? createSession(sessionId, defaultModel);
      sessions.set(sessionId, session);
      session.trace.length = 0;
      const started = performance.now();
      const agentResponse = await session.agent.send(body.message.trim());
      const durationMs = Math.round(performance.now() - started);
      const events: TraceEvent[] = [
        {
          id: randomUUID(),
          kind: 'agent',
          label: 'Agent started',
          detail: session.model,
          elapsedMs: 0,
        },
        ...session.trace,
        {
          id: randomUUID(),
          kind:
            agentResponse.status === 'confirmation_required'
              ? 'tool_call'
              : 'response',
          label:
            agentResponse.status === 'confirmation_required'
              ? 'Approval required'
              : 'Response completed',
          detail:
            agentResponse.status === 'confirmation_required'
              ? 'cancel_order paused'
              : `${durationMs}ms`,
          elapsedMs: durationMs,
        },
      ];
      const payload: ChatResponse = {
        sessionId,
        status: agentResponse.status,
        message: {
          id: randomUUID(),
          role: 'agent',
          body: agentResponse.message,
          createdAt: new Date().toISOString(),
        },
        durationMs,
        events,
      };
      return json(response, 200, payload);
    }

    if (request.method === 'GET' && url.pathname === '/eval-runs') {
      return json(response, 200, [...evalRuns.values()].reverse());
    }

    if (request.method === 'POST' && url.pathname === '/eval-runs') {
      requireApiKey();
      const body = await readJson(request);
      const selectedModel = getRequestedModel(body);
      const run: EvalRun = {
        id: randomUUID(),
        model: selectedModel,
        status: 'queued',
        createdAt: new Date().toISOString(),
        passed: 0,
        failed: 0,
        results: [],
      };
      evalRuns.set(run.id, run);
      void executeEvalRun(run);
      return json(response, 202, run);
    }

    const evalMatch = url.pathname.match(/^\/eval-runs\/([a-f0-9-]+)$/u);
    if (request.method === 'GET' && evalMatch?.[1]) {
      const run = evalRuns.get(evalMatch[1]);
      return run
        ? json(response, 200, run)
        : json(response, 404, {
            error: 'Evaluation run not found.',
          } satisfies ApiError);
    }

    return json(response, 404, {
      error: 'Route not found.',
    } satisfies ApiError);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unexpected server error.';
    return json(response, message.includes('OPENAI_API_KEY') ? 503 : 500, {
      error: message,
    } satisfies ApiError);
  }
}

function createSession(id: string, selectedModel: string): ApiSession {
  const storePath = resolve(process.cwd(), '../../data/sessions', `${id}.json`);
  const trace: TraceEvent[] = [];
  const store = new TracedOrderStore(new JsonOrderStore(storePath), trace);
  return {
    agent: new OrderAgentSession(store, selectedModel),
    model: selectedModel,
    trace,
  };
}

class TracedOrderStore implements OrderStore {
  constructor(
    private readonly inner: OrderStore,
    private readonly events: TraceEvent[],
  ) {}

  async getCurrentOrder(): Promise<Order | null> {
    const started = performance.now();
    this.call('get_order_status', {});
    const order = await this.inner.getCurrentOrder();
    this.result(
      'get_order_status',
      order
        ? { status: 'active', order }
        : { status: 'not_found', order: null },
      started,
    );
    return order;
  }

  async saveOrder(items: OrderItem[]): Promise<Order> {
    const started = performance.now();
    this.call('create_order', { items });
    const order = await this.inner.saveOrder(items);
    this.result('create_order', { success: true, order }, started);
    return order;
  }

  async removeCurrentOrder(): Promise<Order | null> {
    const started = performance.now();
    this.call('cancel_order', {});
    const order = await this.inner.removeCurrentOrder();
    this.result(
      'cancel_order',
      order
        ? { success: true, cancelledOrderId: order.id }
        : { success: false, reason: 'not_found' },
      started,
    );
    return order;
  }

  private call(name: string, payload: unknown): void {
    this.events.push({
      id: randomUUID(),
      kind: 'tool_call',
      label: 'Tool call',
      detail: name,
      elapsedMs: 0,
      payload,
    });
  }

  private result(name: string, payload: unknown, started: number): void {
    this.events.push({
      id: randomUUID(),
      kind: 'tool_result',
      label: 'Tool result',
      detail: name,
      elapsedMs: Math.round(performance.now() - started),
      payload,
    });
  }
}

async function executeEvalRun(evalRun: EvalRun): Promise<void> {
  evalRun.status = 'running';
  try {
    evalRun.results = await runOrderAgentEvaluations(
      evalRun.model,
      (result) => {
        evalRun.results.push(result);
        evalRun.passed = evalRun.results.filter(
          (item) => item.status === 'passed',
        ).length;
        evalRun.failed = evalRun.results.length - evalRun.passed;
      },
    );
    evalRun.passed = evalRun.results.filter(
      (result) => result.status === 'passed',
    ).length;
    evalRun.failed = evalRun.results.length - evalRun.passed;
    evalRun.status = evalRun.failed === 0 ? 'passed' : 'failed';
  } catch (error) {
    evalRun.status = 'failed';
    evalRun.failed += 1;
    evalRun.results.push({
      name: 'evaluation-runner',
      label: 'Evaluation runner',
      status: 'failed',
      durationMs: 0,
      expected: 'All evaluation cases to execute',
      actual: error instanceof Error ? error.message : String(error),
      events: [],
    });
  } finally {
    evalRun.completedAt = new Date().toISOString();
  }
}

function requireApiKey(): void {
  if (!process.env.OPENAI_API_KEY)
    throw new Error('OPENAI_API_KEY is not configured on the API server.');
}

function getRequestedModel(body: Record<string, unknown>): string {
  const selectedModel =
    typeof body.model === 'string' ? body.model.trim() : defaultModel;
  if (!selectedModel || !availableModels.includes(selectedModel))
    throw new Error('The selected model is not available to this API key.');
  return selectedModel;
}

interface OpenAIModelsResponse {
  data?: Array<{ id?: unknown }>;
}

async function loadAvailableModels(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn(
      'OPENAI_API_KEY is not configured; using OPENAI_MODEL as the only model option.',
    );
    return;
  }

  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`OpenAI returned HTTP ${response.status}`);
    const payload = (await response.json()) as OpenAIModelsResponse;
    const modelIds = (payload.data ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    const uniqueModelIds = [...new Set(modelIds)].sort((a, b) =>
      a.localeCompare(b),
    );
    if (uniqueModelIds.length > 0) {
      availableModels = uniqueModelIds;
      defaultModel = uniqueModelIds.includes(configuredModel)
        ? configuredModel
        : uniqueModelIds[0]!;
    }
    console.log(`Loaded ${uniqueModelIds.length} models from OpenAI.`);
  } catch (error) {
    console.warn(
      `Could not load models from OpenAI; using ${defaultModel} only:`,
      error instanceof Error ? error.message : error,
    );
  }
}

async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > 1_000_000) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
    string,
    unknown
  >;
}

function setCors(response: ServerResponse): void {
  response.setHeader(
    'Access-Control-Allow-Origin',
    process.env.WEB_ORIGIN || 'http://localhost:3000',
  );
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(value));
}

function empty(response: ServerResponse, status: number): void {
  response.writeHead(status);
  response.end();
}

await loadAvailableModels();

server.listen(port, () => {
  console.log(`Gate API ready at http://localhost:${port}`);
});
