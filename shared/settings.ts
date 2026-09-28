import pkg from "../package.json";
import type { Settings } from "./types";

export const APP_VERSION: string = pkg.version;

/** Image published (as an offline bundle) with each release — see sandbox/Dockerfile. */
export const DEFAULT_SANDBOX_IMAGE = `sandflow-agent:${APP_VERSION}`;

/** Where the agent tools folder is mounted inside the sandbox (on PATH in the image). */
export const AGENT_TOOLS_MOUNT = "/opt/sandflow/tools";

/** Docker/OCI image reference: [registry[:port]/]name[:tag][@digest], no spaces or shell characters. */
const IMAGE_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:[0-9]+)?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)*(:[\w][\w.-]{0,127})?(@sha256:[a-f0-9]{64})?$/i;

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
  if (s.updates) {
    const mode = s.updates.mode;
    if (!["github", "url", "off"].includes(mode)) throw new Error("Invalid update mode");
    const url = s.updates.url?.trim();
    if (mode === "url" && !(url && /^https?:\/\/\S+$/i.test(url))) throw new Error("Update URL must be an http(s) URL");
    out.updates = mode === "url" ? { mode, url } : { mode };
  }
  return out;
}
