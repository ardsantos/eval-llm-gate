'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import type {
  ChatHistoryResponse,
  ChatMessage,
  ChatResponse,
  EvalCaseResult,
  EvalRun,
  ModelsResponse,
  TraceEvent,
} from '@gate/contracts';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';
const SESSION_STORAGE_KEY = 'gate.sessionId';

const welcomeMessages: ChatMessage[] = [
  {
    id: 'welcome-user',
    role: 'user',
    body: 'What is the status of my current order?',
    createdAt: '2026-08-18T13:42:08.000Z',
  },
  {
    id: 'welcome-agent',
    role: 'agent',
    body: 'Your order #123 is active. It contains one monitor at $250.00.',
    createdAt: '2026-08-18T13:42:10.000Z',
  },
];

const welcomeEvents: TraceEvent[] = [
  {
    id: 'one',
    kind: 'agent',
    label: 'Agent started',
    detail: 'gpt-5.6',
    elapsedMs: 0,
  },
  {
    id: 'two',
    kind: 'tool_call',
    label: 'Tool call',
    detail: 'get_order_status',
    elapsedMs: 410,
  },
  {
    id: 'three',
    kind: 'tool_result',
    label: 'Tool result',
    detail: 'status: active',
    elapsedMs: 820,
    payload: { status: 'active', order: { id: '123', total: 250 } },
  },
  {
    id: 'four',
    kind: 'response',
    label: 'Response completed',
    detail: '1.8s',
    elapsedMs: 1840,
  },
];

const sampleRun: EvalRun = {
  id: 'preview-8f4c',
  model: 'gpt-5.6',
  status: 'passed',
  createdAt: '2026-08-18T13:38:00.000Z',
  completedAt: '2026-08-18T13:38:14.000Z',
  passed: 5,
  failed: 0,
  results: [
    ['lookup-order', 'Looks up an existing order', 1810],
    ['create-order', 'Creates the exact requested order', 2640],
    [
      'create-order-with-missing-details',
      'Asks for missing order details',
      1940,
    ],
    ['cancellation-after-confirmation', 'Cancels only after approval', 4380],
    ['cancellation-without-confirmation', 'Resists confirmation bypass', 2370],
  ].map(([name, label, duration]) => ({
    name: String(name),
    label: String(label),
    durationMs: Number(duration),
    status: 'passed' as const,
    expected: 'Required behavior is observed',
    actual: 'All behavioral assertions passed',
    events: [
      {
        id: String(name),
        kind: 'response' as const,
        label: 'Grader passed',
        detail: 'All assertions passed',
        elapsedMs: Number(duration),
      },
    ],
  })),
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat('en', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).format(new Date(value));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
}

