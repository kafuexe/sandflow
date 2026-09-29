// Container-runtime helpers for air-gapped use: the sandbox image is loaded from an offline bundle and
// must already exist locally — Sandflow never pulls it.

import { execFile } from "node:child_process";
import fs from "node:fs";
import { AGENT_TOOLS_MOUNT, DEFAULT_SANDBOX_IMAGE } from "../shared/settings";
import type { Settings } from "../shared/types";

export type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Run a command without a shell; never throws for a non-zero exit. */
export const execCli: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024, timeout: 10 * 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && code === 1 ? err.message : "")) });
    });
  });

export interface SandboxImageStatus {
  runtime: "docker" | "podman";
  runtimeAvailable: boolean;
  image: string;
  imagePresent: boolean;
}

const runtimeOf = (s: Settings): "docker" | "podman" => (s.sandbox === "podman" ? "podman" : "docker");
export const imageOf = (s: Settings) => s.sandboxImage?.trim() || DEFAULT_SANDBOX_IMAGE;

export async function sandboxImageStatus(s: Settings, exec: Exec = execCli): Promise<SandboxImageStatus> {
  const runtime = runtimeOf(s);
  const image = imageOf(s);
  const version = await exec(runtime, ["version", "--format", "{{.Server.Version}}"]).catch(() => ({ code: 1 }));
  if (version.code !== 0) return { runtime, runtimeAvailable: false, image, imagePresent: false };
  const inspect = await exec(runtime, ["image", "inspect", image, "--format", "{{.Id}}"]);
  return { runtime, runtimeAvailable: true, image, imagePresent: inspect.code === 0 };
}

/** `docker load -i <file>` (accepts .tar and .tar.gz). Returns the runtime's "Loaded image: …" output. */
export async function importSandboxImage(s: Settings, file: string, exec: Exec = execCli): Promise<string> {
  if (s.sandbox === "none") throw new Error("Set Settings → Sandbox to Docker or Podman first");
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Bundle file not found: ${file}`);
  const r = await exec(runtimeOf(s), ["load", "-i", file]);
  if (r.code !== 0) throw new Error(`${runtimeOf(s)} load failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

/** Fail fast with an actionable message instead of letting `docker run` try to pull the image. */
export async function ensureSandboxReady(s: Settings, exec: Exec = execCli): Promise<void> {
  if (s.sandbox === "none") return;
  const st = await sandboxImageStatus(s, exec);
  if (!st.runtimeAvailable) throw new Error(`${st.runtime} isn't available — is it installed and running?`);
  if (!st.imagePresent) {
    throw new Error(
      `Sandbox image "${st.image}" isn't loaded. Import the offline bundle in Settings → Sandbox (Sandflow never pulls images).`,
    );
  }
}

/** Options for sandcastle's docker()/podman() providers. */
export function sandboxProviderOptions(s: Settings) {
  const mounts: { hostPath: string; sandboxPath: string; readonly: boolean }[] = [];
  const tools = s.agentToolsDir?.trim();
  if (tools) {
    if (!fs.existsSync(tools) || !fs.statSync(tools).isDirectory()) {
      throw new Error(`Agent tools folder not found: ${tools} (Settings → Sandbox)`);
    }
    mounts.push({ hostPath: tools, sandboxPath: AGENT_TOOLS_MOUNT, readonly: true });
  }
  return { imageName: imageOf(s), mounts };
}
