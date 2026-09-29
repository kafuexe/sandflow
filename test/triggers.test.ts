import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTriggerService, githubSignature, type FireOutcome } from "../backend/triggers";
import { startWebhookServer, type WebhookServer } from "../backend/webhooks";
import { BUILTIN_BLOCKS } from "../shared/library";
import type { AppData, BlockConfig, Flow, TriggerEvent } from "../shared/types";

function flowWith(trigger: BlockConfig["trigger"], blockId = "gitlab-trigger", active = true): Flow {
  return {
    id: "f1",
    name: "Flow 1",
    active,
    nodes: [
      { id: "t", type: "block", position: { x: 0, y: 0 }, data: { blockId, overrides: { trigger } } },
      { id: "s", type: "block", position: { x: 0, y: 0 }, data: { blockId: "shell" } },
    ],
    edges: [{ id: "e", source: "t", target: "s", sourceHandle: "artifact", targetHandle: "artifact" }],
  };
}

function setup(flow: Flow, env: Record<string, string> = {}, exec?: Parameters<typeof createTriggerService>[0]["exec"], statePath?: string) {
  const data: AppData = { blocks: BUILTIN_BLOCKS, flows: [flow], settings: { startingPrompt: "", sandbox: "none", maxSteps: 40 }, env };
  const fired: { nodeId: string; event: TriggerEvent }[] = [];
  const svc = createTriggerService({
    load: () => data,
    fire: (_f, nodeId, event): FireOutcome => (fired.push({ nodeId, event }), { status: "started", runId: `r${fired.length}` }),
    exec,
    statePath,
  });
  svc.sync();
  return { svc, fired, data };
}

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

describe("schedule triggers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 5, 9, 0, 30)); // local 09:00:30
  });

  it("fires on each interval and reports the next run", () => {
    const { svc, fired } = setup(
      flowWith({ type: "schedule", schedule: { kind: "interval", every: 1, unit: "minutes", start: "2026-01-05T00:00" } }, "schedule-trigger"),
    );
    expect(svc.status()[0].nextRun).toBe(new Date(2026, 0, 5, 9, 1).getTime());
    vi.advanceTimersByTime(30_000);
    expect(fired).toHaveLength(1);
    expect(fired[0].event).toMatchObject({ source: "schedule", type: "schedule" });
    vi.advanceTimersByTime(60_000 * 3);
    expect(fired).toHaveLength(4);
    expect(svc.log()[0].msg).toMatch(/started run/);
    svc.stop();
  });

  it("does not arm inactive flows, and disarms when a flow is deactivated", () => {
    const spec = { type: "schedule" as const, schedule: { kind: "interval" as const, every: 1, unit: "minutes" as const } };
    const inactive = setup(flowWith(spec, "schedule-trigger", false));
    expect(inactive.svc.status()).toEqual([]);

    const { svc, fired, data } = setup(flowWith(spec, "schedule-trigger"));
    expect(svc.status()).toHaveLength(1);
    data.flows[0] = { ...data.flows[0], active: false };
    svc.sync();
    vi.advanceTimersByTime(5 * 60_000);
    expect(fired).toHaveLength(0);
    expect(svc.status()).toEqual([]);
  });

  it("a one-off schedule in the past never fires", () => {
    const { svc, fired } = setup(flowWith({ type: "schedule", schedule: { kind: "once", at: "2025-01-01T00:00" } }, "schedule-trigger"));
    expect(svc.status()[0].nextRun).toBeUndefined();
    vi.advanceTimersByTime(24 * 3600_000);
    expect(fired).toHaveLength(0);
  });
});

