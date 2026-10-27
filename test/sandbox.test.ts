import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureSandboxReady,
  importSandboxImage,
  loadBundledSandboxImage,
  sandboxImageStatus,
  sandboxProviderOptions,
  setBundledSandboxImage,
  type Exec,
} from "../backend/sandbox";
import { DEFAULT_SANDBOX_IMAGE, validateSettings } from "../shared/settings";
import type { Settings } from "../shared/types";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sandflow-sbx-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  setBundledSandboxImage(undefined);
  dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

const base: Settings = { startingPrompt: "", sandbox: "docker", maxSteps: 40 };

/** Fake container CLI: records calls, answers from a table keyed by the first two args. */
function fakeExec(answers: Record<string, { code: number; stdout?: string; stderr?: string }>) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const a = answers[`${args[0]} ${args[1]}`] ?? answers[args[0]] ?? { code: 0 };
    return { code: a.code, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
  return { exec, calls };
}

describe("sandbox image", () => {
  it("defaults to a versioned sandflow-agent image", () => {
    expect(DEFAULT_SANDBOX_IMAGE).toMatch(/^sandflow-agent:\d+\.\d+\.\d+/);
  });

  it("reports runtime and image presence using docker or podman", async () => {
    const ok = fakeExec({ version: { code: 0, stdout: "27.0" }, "image inspect": { code: 0, stdout: "sha256:abc" } });
    expect(await sandboxImageStatus(base, ok.exec)).toEqual({ runtime: "docker", runtimeAvailable: true, image: DEFAULT_SANDBOX_IMAGE, imagePresent: true, bundled: false });
    expect(ok.calls[1]).toEqual(["docker", "image", "inspect", DEFAULT_SANDBOX_IMAGE, "--format", "{{.Id}}"]);

    const missing = fakeExec({ version: { code: 0 }, "image inspect": { code: 1, stderr: "No such image" } });
    const st = await sandboxImageStatus({ ...base, sandbox: "podman", sandboxImage: "acme/agent:1" }, missing.exec);
    expect(st).toMatchObject({ runtime: "podman", runtimeAvailable: true, image: "acme/agent:1", imagePresent: false });
    expect(missing.calls[0][0]).toBe("podman");

    const down = fakeExec({ version: { code: 1, stderr: "Cannot connect to the Docker daemon" } });
    expect(await sandboxImageStatus(base, down.exec)).toMatchObject({ runtimeAvailable: false, imagePresent: false });
  });

  it("imports a bundle with `load -i` and returns its output", async () => {
    const file = path.join(tmp(), "bundle.tar.gz");
    fs.writeFileSync(file, "x");
    const f = fakeExec({ load: { code: 0, stdout: "Loaded image: sandflow-agent:0.1.0\n" } });
    expect(await importSandboxImage(base, file, f.exec)).toBe("Loaded image: sandflow-agent:0.1.0");
    expect(f.calls[0]).toEqual(["docker", "load", "-i", file]);
    await expect(importSandboxImage(base, path.join(tmp(), "nope.tar"), f.exec)).rejects.toThrow(/not found/i);
    const bad = fakeExec({ load: { code: 1, stderr: "invalid tar header" } });
    await expect(importSandboxImage(base, file, bad.exec)).rejects.toThrow(/invalid tar header/);
    await expect(importSandboxImage({ ...base, sandbox: "none" }, file, f.exec)).rejects.toThrow(/docker or podman/i);
  });

  it("refuses to start without a runtime or a loaded image (never pulls)", async () => {
    const missing = fakeExec({ version: { code: 0 }, "image inspect": { code: 1 } });
    await expect(ensureSandboxReady(base, missing.exec)).rejects.toThrow(/isn't loaded.*offline bundle/i);
    const down = fakeExec({ version: { code: 1 } });
    await expect(ensureSandboxReady(base, down.exec)).rejects.toThrow(/docker isn't available/i);
    const ok = fakeExec({});
    await expect(ensureSandboxReady(base, ok.exec)).resolves.toBeUndefined();
    await expect(ensureSandboxReady({ ...base, sandbox: "none" }, ok.exec)).resolves.toBeUndefined();
    expect(ok.calls.every((c) => c[1] !== "pull")).toBe(true);
  });

  it("loads the bundle shipped with the app when the default image is missing", async () => {
    const file = path.join(tmp(), "sandflow-agent.tar.gz");
    fs.writeFileSync(file, "x");
    setBundledSandboxImage(file);
    let loaded = false;
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === "load") loaded = true;
      if (args[0] === "image") return { code: loaded ? 0 : 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "Loaded image: x", stderr: "" };
    };
    expect(await sandboxImageStatus(base, exec)).toMatchObject({ imagePresent: false, bundled: true });
    await expect(ensureSandboxReady(base, exec)).resolves.toBeUndefined();
    expect(calls.filter((c) => c[1] === "load")).toEqual([["docker", "load", "-i", file]]);
  });

  it("never loads the bundle for a custom image, sandbox none, or when none ships", async () => {
    const file = path.join(tmp(), "sandflow-agent.tar.gz");
    fs.writeFileSync(file, "x");
    setBundledSandboxImage(file);
    const missing = fakeExec({ version: { code: 0 }, "image inspect": { code: 1 } });
    const custom = { ...base, sandboxImage: "acme/agent:1" };
    expect(await sandboxImageStatus(custom, missing.exec)).toMatchObject({ bundled: false });
    await expect(ensureSandboxReady(custom, missing.exec)).rejects.toThrow(/isn't loaded/);
    await expect(loadBundledSandboxImage({ ...base, sandbox: "none" }, missing.exec)).rejects.toThrow(/doesn't ship/);
    expect(missing.calls.some((c) => c[1] === "load")).toBe(false);

    setBundledSandboxImage(path.join(tmp(), "absent.tar.gz"));
    expect(await sandboxImageStatus(base, missing.exec)).toMatchObject({ bundled: false });
  });

  it("shares one load between concurrent callers", async () => {
    const file = path.join(tmp(), "sandflow-agent.tar.gz");
    fs.writeFileSync(file, "x");
    setBundledSandboxImage(file);
    const f = fakeExec({ load: { code: 0, stdout: "Loaded image: x" } });
    await Promise.all([loadBundledSandboxImage(base, f.exec), loadBundledSandboxImage(base, f.exec)]);
    expect(f.calls.filter((c) => c[1] === "load")).toHaveLength(1);
  });

  it("builds provider options: image name and a read-only agent tools mount", () => {
    const tools = tmp();
    expect(sandboxProviderOptions(base)).toEqual({ imageName: DEFAULT_SANDBOX_IMAGE, mounts: [] });
    expect(sandboxProviderOptions({ ...base, sandboxImage: " acme/agent:2 ", agentToolsDir: tools })).toEqual({
      imageName: "acme/agent:2",
      mounts: [{ hostPath: tools, sandboxPath: "/opt/sandflow/tools", readonly: true }],
    });
    expect(() => sandboxProviderOptions({ ...base, agentToolsDir: path.join(tools, "missing") })).toThrow(/agent tools folder/i);
  });
});

describe("validateSettings", () => {
  it("normalises and validates the on-prem fields", () => {
    expect(validateSettings({ ...base, maxSteps: 5000 })).toMatchObject({ maxSteps: 1000 });
    expect(validateSettings({ ...base, sandboxImage: "registry.local:5000/team/agent:1.2" }).sandboxImage).toBe(
      "registry.local:5000/team/agent:1.2",
    );
    expect(() => validateSettings({ ...base, sandboxImage: "bad image; rm -rf" })).toThrow(/image/i);
    expect(() => validateSettings({ ...base, sandbox: "vm" as never })).toThrow(/sandbox/i);
    expect(validateSettings({ ...base, updates: { mode: "url", url: "https://updates.corp/sandflow" } }).updates).toEqual({
      mode: "url",
      url: "https://updates.corp/sandflow",
    });
    expect(() => validateSettings({ ...base, updates: { mode: "url", url: "ftp://x" } })).toThrow(/update/i);
    expect(validateSettings({ ...base, agentToolsDir: "  " }).agentToolsDir).toBeUndefined();
    expect(validateSettings({ ...base, claudeCode: { enabled: false } }).claudeCode).toEqual({ enabled: false });
    expect(validateSettings({ ...base, claudeCode: {} as never }).claudeCode).toEqual({ enabled: true });
    expect(validateSettings(base).claudeCode).toBeUndefined();
  });
});
