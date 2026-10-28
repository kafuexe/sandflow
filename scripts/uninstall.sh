#!/usr/bin/env bash
# Removes the Sandflow CLI, its launcher and PATH line, the hourly checker, pending schedules, the Claude Code
# plugin and the MCP entry the installer registered. Keeps ~/.sandflow/data and history.jsonl unless --purge.
#
#   curl -fsSL https://raw.githubusercontent.com/kafuexe/sandflow/main/scripts/uninstall.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/kafuexe/sandflow/main/scripts/uninstall.sh | bash -s -- --purge
#
#   --purge   SANDFLOW_PURGE=1   also delete ~/.sandflow entirely (flows, settings, run data, history)
#   SANDFLOW_HOME (install root), SANDFLOW_NO_PATH=1 (leave shell profiles alone) as for install.sh.
set -euo pipefail

on() { case "${1:-}" in ''|0|false|no|off|FALSE|NO|OFF) return 1 ;; *) return 0 ;; esac; }
purge=false
on "${SANDFLOW_PURGE:-}" && purge=true
while [ "$#" -gt 0 ]; do
    case "$1" in
        --purge) purge=true ;;
        -h|--help) sed -n '2,9p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true; exit 0 ;;
        *) printf 'Unknown option: %s (see --help)\n' "$1" >&2; exit 2 ;;
    esac
    shift
done
step() { printf '==> %s\n' "$*"; }

root=${SANDFLOW_HOME:-$HOME/.sandflow}
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) command -v cygpath >/dev/null 2>&1 && root=$(cygpath -u "$root") ;; esac
cli_dir="$root/cli"
bin_dir="$root/bin"
shim="$bin_dir/sandflow"
mjs="$cli_dir/sandflow.mjs"
node=${SANDFLOW_NODE:-$(command -v node 2>/dev/null || true)}

printf '\nSandflow uninstaller\n\n'

# 1. The checker, pending schedules, the daemon.
if [ -n "$node" ] && [ -f "$mjs" ]; then
    step 'Removing the hourly checker and pending schedules...'
    "$node" "$mjs" checker uninstall || true
    ids=$("$node" "$mjs" schedule list --json 2>/dev/null | "$node" -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{let j=[];try{j=JSON.parse(s)}catch{}const l=Array.isArray(j)?j:(j&&j.schedules)||[];for(const x of l)if(x&&x.id&&x.state==="scheduled")console.log(x.id)})' || true)
    for id in $ids; do "$node" "$mjs" schedule cancel "$id" || true; done
    if [ -f "$root/daemon.json" ]; then
        step 'Stopping the Sandflow daemon...'
        "$node" "$mjs" shutdown || true
    fi
fi

# 2. Claude Code.
claude=$(command -v claude 2>/dev/null || true)
if [ -n "$claude" ] && [ -n "$node" ]; then
    has_name() { "$node" -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{let l=[];try{l=JSON.parse(s)}catch{}process.exit(Array.isArray(l)&&l.some((m)=>m&&(m.name===process.argv[1]||m.id===process.argv[1]))?0:1)})' "$1"; }
    step 'Removing the Claude Code plugin...'
    if "$claude" plugin list --json 2>/dev/null | has_name sand@sandflow; then "$claude" plugin uninstall sand@sandflow || true; fi
    if "$claude" plugin marketplace list --json 2>/dev/null | has_name sandflow; then "$claude" plugin marketplace remove sandflow || true; fi
    mcp_check_js='
const fs = require("fs");
const [file, command, ...args] = process.argv.slice(1);
let cfg;
try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); }
catch (e) { console.log(e.code === "ENOENT" ? "none" : "unreadable"); process.exit(0); }
const e = cfg && cfg.mcpServers && cfg.mcpServers.sandflow;
if (!e) { console.log("none"); process.exit(0); }
const norm = (s) => String(s).replace(/\\/g, "/").toLowerCase();
const parts = [e.command || "", ...(Array.isArray(e.args) ? e.args : [])].map(String);
if (norm(e.command || "") === norm(command) && JSON.stringify((e.args || []).map(norm)) === JSON.stringify(args.map(norm))) console.log("same");
else if (parts.some((p) => p.includes("sandflow-mcp-bridge.cjs"))) console.log("bridge");
else if (parts.includes("mcp") && parts.some((p) => /(^|[\\/])sandflow(\.cmd|\.ps1|\.mjs)?$/i.test(p))) console.log("cli");
else console.log("foreign");
'
    state=$("$node" -e "$mcp_check_js" "${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json" "$shim" mcp || echo unreadable)
    case "$state" in
        same|cli) step 'Removing the sandflow MCP server from Claude Code...'; "$claude" mcp remove --scope user sandflow || true ;;
        bridge) printf "Left the desktop app's sandflow MCP server in Claude Code (the app manages it).\n" ;;
        foreign) printf 'Left the "sandflow" MCP server in Claude Code: the installer did not register it.\n' ;;
    esac
else
    printf 'Claude Code (claude) not found; if you added them, remove later with:\n'
    printf '  claude plugin uninstall sand@sandflow; claude plugin marketplace remove sandflow; claude mcp remove --scope user sandflow\n'
fi

# 3. PATH lines in shell profiles.
marker='# added by the Sandflow installer'
if ! on "${SANDFLOW_NO_PATH:-}"; then
    for f in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
        if [ -f "$f" ] && grep -qF "$marker" "$f"; then
            grep -vF "$marker" "$f" > "$f.sandflow-tmp" || true
            cat "$f.sandflow-tmp" > "$f"
            rm -f "$f.sandflow-tmp"
            step "Removed the Sandflow PATH line from $f"
        fi
    done
fi

# 4. Files.
if $purge; then
    step "Deleting $root (flows, settings, run data and history)..."
    rm -rf "$root"
else
    step "Removing the CLI and launcher from $root..."
    rm -rf "$cli_dir" "$bin_dir" "$root/daemon.json"
    printf 'Kept your data in %s (data, history.jsonl, schedule logs). Rerun with --purge to delete it too.\n' "$root"
fi
printf '\nSandflow CLI uninstalled. Restart Claude Code to unload the plugin.\n'