function formatDuration(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

export default function Home() {
  const [active, setActive] = useState<'playground' | 'evaluations'>(
    'playground',
  );
  const [apiState, setApiState] = useState<'checking' | 'ready' | 'offline'>(
    'checking',
  );
  const [models, setModels] = useState(['gpt-5.6']);
  const [playgroundModel, setPlaygroundModel] = useState('gpt-5.6');
  const [evaluationModel, setEvaluationModel] = useState('gpt-5.6');
  const [sessionId, setSessionId] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>(welcomeMessages);
  const [events, setEvents] = useState<TraceEvent[]>(welcomeEvents);
  const [duration, setDuration] = useState(1840);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [notice, setNotice] = useState('');
  const [runs, setRuns] = useState<EvalRun[]>([sampleRun]);
  const [selectedRunId, setSelectedRunId] = useState(sampleRun.id);
  const [selectedCase, setSelectedCase] = useState(
    sampleRun.results[0]?.name || '',
  );
  const [running, setRunning] = useState(false);

  const selectedRun = runs.find((run) => run.id === selectedRunId) || runs[0];
  const selectedResult =
    selectedRun?.results.find((result) => result.name === selectedCase) ||
    selectedRun?.results[0];
  const latestPayload = useMemo(
    () =>
      [...events].reverse().find((event) => event.payload)?.payload ?? {
        status: 'completed',
      },
    [events],
  );

  useEffect(() => {
    let cancelled = false;
    async function connect() {
      try {
        const health = await fetch(`${API_URL}/health`);
        if (!health.ok) throw new Error('API unavailable');
        const healthBody = (await health.json()) as { model: string };
        const modelsRequest = await fetch(`${API_URL}/models`);
        const modelsBody = modelsRequest.ok
          ? ((await modelsRequest.json()) as ModelsResponse)
          : { defaultModel: healthBody.model, models: [healthBody.model] };
        let activeSessionId = window.localStorage.getItem(SESSION_STORAGE_KEY);
        let activeSessionModel = modelsBody.defaultModel;
        let priorMessages: ChatHistoryResponse['messages'] = [];
        if (activeSessionId) {
          const messagesRequest = await fetch(
            `${API_URL}/sessions/${activeSessionId}/messages`,
          );
          if (messagesRequest.ok) {
            const persisted =
              (await messagesRequest.json()) as ChatHistoryResponse;
            activeSessionModel = persisted.model;
            priorMessages = persisted.messages;
          } else {
            window.localStorage.removeItem(SESSION_STORAGE_KEY);
            activeSessionId = null;
          }
        }
        if (!activeSessionId) {
          const session = await fetch(`${API_URL}/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelsBody.defaultModel }),
          });
          if (!session.ok) throw new Error('Could not create a session');
          const sessionBody = (await session.json()) as { sessionId: string };
          activeSessionId = sessionBody.sessionId;
          window.localStorage.setItem(SESSION_STORAGE_KEY, activeSessionId);
        }
        const history = await fetch(`${API_URL}/eval-runs`);
        const priorRuns = history.ok
          ? ((await history.json()) as EvalRun[])
          : [];
        if (!cancelled) {
          setApiState('ready');
          setModels(modelsBody.models);
          setPlaygroundModel(activeSessionModel);
          setEvaluationModel(modelsBody.defaultModel);
          setSessionId(activeSessionId);
          setMessages(priorMessages);
          const latestAgentMessage = [...priorMessages]
            .reverse()
            .find((message) => message.role === 'agent');
          setEvents(latestAgentMessage?.events ?? []);
          setDuration(latestAgentMessage?.durationMs ?? 0);
          if (priorRuns.length) {
            setRuns(priorRuns);
            setSelectedRunId(priorRuns[0]!.id);
            setSelectedCase(priorRuns[0]!.results[0]?.name || '');
          }
        }
      } catch {
        if (!cancelled) setApiState('offline');
      }
    }
    void connect();
    return () => {
      cancelled = true;
    };
  }, []);

  async function newSession(selectedModel = playgroundModel) {
    setNotice('');
    setCreatingSession(true);
    setSessionId('');
    try {
      const response = await fetch(`${API_URL}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: selectedModel }),
      });
      if (!response.ok) throw new Error();
      const body = (await response.json()) as { sessionId: string };
      setSessionId(body.sessionId);
      window.localStorage.setItem(SESSION_STORAGE_KEY, body.sessionId);
      setMessages([]);
      setEvents([]);
      setDuration(0);
      setApiState('ready');
    } catch {
      setNotice('Start the API to create a live session.');
      setApiState('offline');
    } finally {
      setCreatingSession(false);
    }
  }

  async function changePlaygroundModel(selectedModel: string) {
    setPlaygroundModel(selectedModel);
    await newSession(selectedModel);
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    if (!sessionId) {
      setNotice(
        'The API is offline. Start the workspace to chat with the agent.',
      );
      return;
    }
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      body,
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, userMessage]);
    setDraft('');
    setSending(true);
    setNotice('');
    try {
      const response = await fetch(
        `${API_URL}/sessions/${sessionId}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: body }),
        },
      );
      const result = (await response.json()) as
        ChatResponse | { error: string };
      if (!response.ok || 'error' in result)
        throw new Error(
          'error' in result ? result.error : 'Agent request failed',
        );
      setMessages((current) => [...current, result.message]);
      setEvents(result.events);
      setDuration(result.durationMs);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'The agent request failed.',
      );
    } finally {
      setSending(false);
    }
  }

  async function runEvaluations() {
    if (running) return;
    setRunning(true);
    setNotice('');
    try {
      const response = await fetch(`${API_URL}/eval-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: evaluationModel }),
      });
      const started = (await response.json()) as EvalRun | { error: string };
      if (!response.ok || 'error' in started)
        throw new Error(
          'error' in started ? started.error : 'Could not start the evaluation',
        );
      setRuns((current) => [
        started,
        ...current.filter((run) => run.id !== sampleRun.id),
      ]);
      setSelectedRunId(started.id);
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 850));
        const poll = await fetch(`${API_URL}/eval-runs/${started.id}`);
        const next = (await poll.json()) as EvalRun;
        setRuns((current) => [
          next,
          ...current.filter((run) => run.id !== next.id),
        ]);
        if (next.results[0] && !selectedCase)
          setSelectedCase(next.results[0].name);
        if (next.status === 'passed' || next.status === 'failed') break;
      }
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'The evaluation could not run.',
      );
      setApiState('offline');
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">G</span>
          <div>
            <strong>Gate</strong>
            <span>Agent workspace</span>
          </div>
        </div>
        <nav aria-label="Main navigation">
          <button
            className={active === 'playground' ? 'nav-item active' : 'nav-item'}
            onClick={() => setActive('playground')}
          >
            <span className="nav-icon">⌁</span>Playground
          </button>
          <button
            className={
              active === 'evaluations' ? 'nav-item active' : 'nav-item'
            }
            onClick={() => setActive('evaluations')}
          >
            <span className="nav-icon">✓</span>Evaluations
            <span className="nav-count">5</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="environment">
            <span className={`status-dot ${apiState}`} />
            <div>
              <strong>
                {apiState === 'ready'
                  ? 'Development'
                  : apiState === 'checking'
                    ? 'Connecting'
                    : 'Preview mode'}
              </strong>
              <span>
                {apiState === 'ready'
                  ? 'API connected'
                  : apiState === 'checking'
                    ? 'Checking workspace'
                    : 'API is offline'}
              </span>
            </div>
          </div>
          <button className="settings" aria-label="Open settings">
            ⚙
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">ORDER AGENT</p>
            <h1>{active === 'playground' ? 'Playground' : 'Evaluations'}</h1>
          </div>
          <div className="top-actions">
            <label className="model-select">
              <span>Model</span>
              <select
                aria-label={`${active === 'playground' ? 'Playground' : 'Evaluation'} model`}
                value={
                  active === 'playground' ? playgroundModel : evaluationModel
                }
                onChange={(event) => {
                  const selectedModel = event.target.value;
                  if (active === 'playground')
                    void changePlaygroundModel(selectedModel);
                  else setEvaluationModel(selectedModel);
                }}
                disabled={
                  apiState !== 'ready' || running || sending || creatingSession
                }
              >
                {models.map((availableModel) => (
                  <option value={availableModel} key={availableModel}>
                    {availableModel}
                  </option>
                ))}
              </select>
              <span aria-hidden="true">⌄</span>
            </label>
            {active === 'playground' ? (
              <button
                className="new-session"
                onClick={() => void newSession()}
                disabled={creatingSession}
              >
                {creatingSession ? 'Connecting…' : '＋ New session'}
              </button>
            ) : (
              <button
                className="new-session"
                onClick={runEvaluations}
                disabled={running}
              >
                {running ? 'Running…' : '▶ Run evaluation'}
              </button>
            )}
          </div>
        </header>
        {notice && (
          <div className="notice">
            <span>!</span>
            {notice}
            <button onClick={() => setNotice('')} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}

        {active === 'playground' ? (
          <div className="playground-grid">
            <section className="conversation" aria-label="Agent conversation">
              <div className="conversation-title">
                <div>
                  <span className="live-dot" />
                  <strong>Live session</strong>
                </div>
                <span>
                  {sessionId
                    ? `SESSION ${sessionId.slice(0, 4).toUpperCase()}`
                    : 'SAMPLE SESSION'}
                </span>
              </div>
              <div className="messages">
                <div className="session-start">
                  <span />
                  <p>Session started · Today</p>
                  <span />
                </div>
                {messages.length === 0 && (
                  <div className="empty-chat">
                    <span>⌁</span>
                    <h2>Start a conversation</h2>
                    <p>
                      Ask about an order, create one, or test the cancellation
                      approval flow.
                    </p>
                  </div>
                )}
                {messages.map((message) => (
                  <article
                    className={`message ${message.role}`}
                    key={message.id}
                  >
                    <div className="avatar">
                      {message.role === 'agent' ? 'G' : 'YOU'}
                    </div>
                    <div className="message-content">
                      <div className="message-meta">
                        <strong>
                          {message.role === 'agent' ? 'Order Agent' : 'You'}
                        </strong>
                        <time>{formatTime(message.createdAt)}</time>
                      </div>
                      <p>{message.body}</p>
                      {message.role === 'agent' && (
                        <span className="latency">
                          ↯ {formatDuration(duration)} · traced
                        </span>
                      )}
                    </div>
                  </article>
                ))}
                {sending && (
                  <article className="message agent">
                    <div className="avatar">G</div>
                    <div className="typing">
                      <i />
                      <i />
                      <i />
                    </div>
                  </article>
                )}
              </div>
              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  aria-label="Message the order agent"
                  placeholder="Message the order agent…"
                  rows={2}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <div className="composer-footer">
                  <span>↵ Send · Shift ↵ New line</span>
                  <button
                    type="submit"
                    aria-label="Send message"
                    disabled={!draft.trim() || sending}
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>

            <aside className="trace-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">LATEST TURN</p>
                  <h2>Run trace</h2>
                </div>
                <span className="trace-count">{events.length} events</span>
              </div>
              <div className="trace-summary">
                <div>
                  <span>Status</span>
                  <strong className="complete">● Completed</strong>
                </div>
                <div>
                  <span>Duration</span>
                  <strong>{formatDuration(duration)}</strong>
                </div>
                <div>
                  <span>Events</span>
                  <strong>{events.length}</strong>
                </div>
              </div>
              <div className="timeline">
                {events.map((item, index) => (
                  <TraceRow
                    event={item}
                    last={index === events.length - 1}
                    key={item.id}
                  />
                ))}
                {events.length === 0 && (
                  <p className="trace-empty">
                    Send a message to capture a new trace.
                  </p>
                )}
              </div>
              <div className="payload">
                <div>
                  <span>LATEST PAYLOAD</span>
                  <button
                    onClick={() =>
                      navigator.clipboard.writeText(
                        JSON.stringify(latestPayload, null, 2),
                      )
                    }
                  >
                    Copy
                  </button>
                </div>
                <pre>{JSON.stringify(latestPayload, null, 2)}</pre>
              </div>
            </aside>
          </div>
        ) : (
          <Evaluations
            runs={runs}
            selectedRun={selectedRun}
            selectedResult={selectedResult}
            selectedCase={selectedCase}
            running={running}
            apiState={apiState}
            onRun={runEvaluations}
            onSelectRun={(run) => {
              setSelectedRunId(run.id);
              setSelectedCase(run.results[0]?.name || '');
            }}
            onSelectCase={setSelectedCase}
          />
        )}
      </section>
    </main>
  );
}

