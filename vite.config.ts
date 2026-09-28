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
  const api = () => createApi(createStorage(), { auto: runAuto, ai: runAi });
  return {
    name: "sandflow-api",
    configureServer: (server) => void server.middlewares.use(api()),
    configurePreviewServer: (server) => void server.middlewares.use(api()),
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), sandflowApi()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  server: { port: 5173 },
});
