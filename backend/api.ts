// /api/* request handler, mounted inside the Vite dev/preview server (see vite.config.ts) — no separate server.

import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { ENV_NAME_RE } from "../shared/resolve";
import { validateSettings } from "../shared/settings";
import { missingInputs, validateBlocks } from "../shared/validate";
import type { BlockDef, EnvValues, Flow, RunState, Settings } from "../shared/types";
import { startRun, type NodeRunner, type RunHandle } from "./engine";
import { execCli, importSandboxImage, sandboxImageStatus, type Exec } from "./sandbox";
import { createSkillStore, type SkillFile } from "./skills";
import type { Storage } from "./storage";

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
  opts: { bundledSkillsDir?: string; exec?: Exec } = {},
): Api {
  const skills = createSkillStore(storage.dir, opts.bundledSkillsDir);
  const exec = opts.exec ?? execCli;
  const runs = new Map<string, RunHandle>();
  const listeners = new Map<string, Set<(s: RunState) => void>>();

  function getRun(id: string): RunState {
    const r = runs.get(id)?.state ?? storage.loadRun(id);
    if (!r) throw new HttpError(404, "Run not found");
    return r;
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
    const route = `${method} /${parts.map((p, i) => (parts[0] === "runs" && i === 1 ? ":id" : p)).join("/")}`;

    switch (route) {
      case "GET /data":
        return send(res, 200, storage.load());

      case "PUT /blocks": {
        const blocks = await readJson<BlockDef[]>(req);
        if (!Array.isArray(blocks)) throw new HttpError(400, "Expected an array of blocks");
        const errors = validateBlocks(blocks);
        if (errors.length) throw new HttpError(400, errors[0], { errors });
        storage.saveBlocks(blocks);
        return send(res, 200, { ok: true });
      }

      case "PUT /flows": {
        const flows = await readJson<Flow[]>(req);
        if (!Array.isArray(flows)) throw new HttpError(400, "Expected an array of flows");
        storage.saveFlows(flows);
        return send(res, 200, { ok: true });
      }

      case "PUT /settings": {
        const s = await readJson<Settings>(req);
        try {
          storage.saveSettings(validateSettings(s));
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
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
        const { flowId } = (await readJson<{ flowId?: string }>(req)) ?? {};
        const data = storage.load();
        const flow = data.flows.find((f) => f.id === flowId);
        if (!flow) throw new HttpError(404, "Flow not found");
        const missing = missingInputs(flow, data.blocks, data.env, data.settings.startingPrompt);
        if (missing.length) throw new HttpError(400, `Missing inputs: ${missing.join(", ")}`, { missing });
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
          setTimeout(() => runs.delete(s.id), 10 * 60_000);
        });
        return send(res, 200, { runId: handle.state.id });
      }

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