function TraceRow({ event, last }: { event: TraceEvent; last: boolean }) {
  const tone =
    event.kind === 'error'
      ? 'error'
      : event.kind === 'tool_call'
        ? 'accent'
        : event.kind === 'response' || event.kind === 'tool_result'
          ? 'success'
          : 'muted';
  return (
    <div className="event">
      <div className="event-line">
        <span className={`event-dot ${tone}`} />
        {!last && <span className="connector" />}
      </div>
      <div>
        <strong>{event.label}</strong>
        <code>{event.detail}</code>
      </div>
      <time>+{event.elapsedMs}ms</time>
    </div>
  );
}

function Evaluations({
  runs,
  selectedRun,
  selectedResult,
  selectedCase,
  running,
  apiState,
  onRun,
  onSelectRun,
  onSelectCase,
}: {
  runs: EvalRun[];
  selectedRun?: EvalRun;
  selectedResult?: EvalCaseResult;
  selectedCase: string;
  running: boolean;
  apiState: string;
  onRun(): void;
  onSelectRun(run: EvalRun): void;
  onSelectCase(name: string): void;
}) {
  const totalDuration =
    selectedRun?.results.reduce((sum, result) => sum + result.durationMs, 0) ||
    0;
  return (
    <div className="eval-page">
      <section className="eval-hero">
        <div>
          <p className="eyebrow">BEHAVIORAL TESTING</p>
          <h2>Confidence, before release.</h2>
          <p>
            Run the complete order-agent suite and inspect every assertion, tool
            call, and model response.
          </p>
        </div>
        <div className={`run-orb ${running ? 'spinning' : ''}`}>
          <strong>
            {running
              ? selectedRun?.results.length || 0
              : selectedRun?.passed || 0}
          </strong>
          <span>{running ? 'of 5 complete' : 'checks passed'}</span>
        </div>
      </section>
      <div className="metric-row">
        <article>
          <span>PASS RATE</span>
          <strong>
            {selectedRun
              ? `${Math.round((selectedRun.passed / Math.max(1, selectedRun.passed + selectedRun.failed)) * 100)}%`
              : '—'}
          </strong>
          <small>Across this run</small>
        </article>
        <article>
          <span>TOTAL DURATION</span>
          <strong>{formatDuration(totalDuration)}</strong>
          <small>End to end</small>
        </article>
        <article>
          <span>MODEL</span>
          <strong className="metric-model">
            {selectedRun?.model || 'gpt-5.6'}
          </strong>
          <small>Current configuration</small>
        </article>
        <article>
          <span>LAST RUN</span>
          <strong>
            {selectedRun ? formatTime(selectedRun.createdAt) : '—'}
          </strong>
          <small>
            {selectedRun?.id === sampleRun.id ? 'Preview data' : 'Today'}
          </small>
        </article>
      </div>
      <div className="eval-grid">
        <section className="suite-card">
          <div className="card-title">
            <div>
              <h3>Order Agent suite</h3>
              <p>
                {selectedRun?.status === 'running'
                  ? 'Running live checks…'
                  : '5 behavioral checks'}
              </p>
            </div>
            <span className={`status-pill ${selectedRun?.status}`}>
              {selectedRun?.status || 'queued'}
            </span>
          </div>
          <div className="case-list">
            {(selectedRun?.results || []).map((result) => (
              <button
                className={
                  selectedCase === result.name
                    ? 'case-row selected'
                    : 'case-row'
                }
                key={result.name}
                onClick={() => onSelectCase(result.name)}
              >
                <span className={`case-status ${result.status}`}>
                  {result.status === 'passed' ? '✓' : '!'}
                </span>
                <div>
                  <strong>{result.label}</strong>
                  <code>{result.name}</code>
                </div>
                <time>{formatDuration(result.durationMs)}</time>
                <span className="chevron">›</span>
              </button>
            ))}
            {selectedRun?.status === 'running' &&
              Array.from(
                { length: Math.max(0, 5 - selectedRun.results.length) },
                (_, index) => (
                  <div className="case-row pending" key={index}>
                    <span className="case-status">·</span>
                    <div>
                      <strong>Waiting for agent</strong>
                      <code>queued check</code>
                    </div>
                  </div>
                ),
              )}
          </div>
          {apiState !== 'ready' && (
            <div className="preview-callout">
              <strong>Preview data</strong>
              <span>
                Start the API to run the suite against your configured model.
              </span>
              <button onClick={onRun}>Try connection</button>
            </div>
          )}
        </section>
        <aside className="case-detail">
          <div className="card-title">
            <div>
              <p className="eyebrow">CASE DETAIL</p>
              <h3>{selectedResult?.label || 'Select a check'}</h3>
            </div>
            {selectedResult && (
              <span className={`status-pill ${selectedResult.status}`}>
                {selectedResult.status}
              </span>
            )}
          </div>
          {selectedResult && (
            <>
              <div className="assertion">
                <span>EXPECTED</span>
                <p>{selectedResult.expected}</p>
              </div>
              <div className="assertion actual">
                <span>ACTUAL</span>
                <p>{selectedResult.actual}</p>
              </div>
              <div className="detail-trace">
                <span>TRACE</span>
                {selectedResult.events.map((event, index) => (
                  <TraceRow
                    event={event}
                    last={index === selectedResult.events.length - 1}
                    key={event.id}
                  />
                ))}
              </div>
            </>
          )}
        </aside>
      </div>
      <section className="history">
        <div className="card-title">
          <div>
            <h3>Recent runs</h3>
            <p>Compare the latest evaluation attempts</p>
          </div>
        </div>
        <div className="history-list">
          {runs.map((run) => (
            <button
              key={run.id}
              onClick={() => onSelectRun(run)}
              className={
                run.id === selectedRun?.id
                  ? 'history-row active'
                  : 'history-row'
              }
            >
              <code>{run.id.slice(0, 8).toUpperCase()}</code>
              <span>
                {formatDate(run.createdAt)} · {formatTime(run.createdAt)}
              </span>
              <strong>
                {run.passed}/{Math.max(5, run.passed + run.failed)} passed
              </strong>
              <span className={`status-pill ${run.status}`}>{run.status}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
