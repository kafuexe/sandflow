// Standalone HTTP server for the desktop app: serves the built UI and /api on 127.0.0.1 (the web dev
// build uses the Vite plugin instead).

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createApi } from "./api";
import type { ClaudeCodeOptions } from "./claudeCode";
import type { NodeRunner } from "./engine";
import { createStorage } from "./storage";

export interface AppServerOptions {
  /** Where library/flows/settings/env/runs/uploaded skills are stored. */
  dataDir: string;
  /** Built UI (vite `dist/`). */
  webRoot: string;
  runners: { auto: NodeRunner; ai: NodeRunner; script?: NodeRunner; integration?: NodeRunner };
  bundledSkillsDir?: string;
  /** Packs shipped with the app (`<dir>/base/manifest.json`); installed on first start. */
  bundledPacksDir?: string;
  /** `sandflow-agent:<version>` image bundle shipped with the app (resources/sandbox/). */
  bundledSandboxImage?: string;
  /** Fetch the base pack from GitHub at start (default true). */
  fetchBasePack?: boolean;
  /** Default 0 = pick a free port. */
  port?: number;
  /** How long running steps get to finish when runs pause on close (default 5 s). */
  pauseGraceMs?: number;
  /** Register Sandflow with Claude Code (desktop app; Settings can turn it off). */
  claudeCode?: ClaudeCodeOptions;
}

export interface AppServer {
  url: string;
  port: number;
  /** Pauses active runs (they continue on the next start; sandboxes are torn down), then stops the server. */
  close(reason?: "quit" | "update"): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json",
};

export async function startAppServer(opts: AppServerOptions): Promise<AppServer> {
  const api = createApi(createStorage(opts.dataDir, { bundledDir: opts.bundledPacksDir }), opts.runners, {
    bundledSkillsDir: opts.bundledSkillsDir,
    fetchBasePack: opts.fetchBasePack ?? true,
    bundledSandboxImage: opts.bundledSandboxImage,
    pauseGraceMs: opts.pauseGraceMs,
    claudeCode: opts.claudeCode,
  });
  const root = path.resolve(opts.webRoot);
  let allowedHosts = new Set<string>();

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      res.statusCode = 400;
      return res.end();
    }
    let file = path.resolve(root, `.${rel}`);
    const inside = file === root || file.startsWith(root + path.sep);
    if (!inside || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(root, "index.html"); // SPA fallback (also swallows traversal attempts)
    }
    res.setHeader("content-type", MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream");
    if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader("cache-control", "public, max-age=31536000, immutable");
    fs.createReadStream(file)
      .on("error", () => {
        res.statusCode = 500;
        res.end();
      })
      .pipe(res);
  }

  const server = http.createServer((req, res) => {
    // Only answer requests addressed to us — blocks DNS-rebinding pages from reading the API.
    if (!allowedHosts.has((req.headers.host ?? "").toLowerCase())) {
      res.statusCode = 403;
      return res.end("Forbidden");
    }
    api(req, res, () => serveStatic(req, res));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  // Claude Code's bridge finds this port in mcp.json, even before the window has loaded.
  api.noteHost(`127.0.0.1:${port}`);

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    async close(reason = "quit") {
      await api.shutdown(undefined, reason);
      server.closeAllConnections(); // SSE streams would otherwise keep it open
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
