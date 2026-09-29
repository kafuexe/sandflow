import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createApi } from "./backend/api";
import { createStorage } from "./backend/storage";
import { runAuto } from "./backend/runners/auto";
import { runAi } from "./backend/runners/ai";

/** Runs the flow engine inside the Vite process and serves it at /api — one app, one port. */
function sandflowApi(): Plugin {
  /** One API per server; when Vite restarts (e.g. a backend file changed) the old one's triggers, webhook
   *  listener and runs are shut down so nothing fires twice or keeps the webhook port. */
  const mount = (server: { middlewares: { use(fn: unknown): unknown }; httpServer?: { once(e: "close", fn: () => void): unknown } | null }) => {
    const api = createApi(createStorage(), { auto: runAuto, ai: runAi });
    server.middlewares.use(api);
    server.httpServer?.once("close", () => void api.shutdown(5_000));
  };
  return {
    name: "sandflow-api",
    configureServer: (server) => mount(server),
    configurePreviewServer: (server) => mount(server),
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), sandflowApi()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  server: { port: 5173 },
});
