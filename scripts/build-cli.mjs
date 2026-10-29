// npm run build:cli → dist-cli/: the self-contained `sandflow` npm package (the bundled CLI, the built UI, packs and
// skills; `npm i -g sandflow`); its only runtime dependency is @ai-hero/sandcastle. `--pack` (npm run pack:cli) also
// writes release/sandflow-<version>.tgz and release/sandflow-cli.tgz (what the one-line installers download).
// `--publish` (npm run publish:npm) publishes dist-cli/ to the npm registry; extra args after it go to npm publish.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "dist-cli");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status ?? r.error?.message})`);
}

// Keep a node_modules junction / symlink someone put there for local testing; everything else is rebuilt.
fs.mkdirSync(out, { recursive: true });
for (const e of fs.readdirSync(out)) if (e !== "node_modules") fs.rmSync(path.join(out, e), { recursive: true, force: true });

await build({
  entryPoints: [path.join(root, "backend", "cli.ts")],
  outfile: path.join(out, "sandflow.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@ai-hero/sandcastle", "@ai-hero/sandcastle/*"],
  // Bundled CommonJS deps (semver, …) call require(); ESM has none.
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __sfRequire } from "node:module";\nconst require = __sfRequire(import.meta.url);' },
  logLevel: "warning",
});

run(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", path.join(out, "web"), "--emptyOutDir"]);

for (const dir of ["packs", "skills", "agent-skills", "sandbox"]) fs.cpSync(path.join(root, dir), path.join(out, dir), { recursive: true });
fs.copyFileSync(path.join(root, "scripts", "npm-readme.md"), path.join(out, "README.md"));

fs.writeFileSync(
  path.join(out, "package.json"),
  `${JSON.stringify(
    {
      name: "sandflow",
      version: pkg.version,
      description: "Visual flow builder for sandboxed coding agents: the sandflow CLI, its backend and the web UI",
      keywords: ["sandflow", "coding-agents", "claude-code", "ai-agents", "sandbox", "workflow", "cli", "mcp"],
      author: pkg.author,
      type: "module",
      bin: { sandflow: "sandflow.mjs" },
      files: ["sandflow.mjs", "web", "packs", "skills", "agent-skills", "sandbox", "README.md"],
      engines: { node: ">=22" },
      license: pkg.license,
      homepage: "https://github.com/kafuexe/sandflow#readme",
      bugs: { url: "https://github.com/kafuexe/sandflow/issues" },
      repository: pkg.repository,
      dependencies: { "@ai-hero/sandcastle": pkg.dependencies["@ai-hero/sandcastle"] },
    },
    null,
    2,
  )}\n`,
);
console.log(`dist-cli/ built (sandflow ${pkg.version})`);

if (process.argv.includes("--pack")) {
  const release = path.join(root, "release");
  fs.mkdirSync(release, { recursive: true });
  // npm pack leaves node_modules out by itself.
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  run(npm, ["pack", "--pack-destination", release], { cwd: out, shell: process.platform === "win32" });
  const tgz = path.join(release, `sandflow-${pkg.version}.tgz`);
  fs.copyFileSync(tgz, path.join(release, "sandflow-cli.tgz"));
  console.log(`release/${path.basename(tgz)} and release/sandflow-cli.tgz written`);
}

if (process.argv.includes("--publish")) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const extra = process.argv.slice(process.argv.indexOf("--publish") + 1);
  run(npm, ["publish", "--access", "public", ...extra], { cwd: out, shell: process.platform === "win32" });
}
