// /api/* request handler, mounted inside the Vite dev/preview server (see vite.config.ts) — no separate server.

import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ENV_NAME_RE, resolveNode } from "../shared/resolve";
import { validateSettings } from "../shared/settings";
import { missingInputs, validateBlocks } from "../shared/validate";
import type { AppData, AssistantAgent, BlockDef, Chat, DataChange, EnvValues, Flow, RunState, Settings, TriggerEvent } from "../shared/types";
import { createChatService, type AssistantRunner } from "./chats";
import { startRun, type NodeRunner, type RunHandle } from "./engine";
import { createMcp } from "./mcp";
import { execCli, importSandboxImage, sandboxImageStatus, type Exec } from "./sandbox";
import { createSkillStore, type SkillFile } from "./skills";
import { settleInterrupted, summarize, type Storage } from "./storage";
import { createTriggerService, type FireOutcome } from "./triggers";
import { startWebhookServer, type WebhookServer } from "./webhooks";

type Next = (err?: unknown) => void;
type Handler = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: object) {
    super(message);
  }
}

const MAX_BODY = 5 * 1024 * 1024;

async function readJson<T>(req: IncomingMessage): Promise<T> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Body too large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") as T;
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export type Api = Handler & { shutdown(timeoutMs?: number): Promise<void> };

