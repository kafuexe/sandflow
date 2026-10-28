// `sandflow mcp`: a stdio MCP server for Claude Code that forwards each JSON-RPC line to the daemon's /api/mcp
// (streamable HTTP, stateless JSON) — the same as the desktop app's bridge (assistantAgents.ts MCP_BRIDGE), but it
// finds the daemon through daemon.json and starts it when it isn't running. stdout carries only JSON-RPC.

import path from "node:path";
import readline from "node:readline";
import { ensureDaemon, type Ctx } from "./client";

export function mcpProxy(ctx: Ctx, input: NodeJS.ReadableStream = ctx.stdin): Promise<number> {
  let base: string | undefined;
  const target = async (fresh: boolean) => {
    if (!base || fresh) base = (await ensureDaemon(ctx)).url;
    const u = new URL(`${base}/api/mcp`);
    // Runs it starts show "Claude Code (<project folder>)", like the desktop app's registration.
    u.searchParams.set("client", "claude-code");
    u.searchParams.set("label", path.basename(process.cwd()));
    return u;
  };
  const post = async (body: string, fresh = false) =>
    ctx.fetch(await target(fresh), { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body });
  const reply = (m: unknown) => ctx.out(JSON.stringify(m));

  return new Promise((resolve) => {
    let pending = 0;
    let closed = false;
    const done = () => closed && !pending && resolve(0);
    readline
      .createInterface({ input })
      .on("line", async (line) => {
        if (!line.trim()) return;
        pending++;
        let id: unknown;
        try {
          id = (JSON.parse(line) as { id?: unknown }).id;
        } catch {
          /* forwarded as is; the server answers the parse error */
        }
        try {
          let res: Response;
          try {
            res = await post(line);
          } catch {
            // The daemon went away (shutdown, restart): start it again and retry once.
            res = await post(line, true);
          }
          const text = res.status === 202 ? "" : (await res.text()).trim();
          if (text) ctx.out(text.replace(/\r?\n/g, " "));
          else if (res.status >= 400 && id !== undefined) reply({ jsonrpc: "2.0", id, error: { code: -32603, message: `Sandflow answered ${res.status}` } });
        } catch (e) {
          if (id !== undefined) reply({ jsonrpc: "2.0", id, error: { code: -32603, message: `Sandflow isn't reachable: ${(e as Error).message}` } });
        } finally {
          pending--;
          done();
        }
      })
      .on("close", () => {
        closed = true;
        done();
      });
  });
}
