import type {
  AppData,
  AssistantAgent,
  BlockDef,
  Chat,
  ChatSummary,
  DataChange,
  EnvValues,
  Flow,
  PackInfo,
  PackManifest,
  PackPreview,
  RunFlag,
  RunState,
  RunSummary,
  Settings,
  SkillRef,
  SteerRecord,
} from "../../shared/types";

/** What to stage a pack from. */
export type PackFrom =
  | { url: string }
  | { folder: string; link: boolean }
  | { zipName: string; zipBase64: string }
  | { zipPath: string }
  | { update: string };

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
  startRun: (flowId: string, prompt?: string) => request<{ runId: string; warning?: string }>("POST", "/runs", { flowId, prompt }),
  getRun: (id: string) => request<RunState>("GET", `/runs/${encodeURIComponent(id)}`),
  answer: (id: string, answer: string) => request("POST", `/runs/${encodeURIComponent(id)}/answer`, { answer }),
  /** Send a steering message to a running agent node (node keys of subflow nodes contain "/"). */
  steer: (id: string, nodeKey: string, message: string) =>
    request<{ ok: true; steer: SteerRecord }>("POST", `/runs/${encodeURIComponent(id)}/nodes/${encodeURIComponent(nodeKey)}/steer`, { message }),
  sandboxStatus: () =>
    request<{ runtime: string; runtimeAvailable: boolean; image: string; imagePresent: boolean; bundled: boolean }>(
      "GET",
      "/sandbox/status",
    ),
  /** Empty path = the bundle shipped with the app. */
  importSandbox: (path: string) => request<{ output: string }>("POST", "/sandbox/import", { path }),
  listSkills: () => request<SkillRef[]>("GET", "/skills"),
  uploadSkill: (name: string, files: { path: string; content: string }[]) =>
    request<SkillRef>("POST", "/skills", { name, files }),
  listPacks: () => request<PackInfo[]>("GET", "/packs"),
  previewPack: (from: PackFrom) => request<PackPreview>("POST", "/packs/preview", from),
  installPack: (token: string, o: { trustHost: boolean; replace: boolean }) => request<PackInfo>("POST", "/packs/install", { token, ...o }),
  removePack: (id: string) => request("DELETE", `/packs/${encodeURIComponent(id)}`, {}),
  setPackTrust: (id: string, trustHost: boolean) => request("POST", `/packs/${encodeURIComponent(id)}/trust`, { trustHost }),
  reloadPack: (id: string) => request("POST", `/packs/${encodeURIComponent(id)}/reload`, {}),
  exportPack: (body: { manifest: PackManifest; blockIds: string[]; flowIds: string[]; folder?: string }) =>
    request<{ fileName?: string; zipBase64?: string; folder?: string; fileCount: number }>("POST", "/packs/export", body),
  listRuns: () => request<RunSummary[]>("GET", "/runs"),
  triggers: () => request<TriggersInfo>("GET", "/triggers"),
  cancel: (id: string) => request("POST", `/runs/${encodeURIComponent(id)}/cancel`, {}),
  dismissFlag: (runId: string, flagId: string) =>
    request("POST", `/runs/${encodeURIComponent(runId)}/flags/${encodeURIComponent(flagId)}/dismiss`, {}),
};

/** A flag raised on a top-level run (flags from stack tasks arrive as copies on their top-level run). */
export interface FlagEvent {
  runId: string;
  runTitle: string;
  flowName: string;
  flag: RunFlag;
}

/**
 * One connection to /api/data/events for the whole app, however many subscribe: each EventSource holds one of the
 * browser's ~6 connections per host. Closed when the last subscriber leaves.
 */
let dataEvents: EventSource | undefined;
let dataSubscribers = 0;
/** The latest change event, replayed to a subscriber that joins an open connection (it missed the initial one). */
let lastChange: DataChange | undefined;

function onDataEvents(listeners: Record<string, (ev: MessageEvent) => void>): () => void {
  if (!dataEvents) {
    dataEvents = new EventSource("/api/data/events");
    lastChange = undefined;
    dataEvents.addEventListener("change", (ev) => (lastChange = JSON.parse((ev as MessageEvent).data) as DataChange));
  }
  const es = dataEvents;
  dataSubscribers++;
  for (const [type, fn] of Object.entries(listeners)) es.addEventListener(type, fn as EventListener);
  return () => {
    for (const [type, fn] of Object.entries(listeners)) es.removeEventListener?.(type, fn as EventListener);
    if (--dataSubscribers === 0 && dataEvents === es) {
      es.close();
      dataEvents = undefined;
    }
  };
}

/** Flags raised and cleared anywhere, live. */
export function subscribeFlags(onFlag: (e: FlagEvent) => void, onDismissed: (e: { runId: string; flagId: string }) => void): () => void {
  return onDataEvents({
    flag: (ev) => onFlag(JSON.parse(ev.data) as FlagEvent),
    "flag-dismissed": (ev) => onDismissed(JSON.parse(ev.data) as { runId: string; flagId: string }),
  });
}

/**
 * Flows/blocks changed on the server (e.g. by the assistant). `initial` marks the server's current revision, sent
 * first on every (re)connect — after a server restart it can be lower than the one the client saw.
 */
export function subscribeData(onChange: (c: DataChange, initial: boolean) => void): () => void {
  let initial = true;
  let closed = false;
  const joined = lastChange;
  const unsubscribe = onDataEvents({
    open: () => (initial = true),
    change: (ev) => {
      const first = initial;
      initial = false;
      onChange(JSON.parse(ev.data) as DataChange, first);
    },
  });
  // Joined a connection that already delivered the initial revision: hand it over as this subscriber's initial one.
  if (joined)
    queueMicrotask(() => {
      if (closed || !initial) return;
      initial = false;
      onChange(joined, true);
    });
  return () => {
    closed = true;
    unsubscribe();
  };
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