export function createApi(
  storage: Storage,
  runners: { auto: NodeRunner; ai: NodeRunner },
  opts: { bundledSkillsDir?: string; exec?: Exec; assistant?: AssistantRunner } = {},
): Api {
  const skills = createSkillStore(storage.dir, opts.bundledSkillsDir);
  const exec = opts.exec ?? execCli;
  const runs = new Map<string, RunHandle>();
  const listeners = new Map<string, Set<(s: RunState) => void>>();

  // ---------- data revisions (UI ↔ assistant edits) ----------

  /** Bumped on every flows/blocks write. The UI sends the rev it last saw; a stale write gets 409. */
  let rev = 0;
  const dataListeners = new Set<(c: DataChange) => void>();
  function changed(c: Omit<DataChange, "rev">) {
    rev++;
    dataListeners.forEach((fn) => fn({ rev, ...c }));
  }
  function checkRev(url: URL) {
    const seen = url.searchParams.get("rev");
    if (seen !== null && Number(seen) !== rev) {
      throw new HttpError(409, "The flow was changed by the assistant since you last loaded it", { rev });
    }
  }

  const mcp = createMcp({
    load: storage.load,
    saveFlows(flows, c) {
      storage.saveFlows(flows);
      syncTriggers();
      changed({ source: "assistant", ...c });
    },
    saveBlocks(blocks) {
      storage.saveBlocks(blocks);
      syncTriggers();
      changed({ source: "assistant" });
    },
  });
  const chats = createChatService({ dir: storage.dir, load: storage.load, mcp, runner: opts.assistant });

  /** Where agents reach the MCP server — derived from the Host we're being called on (random port in the desktop app). */
  let mcpUrl = "";
  function noteHost(host: string | undefined) {
    if (!host || !/^[\w.-]+:\d+$|^[\w.-]+$/.test(host)) return;
    const url = `http://${host}/api/mcp`;
    if (url === mcpUrl) return;
    mcpUrl = url;
    try {
      fs.writeFileSync(path.join(storage.dir, "mcp.json"), JSON.stringify({ mcpServers: { sandflow: { type: "http", url } } }, null, 2));
    } catch {
      /* informational only */
    }
  }

  /** Start a run (manual, or fired by a trigger node). */
  function launch(
    flow: Flow,
    data: AppData,
    extra: { trigger?: TriggerEvent; startNodeId?: string; prompt?: string } = {},
  ): RunHandle {
    let lastSave = 0;
    const handle = startRun({
      flow,
      blocks: data.blocks,
      env: data.env,
      settings: data.settings,
      runners,
      logRoot: path.join(storage.dir, "runs"),
      saveArtifact: storage.saveArtifact,
      loadSkill: skills.read,
      ...extra,
      onChange: (s) => {
        listeners.get(s.id)?.forEach((fn) => fn(s));
        if (s.finishedAt || Date.now() - lastSave > 2000) {
          lastSave = Date.now();
          storage.saveRun(s);
        }
      },
    });
    runs.set(handle.state.id, handle);
    void handle.done.then((s) => {
      storage.saveRun(s);
      setTimeout(() => runs.delete(s.id), 10 * 60_000).unref?.();
      drainQueue(s.flowId);
    });
    return handle;
  }

  // ---------- triggers ----------

  /** Triggered runs waiting because their flow is busy (overlap: queue). */
  const queues = new Map<string, { nodeId: string; event: TriggerEvent }[]>();
  const MAX_QUEUE = 50;
  const flowBusy = (flowId: string) => [...runs.values()].some((h) => h.state.flowId === flowId && !h.state.finishedAt);

  function startTriggered(flowId: string, nodeId: string, event: TriggerEvent): FireOutcome {
    const data = storage.load();
    const flow = data.flows.find((f) => f.id === flowId);
    if (!flow) return { status: "skipped", reason: "flow was deleted" };
    if (!flow.active) return { status: "skipped", reason: "flow is not active" };
    const missing = missingInputs(flow, data.blocks, data.env, data.settings.startingPrompt);
    if (missing.length) return { status: "skipped", reason: `missing inputs: ${missing.join(", ")}` };
    return { status: "started", runId: launch(flow, data, { trigger: event, startNodeId: nodeId }).state.id };
  }

  function fireTrigger(flow: Flow, nodeId: string, event: TriggerEvent): FireOutcome {
    if (!flowBusy(flow.id)) return startTriggered(flow.id, nodeId, event);
    const data = storage.load();
    const node = flow.nodes.find((n) => n.id === nodeId);
    let overlap: "queue" | "skip" = "queue";
    try {
      if (node) overlap = resolveNode(node, data.blocks).trigger.overlap ?? "queue";
    } catch {
      /* default */
    }
    if (overlap === "skip") return { status: "skipped", reason: "flow is already running (overlap: skip)" };
    const q = queues.get(flow.id) ?? [];
    if (q.length >= MAX_QUEUE) return { status: "skipped", reason: `queue is full (${MAX_QUEUE})` };
    q.push({ nodeId, event });
    queues.set(flow.id, q);
    return { status: "queued" };
  }

  function drainQueue(flowId: string) {
    const q = queues.get(flowId);
    while (q?.length && !flowBusy(flowId)) {
      const next = q.shift()!;
      const outcome = startTriggered(flowId, next.nodeId, next.event);
      if (outcome.status !== "started") console.warn(`[trigger] queued ${next.event.type} skipped: ${"reason" in outcome ? outcome.reason : ""}`);
    }
    if (q && !q.length) queues.delete(flowId);
  }

  const triggers = createTriggerService({
    load: storage.load,
    fire: fireTrigger,
    exec,
    statePath: path.join(storage.dir, "triggers-state.json"),
  });

  // Webhook listener: its own port, only when enabled in Settings.
  let webhookServer: WebhookServer | undefined;
  let webhookKey = "";
  let webhookError: string | undefined;
  async function syncWebhooks() {
    const w = storage.load().settings.webhooks;
    const key = w?.enabled ? `${w.host}:${w.port}` : "";
    if (key === webhookKey) return;
    webhookKey = key;
    await webhookServer?.close();
    webhookServer = undefined;
    webhookError = undefined;
    if (!w?.enabled) return;
    // Retry briefly: after a dev-server restart the previous listener may still be releasing the port.
    for (let attempt = 1; ; attempt++) {
      try {
        webhookServer = await startWebhookServer(w.host, w.port, triggers.handleWebhook);
        return;
      } catch (e) {
        const busy = (e as NodeJS.ErrnoException).code === "EADDRINUSE";
        if (busy && attempt < 10 && webhookKey === key) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        webhookError = `Couldn't listen on ${w.host}:${w.port}: ${(e as Error).message}`;
        console.warn(`[webhooks] ${webhookError}`);
        return;
      }
    }
  }
  function webhookInfo() {
    const w = storage.load().settings.webhooks;
    const base = w?.publicUrl?.trim().replace(/\/+$/, "") || (webhookServer ? `http://${w?.host === "0.0.0.0" ? "<this-machine>" : w?.host}:${webhookServer.port}` : undefined);
    return { enabled: !!w?.enabled, listening: !!webhookServer, port: webhookServer?.port, baseUrl: base, error: webhookError };
  }
  function syncTriggers() {
    triggers.sync();
    void syncWebhooks();
  }
  syncTriggers();

  function getRun(id: string): RunState {
    const live = runs.get(id)?.state;
    if (live) return live;
    const saved = storage.loadRun(id);
    if (!saved) throw new HttpError(404, "Run not found");
    return settleInterrupted(saved);
  }

  function getChat(id: string): Chat {
    let chat: Chat | undefined;
    try {
      chat = chats.get(id);
    } catch {
      /* invalid id */
    }
    if (!chat) throw new HttpError(404, "Chat not found");
    return chat;
  }

  async function handle(req: IncomingMessage, res: ServerResponse, next: Next) {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith("/api/")) return next();
    const parts = url.pathname.slice(5).split("/").filter(Boolean);
    const method = req.method ?? "GET";
    // Writes must be JSON: cross-site pages can only send JSON after a CORS preflight, which Vite rejects.
    if (method !== "GET" && !req.headers["content-type"]?.startsWith("application/json")) {
      throw new HttpError(415, "Content-Type must be application/json");
    }
    const route = `${method} /${parts.map((p, i) => ((parts[0] === "runs" || parts[0] === "chats") && i === 1 ? ":id" : p)).join("/")}`;
    noteHost(req.headers.host);

    switch (route) {
      case "GET /data":
        return send(res, 200, { ...storage.load(), rev });

      case "GET /data/events": {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const push = (c: DataChange) => res.write(`event: change\ndata: ${JSON.stringify(c)}\n\n`);
        push({ rev, source: "ui" });
        dataListeners.add(push);
        const beat = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(beat);
          dataListeners.delete(push);
        });
        return;
      }

      case "PUT /blocks": {
        const blocks = await readJson<BlockDef[]>(req);
        if (!Array.isArray(blocks)) throw new HttpError(400, "Expected an array of blocks");
        checkRev(url);
        const errors = validateBlocks(blocks);
        if (errors.length) throw new HttpError(400, errors[0], { errors });
        storage.saveBlocks(blocks);
        syncTriggers();
        changed({ source: "ui" });
        return send(res, 200, { ok: true, rev });
      }

      case "PUT /flows": {
        const flows = await readJson<Flow[]>(req);
        if (!Array.isArray(flows)) throw new HttpError(400, "Expected an array of flows");
        checkRev(url);
        storage.saveFlows(flows);
        syncTriggers();
        changed({ source: "ui" });
        return send(res, 200, { ok: true, rev });
      }

      // ---------- MCP (agents) ----------

      case "POST /mcp": {
        const chatId = url.searchParams.get("chat");
        const out = mcp.handle(await readJson<unknown>(req), {
          scope: url.searchParams.get("flow") || undefined,
          // Calls from an in-app chat's agent show up in that chat.
          onCall: chatId ? (c) => chats.record(chatId, c) : undefined,
        });
        if (out === undefined) {
          res.statusCode = 202;
          return res.end();
        }
        return send(res, 200, out);
      }

      case "GET /mcp":
        res.setHeader("allow", "POST");
        throw new HttpError(405, "This MCP server only answers POST (no server-sent stream)");

      // ---------- "Edit with AI" chats ----------

      case "GET /chats": {
        const flowId = url.searchParams.get("flowId");
        if (!flowId) throw new HttpError(400, "flowId is required");
        return send(res, 200, chats.list(flowId));
      }

      case "POST /chats": {
        const { flowId, agent } = (await readJson<{ flowId?: string; agent?: AssistantAgent }>(req)) ?? {};
        try {
          return send(res, 200, chats.create(String(flowId ?? ""), agent));
        } catch (e) {
          throw new HttpError((e as Error).message === "Flow not found" ? 404 : 400, (e as Error).message);
        }
      }

      case "PATCH /chats/:id": {
        const { agent } = (await readJson<{ agent?: AssistantAgent }>(req)) ?? {};
        getChat(parts[1]);
        try {
          const chat = chats.setAgent(parts[1], agent as AssistantAgent);
          return send(res, 200, { ...chat, running: chats.running(chat.id) });
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }

      case "GET /chats/:id": {
        const chat = parts.length === 2 ? getChat(parts[1]) : undefined;
        if (chat) return send(res, 200, { ...chat, running: chats.running(chat.id) });
        break;
      }

      case "DELETE /chats/:id":
        getChat(parts[1]);
        chats.remove(parts[1]);
        return send(res, 200, { ok: true });

      case "POST /chats/:id/messages": {
        const { text } = (await readJson<{ text?: string }>(req)) ?? {};
        getChat(parts[1]);
        const r = chats.send(parts[1], String(text ?? ""), mcpUrl || `http://${req.headers.host}/api/mcp`);
        if (r.error) throw new HttpError(r.status ?? 400, r.error);
        return send(res, 200, { ok: true });
      }

      case "POST /chats/:id/cancel":
        return send(res, 200, { ok: chats.cancel(parts[1]) });

      case "GET /chats/:id/events": {
        const chat = getChat(parts[1]);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const push = (c: Chat) => res.write(`event: chat\ndata: ${JSON.stringify({ ...c, running: chats.running(c.id) })}\n\n`);
        push(chat);
        const off = chats.subscribe(chat.id, push);
        const beat = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(beat);
          off();
        });
        return;
      }

      case "PUT /settings": {
        const s = await readJson<Settings>(req);
        try {
          storage.saveSettings(validateSettings(s));
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
        syncTriggers();
        return send(res, 200, { ok: true });
      }

      case "GET /sandbox/status":
        return send(res, 200, await sandboxImageStatus(storage.load().settings, exec));

      case "POST /sandbox/import": {
        const { path: file } = (await readJson<{ path?: string }>(req)) ?? {};
        try {
          return send(res, 200, { output: await importSandboxImage(storage.load().settings, String(file ?? ""), exec) });
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }

      case "PUT /env": {
        const env = await readJson<EnvValues>(req);
        if (!env || typeof env !== "object" || Array.isArray(env)) throw new HttpError(400, "Expected an object");
        const bad = Object.keys(env).filter((k) => !ENV_NAME_RE.test(k));
        if (bad.length) throw new HttpError(400, `Invalid env var name: ${bad.join(", ")}`);
        storage.saveEnv(Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])));
        return send(res, 200, { ok: true });
      }

      case "POST /runs": {
        // `prompt` (optional) is this run's starting prompt; without it the global one is used.
        const body = (await readJson<{ flowId?: string; prompt?: string }>(req)) ?? {};
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : undefined;
        const data = storage.load();
        const flow = data.flows.find((f) => f.id === body.flowId);
        if (!flow) throw new HttpError(404, "Flow not found");
        const missing = missingInputs(flow, data.blocks, data.env, prompt ?? data.settings.startingPrompt);
        if (missing.length) throw new HttpError(400, `Missing inputs: ${missing.join(", ")}`, { missing });
        return send(res, 200, { runId: launch(flow, data, { prompt }).state.id });
      }

      case "GET /runs": {
        const live = [...runs.values()].map((h) => summarize(h.state));
        const liveIds = new Set(live.map((r) => r.id));
        const saved = storage.listRuns(50).filter((r) => !liveIds.has(r.id));
        const all = [...live, ...saved].sort((a, b) => b.startedAt - a.startedAt).slice(0, 50);
        return send(res, 200, all);
      }

      case "GET /triggers":
        return send(res, 200, {
          triggers: triggers.status(),
          log: triggers.log().slice(0, 100),
          webhooks: webhookInfo(),
          queued: Object.fromEntries([...queues].map(([k, q]) => [k, q.length])),
        });

      case "GET /skills":
        return send(res, 200, await skills.list());

      case "POST /skills": {
        const body = await readJson<{ name?: string; files?: SkillFile[] }>(req);
        try {
          return send(res, 200, await skills.save(String(body?.name ?? ""), body?.files ?? []));
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }

      case "GET /runs/:id":
        if (parts.length === 2) return send(res, 200, getRun(parts[1]));
        break;

      case "GET /runs/:id/events": {
        const state = getRun(parts[1]);
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const push = (s: RunState) => res.write(`event: state\ndata: ${JSON.stringify(s)}\n\n`);
        push(state);
        if (state.finishedAt) return res.end();
        let set = listeners.get(state.id);
        if (!set) listeners.set(state.id, (set = new Set()));
        const fn = (s: RunState) => {
          push(s);
          if (s.finishedAt) res.end();
        };
        set.add(fn);
        const beat = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(beat);
          set!.delete(fn);
        });
        return;
      }

      case "POST /runs/:id/answer": {
        const h = runs.get(parts[1]);
        const { answer } = (await readJson<{ answer?: string }>(req)) ?? {};
        if (!h || !h.answer(String(answer ?? ""))) throw new HttpError(409, "No pending question");
        return send(res, 200, { ok: true });
      }

      case "POST /runs/:id/cancel": {
        const h = runs.get(parts[1]);
        if (!h) throw new HttpError(404, "Run not active");
        h.cancel();
        return send(res, 200, { ok: true });
      }
    }
    throw new HttpError(404, `No route ${method} ${url.pathname}`);
  }

  const handler: Api = (req, res, next) => {
    handle(req, res, next).catch((e) => {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) send(res, e.status, { error: e.message, ...e.extra });
      else send(res, 500, { error: (e as Error).message });
    });
  };
  /** Cancel every active run and wait (bounded) for its cleanup — sandboxes/containers get closed. */
  handler.shutdown = async (timeoutMs = 15_000) => {
    triggers.stop();
    queues.clear();
    await chats.shutdown();
    await webhookServer?.close();
    webhookServer = undefined;
    const active = [...runs.values()].filter((h) => !h.state.finishedAt);
    active.forEach((h) => h.cancel());
    await Promise.race([
      Promise.allSettled(active.map((h) => h.done)),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
    for (const h of active) storage.saveRun(h.state);
  };
  return handler;
}
