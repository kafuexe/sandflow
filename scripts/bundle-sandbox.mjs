// Builds the sandflow-agent:<version> image from sandbox/Dockerfile and saves it to
// build/sandbox/sandflow-agent.tar.gz, which electron-builder ships inside the installers (the app loads it
// into Docker / Podman on first start). Needs a Linux-container runtime; CI runs it on ubuntu.
//
//   node scripts/bundle-sandbox.mjs [--platform linux/amd64] [--runtime docker|podman]

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createGzip } from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const runtime = arg("runtime", "docker");
const platform = arg("platform", "linux/amd64");
const image = `sandflow-agent:${version}`;
const out = path.join(root, "build", "sandbox", "sandflow-agent.tar.gz");

const build = spawnSync(runtime, ["build", "--platform", platform, "-t", image, path.join(root, "sandbox")], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

fs.mkdirSync(path.dirname(out), { recursive: true });
const save = spawn(runtime, ["save", image], { stdio: ["ignore", "pipe", "inherit"] });
const file = fs.createWriteStream(`${out}.part`);
save.stdout.pipe(createGzip({ level: 9 })).pipe(file);
const [code] = await Promise.all([
  new Promise((resolve) => save.on("close", resolve)),
  new Promise((resolve, reject) => file.on("finish", resolve).on("error", reject)),
]);
if (code !== 0) {
  fs.rmSync(`${out}.part`, { force: true });
  process.exit(code ?? 1);
}
fs.renameSync(`${out}.part`, out);
console.log(`${image} (${platform}) → ${path.relative(root, out)} (${(fs.statSync(out).size / 1e6).toFixed(0)} MB)`);
