import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApi, type Api } from "../backend/api";
import type { NodeRunner } from "../backend/engine";
import { createStorage } from "../backend/storage";
import { EXAMPLE_FLOWS } from "../shared/library";
import type { Flow, RunState, RunSummary } from "../shared/types";

let dir: string;
let server: Server;
let api: Api;
let base: string;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

async function start(runner: NodeRunner) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-apitrig-"));
  api = createApi(createStorage(dir), { auto: runner, ai: runner });
  server = createServer((req, res) => api(req, res, () => ((res.statusCode = 404), res.end())));
  server.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}
const put = (p: string, body: unknown) =>
  fetch(`${base}${p}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

afterEach(async () => {
  await api?.shutdown(1000);
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const note = (author: string, body: string) =>
  JSON.stringify({
    object_kind: "note",
    user: { username: author },
    project: { path_with_namespace: "grp/app", web_url: "https://gitlab.corp.local/grp/app" },
    object_attributes: { note: body, noteable_type: "MergeRequest", url: "https://gitlab.corp.local/grp/app/-/merge_requests/9" },
    merge_request: { iid: 9, title: "Refactor" },
  });

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function configure(port: number, active = true) {
  const flow: Flow = { ...structuredClone(EXAMPLE_FLOWS[0]), active };
  const cond = flow.nodes.find((n) => n.id === "if")!.data.overrides!.condition!;
  cond.rules[1].value = "ofek";
  await put("/env", { GITLAB_WEBHOOK_SECRET: "tok", REPO_PATH: "/r", ANTHROPIC_API_KEY: "k" });
  await put("/settings", { startingPrompt: "", sandbox: "none", maxSteps: 40, webhooks: { enabled: true, host: "127.0.0.1", port } });
  await put("/flows", [flow]);
  return flow;
}

describe("triggers through the API", () => {
  it("MR comment by the right user with the magic word → answer → post comment", async () => {
    const ran: string[] = [];
    await start(async (ctx, node) => {
      ran.push(node.id);
      expect(ctx.run.trigger?.author).toBe("ofek");
      return { outputs: { artifact: node.id === "answer" ? "Here is the answer" : "posted" } };
    });
    const port = await freePort();
    const flow = await configure(port);
    const hook = `http://127.0.0.1:${port}/hooks/gitlab/${flow.id}/t`;
    await waitFor(async () => ((await (await fetch(`${base}/triggers`)).json()).webhooks.listening ? true : undefined));

    const res = await fetch(hook, { method: "POST", headers: { "x-gitlab-token": "tok" }, body: note("ofek", "@sandflow what does this do?") });
    expect(res.status).toBe(202);
    const summary = await waitFor(async () => {
      const list = (await (await fetch(`${base}/runs`)).json()) as RunSummary[];
      return list.find((r) => r.finishedAt);
    });
    expect(summary).toMatchObject({ status: "done", trigger: { source: "gitlab", type: "merge_request.comment", author: "ofek" } });
    const run = (await (await fetch(`${base}/runs/${summary.id}`)).json()) as RunState;
    expect(run.nodes.if.branch).toBe("true");
    expect(ran).toEqual(["answer", "post"]);

    // Wrong user: the run happens but stops at the If (false branch is unconnected).
    await fetch(hook, { method: "POST", headers: { "x-gitlab-token": "tok" }, body: note("mallory", "@sandflow hi") });
    await waitFor(async () => {
      const list = (await (await fetch(`${base}/runs`)).json()) as RunSummary[];
      return list.filter((r) => r.finishedAt).length === 2 ? true : undefined;
    });
    expect(ran).toEqual(["answer", "post"]);
  });

  it("queues events while the flow is busy, and skips inactive flows", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let answers = 0;
    await start(async (_ctx, node) => {
      if (node.id === "answer") {
        answers++;
        await gate;
      }
      return { outputs: { artifact: "x" } };
    });
    const port = await freePort();
    const flow = await configure(port);
    const hook = `http://127.0.0.1:${port}/hooks/gitlab/${flow.id}/t`;
    await waitFor(async () => ((await (await fetch(`${base}/triggers`)).json()).webhooks.listening ? true : undefined));
    const send = () => fetch(hook, { method: "POST", headers: { "x-gitlab-token": "tok" }, body: note("ofek", "@sandflow q") });

    expect(await (await send()).text()).toBe("started");
    expect(await (await send()).text()).toBe("queued");
    const t = await (await fetch(`${base}/triggers`)).json();
    expect(t.queued[flow.id]).toBe(1);
    expect(t.triggers[0]).toMatchObject({ type: "gitlab", mode: "webhook", webhookPath: `/hooks/gitlab/${flow.id}/t` });
    release();
    await waitFor(async () => {
      const list = (await (await fetch(`${base}/runs`)).json()) as RunSummary[];
      return list.filter((r) => r.status === "done").length === 2 ? true : undefined;
    });
    expect(answers).toBe(2);

    // Deactivate: the webhook route disappears.
    await put("/flows", [{ ...flow, active: false }]);
    expect((await send()).status).toBe(404);
  });
});
