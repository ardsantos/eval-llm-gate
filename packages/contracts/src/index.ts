export type RunStatus = 'queued' | 'running' | 'passed' | 'failed';

export interface TraceEvent {
  id: string;
  kind: 'agent' | 'tool_call' | 'tool_result' | 'response' | 'error';
  label: string;
  detail: string;
  elapsedMs: number;
  payload?: unknown;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  body: string;
  createdAt: string;
}

export interface ChatResponse {
  sessionId: string;
  status: 'completed' | 'confirmation_required';
  message: ChatMessage;
  durationMs: number;
  events: TraceEvent[];
}

export interface ModelsResponse {
  defaultModel: string;
  models: string[];
}

export interface EvalCaseResult {
  name: string;
  label: string;
  status: 'passed' | 'failed';
  durationMs: number;
  expected: string;
  actual: string;
  events: TraceEvent[];
}

export interface EvalRun {
  id: string;
  model: string;
  status: RunStatus;
  createdAt: string;
  completedAt?: string;
  passed: number;
  failed: number;
  results: EvalCaseResult[];
}

export interface ApiError {
  error: string;
}
