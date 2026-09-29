import pkg from "../package.json";
import { AGENT_PROVIDERS } from "./agents";
import type { AssistantAgent, Settings } from "./types";

export const APP_VERSION: string = pkg.version;

/** Image published (as an offline bundle) with each release — see sandbox/Dockerfile. */
export const DEFAULT_SANDBOX_IMAGE = `sandflow-agent:${APP_VERSION}`;

/** Where the agent tools folder is mounted inside the sandbox (on PATH in the image). */
export const AGENT_TOOLS_MOUNT = "/opt/sandflow/tools";

/** Docker/OCI image reference: [registry[:port]/]name[:tag][@digest], no spaces or shell characters. */
const IMAGE_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:[0-9]+)?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)*(:[\w][\w.-]{0,127})?(@sha256:[a-f0-9]{64})?$/i;

/** An assistant agent choice: a known provider and an optional model name (passed to the CLI as an argument). */
export function validateAssistantAgent(a: AssistantAgent): AssistantAgent {
  if (!a || !AGENT_PROVIDERS.includes(a.provider)) throw new Error(`Unknown agent "${a?.provider}"`);
  const model = a.model?.trim();
  if (model && !/^[\w.:/@\[\]-]{1,120}$/.test(model)) throw new Error(`Invalid model name "${model}"`);
  return model ? { provider: a.provider, model } : { provider: a.provider };
}

/** Validate + normalise settings coming from the UI. Throws with a user-facing message. */
export function validateSettings(s: Settings): Settings {
  if (!s || typeof s !== "object") throw new Error("Expected settings");
  if (!["docker", "podman", "none"].includes(s.sandbox)) throw new Error("Invalid sandbox (use docker, podman or none)");
  const out: Settings = {
    startingPrompt: String(s.startingPrompt ?? ""),
    sandbox: s.sandbox,
    maxSteps: Math.max(1, Math.min(1000, Math.floor(Number(s.maxSteps) || 40))),
  };
  const image = s.sandboxImage?.trim();
  if (image) {
    if (!IMAGE_RE.test(image)) throw new Error(`Invalid sandbox image "${image}"`);
    out.sandboxImage = image;
  }
  const tools = s.agentToolsDir?.trim();
  if (tools) out.agentToolsDir = tools;
  if (s.assistantAgent) out.assistantAgent = validateAssistantAgent(s.assistantAgent);
  if (s.webhooks) {
    const w = s.webhooks;
    const port = Math.floor(Number(w.port));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Webhook port must be 1–65535");
    const host = String(w.host ?? "").trim() || "127.0.0.1";
    if (!/^[\w.:-]+$/.test(host)) throw new Error(`Invalid webhook listen address "${host}"`);
    const publicUrl = w.publicUrl?.trim();
    if (publicUrl && !/^https?:\/\/\S+$/i.test(publicUrl)) throw new Error("Webhook public URL must be an http(s) URL");
    out.webhooks = { enabled: !!w.enabled, host, port, ...(publicUrl ? { publicUrl } : {}) };
  }
  if (s.updates) {
    const mode = s.updates.mode;
    if (!["github", "url", "off"].includes(mode)) throw new Error("Invalid update mode");
    const url = s.updates.url?.trim();
    if (mode === "url" && !(url && /^https?:\/\/\S+$/i.test(url))) throw new Error("Update URL must be an http(s) URL");
    out.updates = mode === "url" ? { mode, url } : { mode };
  }
  return out;
}
