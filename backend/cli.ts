// Entry of the `sandflow` CLI (bundled into dist-cli/sandflow.mjs by scripts/build-cli.mjs). See backend/cli/main.ts.

import { main } from "./cli/main";

const [major] = process.versions.node.split(".").map(Number);
if (major < 22) {
  process.stderr.write(`sandflow needs Node.js 22 or newer (this is ${process.version})\n`);
  process.exit(1);
}

main(process.argv.slice(2)).then(
  (code) => {
    // Let stdout drain (piped output) before exiting; long-running commands (serve, mcp) never resolve here.
    process.exitCode = code;
    if (process.stdout.writableNeedDrain) process.stdout.once("drain", () => process.exit(code));
    else process.exit(code);
  },
  (e: Error) => {
    process.stderr.write(`${e.stack ?? e.message}\n`);
    process.exit(1);
  },
);
