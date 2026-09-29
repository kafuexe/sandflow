// Webhook listener — a separate HTTP server that ONLY serves POST /hooks/<provider>/<flowId>/<nodeId>,
// so it can be exposed to GitHub/GitLab without exposing the app API (and its secrets).

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { WebhookResult } from "./triggers";

const MAX_BODY = 5 * 1024 * 1024;
const ROUTE = /^\/hooks\/(github|gitlab)\/([\w-]+)\/([\w-]+)\/?$/;

export type WebhookHandler = (
  provider: string,
  flowId: string,
  nodeId: string,
  headers: http.IncomingHttpHeaders,
  body: Buffer,
) => WebhookResult;

export interface WebhookServer {
  port: number;
  host: string;
  close(): Promise<void>;
}

export async function startWebhookServer(host: string, port: number, handle: WebhookHandler): Promise<WebhookServer> {
  const server = http.createServer((req, res) => {
    const reply = (status: number, message: string) => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(message);
    };
    const m = ROUTE.exec(new URL(req.url ?? "/", "http://x").pathname);
    if (!m) return reply(404, "Not found");
    if (req.method !== "POST") return reply(405, "Use POST");

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY && !aborted) {
        aborted = true;
        reply(413, "Payload too large");
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted) return;
      try {
        const r = handle(m[1], m[2], m[3], req.headers, Buffer.concat(chunks));
        reply(r.status, r.message);
      } catch (e) {
        reply(500, (e as Error).message);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    host,
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
