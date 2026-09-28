import type { AppData, BlockDef, EnvValues, Flow, RunState, Settings, SkillRef } from "../../shared/types";

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
  getData: () => request<AppData>("GET", "/data"),
  saveBlocks: (blocks: BlockDef[]) => request("PUT", "/blocks", blocks),
  saveFlows: (flows: Flow[]) => request("PUT", "/flows", flows),
  saveSettings: (settings: Settings) => request("PUT", "/settings", settings),
  saveEnv: (env: EnvValues) => request("PUT", "/env", env),
  startRun: (flowId: string) => request<{ runId: string }>("POST", "/runs", { flowId }),
  getRun: (id: string) => request<RunState>("GET", `/runs/${encodeURIComponent(id)}`),
  answer: (id: string, answer: string) => request("POST", `/runs/${encodeURIComponent(id)}/answer`, { answer }),
  listSkills: () => request<SkillRef[]>("GET", "/skills"),
  uploadSkill: (name: string, files: { path: string; content: string }[]) =>
    request<SkillRef>("POST", "/skills", { name, files }),
  cancel: (id: string) => request("POST", `/runs/${encodeURIComponent(id)}/cancel`, {}),
};

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