describe("webhook triggers", () => {
  const ghBody = JSON.stringify({
    action: "created",
    repository: { full_name: "acme/app", html_url: "https://github.com/acme/app" },
    sender: { login: "bob" },
    issue: { number: 12, title: "t", pull_request: {} },
    comment: { body: "@sandflow ?", user: { login: "bob" } },
  });

  it("GitHub: verifies the HMAC signature, normalises and filters", () => {
    const { svc, fired } = setup(
      flowWith({ type: "github", mode: "webhook", events: ["merge_request.comment"], secretEnv: "GH_SECRET", repo: "acme/app" }, "github-trigger"),
      { GH_SECRET: "s3cret" },
    );
    const body = Buffer.from(ghBody);
    const ok = svc.handleWebhook("github", "f1", "t", { "x-github-event": "issue_comment", "x-hub-signature-256": githubSignature("s3cret", body) }, body);
    expect(ok.status).toBe(202);
    expect(fired[0].event).toMatchObject({ source: "github", type: "merge_request.comment", author: "bob", number: 12 });

    const bad = svc.handleWebhook("github", "f1", "t", { "x-github-event": "issue_comment", "x-hub-signature-256": "sha256=00" }, body);
    expect(bad.status).toBe(401);
    const ping = svc.handleWebhook("github", "f1", "t", { "x-github-event": "ping", "x-hub-signature-256": githubSignature("s3cret", "{}") }, Buffer.from("{}"));
    expect(ping).toEqual({ status: 200, message: "pong" });
    const issue = Buffer.from(JSON.stringify({ action: "opened", repository: { full_name: "acme/app" }, issue: { number: 1 } }));
    const ignored = svc.handleWebhook("github", "f1", "t", { "x-github-event": "issues", "x-hub-signature-256": githubSignature("s3cret", issue) }, issue);
    expect(ignored.message).toMatch(/ignored/i);
    expect(fired).toHaveLength(1);
  });

  it("GitHub: ignores events from another repository", () => {
    const { svc, fired } = setup(
      flowWith({ type: "github", mode: "webhook", secretEnv: "GH_SECRET", repo: "acme/other" }, "github-trigger"),
      { GH_SECRET: "s" },
    );
    const body = Buffer.from(ghBody);
    const r = svc.handleWebhook("github", "f1", "t", { "x-github-event": "issue_comment", "x-hub-signature-256": githubSignature("s", body) }, body);
    expect(r.message).toMatch(/repository/);
    expect(fired).toHaveLength(0);
  });

  it("GitLab: checks the secret token; rejects when no secret is configured or trigger isn't armed", () => {
    const note = Buffer.from(JSON.stringify({
      object_kind: "note", user: { username: "ofek" }, project: { path_with_namespace: "grp/app", web_url: "https://gl.corp/grp/app" },
      object_attributes: { note: "@sandflow hi", noteable_type: "MergeRequest" }, merge_request: { iid: 9 },
    }));
    const { svc, fired } = setup(flowWith({ type: "gitlab", mode: "webhook", secretEnv: "GL_SECRET" }), { GL_SECRET: "tok" });
    expect(svc.handleWebhook("gitlab", "f1", "t", { "x-gitlab-token": "tok" }, note).status).toBe(202);
    expect(fired[0].event).toMatchObject({ type: "merge_request.comment", author: "ofek", number: 9, host: "gl.corp" });
    expect(svc.handleWebhook("gitlab", "f1", "t", { "x-gitlab-token": "nope" }, note).status).toBe(401);
    expect(svc.handleWebhook("github", "f1", "t", {}, note).status).toBe(404);
    expect(svc.handleWebhook("gitlab", "f1", "missing", {}, note).status).toBe(404);

    const noSecret = setup(flowWith({ type: "gitlab", mode: "webhook", secretEnv: "GL_SECRET" }));
    expect(noSecret.svc.handleWebhook("gitlab", "f1", "t", { "x-gitlab-token": "" }, note).status).toBe(403);
    expect(svc.status()[0].webhookPath).toBe("/hooks/gitlab/f1/t");
  });

  it("the listener only serves POST /hooks/* and caps the body size", async () => {
    const calls: string[] = [];
    let server: WebhookServer | undefined;
    try {
      server = await startWebhookServer("127.0.0.1", 0, (provider, flowId, nodeId) => {
        calls.push(`${provider}/${flowId}/${nodeId}`);
        return { status: 202, message: "ok" };
      });
      const url = `http://127.0.0.1:${server.port}`;
      expect((await fetch(`${url}/hooks/gitlab/f1/t`, { method: "POST", body: "{}" })).status).toBe(202);
      expect((await fetch(`${url}/api/data`)).status).toBe(404);
      expect((await fetch(`${url}/hooks/gitlab/f1/t`)).status).toBe(405);
      expect((await fetch(`${url}/hooks/evil/f1/t`, { method: "POST", body: "{}" })).status).toBe(404);
      const big = await new Promise<number>((resolve) => {
        const req = http.request(`${url}/hooks/github/f1/t`, { method: "POST" }, (res) => resolve(res.statusCode!));
        req.on("error", () => resolve(413));
        req.end(Buffer.alloc(6 * 1024 * 1024, 97));
      });
      expect(big).toBe(413);
      expect(calls).toEqual(["gitlab/f1/t"]);
    } finally {
      await server?.close();
    }
  });
});

describe("polling triggers", () => {
  it("first poll sets a cursor, later polls fire new matching events; cursor survives a restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-trig-"));
    dirs.push(dir);
    const statePath = path.join(dir, "state.json");
    let events: unknown[] = [
      { id: 10, action_name: "commented on", target_type: "Note", author: { username: "a" }, note: { body: "old", noteable_type: "MergeRequest", noteable_iid: 1 } },
    ];
    const calls: string[][] = [];
    const exec = async (cmd: string, args: string[]) => (calls.push([cmd, ...args]), { code: 0, stdout: JSON.stringify(events), stderr: "" });
    const trig = { type: "gitlab" as const, mode: "poll" as const, repo: "grp/app", host: "gl.corp", pollSeconds: 60, events: ["merge_request.comment" as const] };

    const first = setup(flowWith(trig), {}, exec, statePath);
    await first.svc.pollNow("f1", "t");
    expect(first.fired).toHaveLength(0);
    expect(calls[0]).toEqual(["glab", "api", "--hostname", "gl.corp", "projects/grp%2Fapp/events?per_page=100&sort=desc"]);

    events = [
      { id: 12, action_name: "opened", target_type: "Issue", target_iid: 5, author: { username: "b" } }, // filtered out
      { id: 11, action_name: "commented on", target_type: "Note", author: { username: "ofek" }, note: { body: "@sandflow q", noteable_type: "MergeRequest", noteable_iid: 9 } },
      ...events,
    ];
    await first.svc.pollNow("f1", "t");
    expect(first.fired.map((f) => f.event.body)).toEqual(["@sandflow q"]);
    first.svc.stop();

    // Restart: the saved cursor (12) means nothing is replayed.
    const second = setup(flowWith(trig), {}, exec, statePath);
    await second.svc.pollNow("f1", "t");
    expect(second.fired).toHaveLength(0);
    second.svc.stop();
  });

  it("reports CLI failures in the trigger status", async () => {
    const exec = async () => ({ code: 1, stdout: "", stderr: "gh: not logged in" });
    const { svc } = setup(flowWith({ type: "github", mode: "poll", repo: "acme/app" }, "github-trigger"), {}, exec);
    await svc.pollNow("f1", "t");
    expect(svc.status()[0].lastError).toMatch(/not logged in/);
    svc.stop();
  });
});
