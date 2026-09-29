import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAppServer, type AppServer } from "../backend/server";
import type { NodeRunner } from "../backend/engine";

const dirs: string[] = [];
let server: AppServer | undefined;
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-srv-"));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  await server?.close();
  server = undefined;
  dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

function webRoot() {
  const d = tmp();
  fs.writeFileSync(path.join(d, "index.html"), "<html>app</html>");
  fs.mkdirSync(path.join(d, "assets"));
  fs.writeFileSync(path.join(d, "assets", "app.js"), "console.log(1)");
  fs.writeFileSync(path.join(tmp(), "secret.txt"), "nope");
  return d;
}

/** Raw request so we can send an arbitrary Host header. */
function get(port: number, p: string, host = `127.0.0.1:${port}`) {
  return new Promise<{ status: number; body: string; type?: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body, type: res.headers["content-type"] }));
    });
    req.on("error", reject);
    req.end();
  });
}

const idle: NodeRunner = async () => ({ outputs: {} });

describe("app server", () => {
  it("serves the UI, assets, SPA fallback and the API on 127.0.0.1", async () => {
    server = await startAppServer({ dataDir: tmp(), webRoot: webRoot(), runners: { auto: idle, ai: idle } });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const port = server.port;
    expect(await get(port, "/")).toMatchObject({ status: 200, body: "<html>app</html>" });
    expect(await get(port, "/assets/app.js")).toMatchObject({ status: 200, type: expect.stringContaining("javascript") });
    expect((await get(port, "/some/route")).body).toBe("<html>app</html>");
    const data = await get(port, "/api/data");
    expect(data.status).toBe(200);
    expect(JSON.parse(data.body).flows[0].id).toBe("feature-pipeline");
  });

  it("rejects foreign Host headers (DNS rebinding) and path traversal", async () => {
    server = await startAppServer({ dataDir: tmp(), webRoot: webRoot(), runners: { auto: idle, ai: idle } });
    const port = server.port;
    expect((await get(port, "/api/data", "evil.example:80")).status).toBe(403);
    expect((await get(port, "/api/data", `localhost:${port}`)).status).toBe(200);
    const trav = await get(port, "/../secret.txt");
    expect(trav.body).not.toContain("nope");
    const enc = await get(port, "/%2e%2e/secret.txt");
    expect(enc.body).not.toContain("nope");
  });

  it("uses the given bundled skills dir", async () => {
    const skills = tmp();
    fs.mkdirSync(path.join(skills, "acme", "hello"), { recursive: true });
    fs.writeFileSync(path.join(skills, "acme", "hello", "SKILL.md"), "---\nname: hello\n---");
    server = await startAppServer({ dataDir: tmp(), webRoot: webRoot(), bundledSkillsDir: skills, runners: { auto: idle, ai: idle } });
    const list = JSON.parse((await get(server.port, "/api/skills")).body) as { name: string }[];
    expect(list.map((s) => s.name)).toEqual(["hello"]);
  });

  it("cancels active runs on close so sandboxes get torn down", async () => {
    const dataDir = tmp();
    let aborted = false;
    const waiting: NodeRunner = (ctx) =>
      new Promise((_, reject) =>
        ctx.abort.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("cancelled"));
        }),
      );
    server = await startAppServer({ dataDir, webRoot: webRoot(), runners: { auto: waiting, ai: waiting } });
    const base = `${server.url}/api`;
    const put = (p: string, b: unknown) =>
      fetch(`${base}${p}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    await put("/env", { REPO_PATH: "/r", ANTHROPIC_API_KEY: "k", BRANCH_NAME: "b", BASE_BRANCH: "main", MR_PROVIDER: "github" });
    await put("/settings", { startingPrompt: "x", sandbox: "none", maxSteps: 40 });
    const res = await fetch(`${base}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"flowId":"feature-pipeline"}' });
    const { runId } = (await res.json()) as { runId: string };
    await server.close();
    server = undefined;
    expect(aborted).toBe(true);
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "runs", `${runId}.json`), "utf8"));
    expect(saved.status).toBe("cancelled");
  });
});
