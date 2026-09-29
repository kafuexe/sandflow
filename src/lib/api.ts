import type { AppData, AssistantAgent, BlockDef, Chat, ChatSummary, DataChange, EnvValues, Flow, RunState, RunSummary, Settings, SkillRef } from "../../shared/types";

export interface TriggerStatusRow {
  flowId: string;
  flowName: string;
  nodeId: string;
  label: string;
  type: string;
  mode?: "webhook" | "poll";
  nextRun?: number;
  webhookPath?: string;
  lastFired?: number;
  lastPoll?: number;
  lastError?: string;
}

export interface TriggersInfo {
  triggers: TriggerStatusRow[];
  log: { ts: number; flowId: string; nodeId: string; level: "info" | "warn" | "error"; msg: string }[];
  webhooks: { enabled: boolean; listening: boolean; port?: number; baseUrl?: string; error?: string };
  queued: Record<string, number>;
}

export type LiveChat = Chat & { running: boolean };

export class ApiError extends Error {
  constructor(message: string, public status: number, public body: Record<string, unknown>) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(String(data.error ?? res.statusText), res.status, data);
  return data as T;
}

export const api = {
  getData: () => request<AppData & { rev: number }>("GET", "/data"),
  saveBlocks: (blocks: BlockDef[], rev: number) => request<{ rev: number }>("PUT", `/blocks?rev=${rev}`, blocks),
  saveFlows: (flows: Flow[], rev: number) => request<{ rev: number }>("PUT", `/flows?rev=${rev}`, flows),
  listChats: (flowId: string) => request<ChatSummary[]>("GET", `/chats?flowId=${encodeURIComponent(flowId)}`),
  createChat: (flowId: string, agent: AssistantAgent) => request<Chat>("POST", "/chats", { flowId, agent }),
  setChatAgent: (id: string, agent: AssistantAgent) => request<LiveChat>("PATCH", `/chats/${encodeURIComponent(id)}`, { agent }),
  deleteChat: (id: string) => request("DELETE", `/chats/${encodeURIComponent(id)}`, {}),
  sendChat: (id: string, text: string) => request("POST", `/chats/${encodeURIComponent(id)}/messages`, { text }),
  cancelChat: (id: string) => request("POST", `/chats/${encodeURIComponent(id)}/cancel`, {}),
  saveSettings: (settings: Settings) => request("PUT", "/settings", settings),
  saveEnv: (env: EnvValues) => request("PUT", "/env", env),
  /** `prompt` overrides the global starting prompt for this run only. */
  startRun: (flowId: string, prompt?: string) => request<{ runId: string }>("POST", "/runs", { flowId, prompt }),
  getRun: (id: string) => request<RunState>("GET", `/runs/${encodeURIComponent(id)}`),
  answer: (id: string, answer: string) => request("POST", `/runs/${encodeURIComponent(id)}/answer`, { answer }),
  sandboxStatus: () =>
    request<{ runtime: string; runtimeAvailable: boolean; image: string; imagePresent: boolean }>("GET", "/sandbox/status"),
  importSandbox: (path: string) => request<{ output: string }>("POST", "/sandbox/import", { path }),
  listSkills: () => request<SkillRef[]>("GET", "/skills"),
  uploadSkill: (name: string, files: { path: string; content: string }[]) =>
    request<SkillRef>("POST", "/skills", { name, files }),
  listRuns: () => request<RunSummary[]>("GET", "/runs"),
  triggers: () => request<TriggersInfo>("GET", "/triggers"),
  cancel: (id: string) => request("POST", `/runs/${encodeURIComponent(id)}/cancel`, {}),
};

/** Flows/blocks changed on the server (e.g. by the assistant). */
export function subscribeData(onChange: (c: DataChange) => void): () => void {
  const es = new EventSource("/api/data/events");
  es.addEventListener("change", (ev) => onChange(JSON.parse((ev as MessageEvent).data) as DataChange));
  return () => es.close();
}

/** Live chat state (streams while the assistant answers). */
export function subscribeChat(id: string, onChat: (c: LiveChat) => void): () => void {
  const es = new EventSource(`/api/chats/${encodeURIComponent(id)}/events`);
  es.addEventListener("chat", (ev) => onChat(JSON.parse((ev as MessageEvent).data) as LiveChat));
  return () => es.close();
}

/** Subscribe to live run state; returns an unsubscribe function. */
export function subscribeRun(runId: string, onState: (s: RunState) => void): () => void {
  const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
  es.addEventListener("state", (ev) => {
    const s = JSON.parse((ev as MessageEvent).data) as RunState;
    onState(s);
    if (s.finishedAt) es.close();
  });
  return () => es.close();
}
