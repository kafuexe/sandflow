#!/usr/bin/env bash
# Sandflow CLI + Claude Code plugin installer for Linux and macOS (no root needed).
#
#   curl -fsSL https://raw.githubusercontent.com/kafuexe/sandflow/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/kafuexe/sandflow/main/scripts/install.sh | bash -s -- --checker
#
#   --no-plugin   SANDFLOW_NO_PLUGIN=1   don't add the Claude Code plugin (/sand:flow, /sand:schedule, /sand:edit)
#   --no-mcp      SANDFLOW_NO_MCP=1      don't register the `sandflow` MCP server with Claude Code
#   --checker     SANDFLOW_CHECKER=1     also install the hourly checker (`sandflow checker install`)
#
# Other environment overrides:
#   SANDFLOW_VERSION      release tag to install (default: the latest release), e.g. v0.2.0
#   SANDFLOW_CLI_URL      a sandflow-cli.tgz URL or local path to install instead of a release asset
#   SANDFLOW_CLI_SHA256   expected sha256 of SANDFLOW_CLI_URL (optional)
#   SANDFLOW_HOME         install root (default: ~/.sandflow)
#   SANDFLOW_REPO         GitHub repo (default: kafuexe/sandflow)
#   SANDFLOW_MARKETPLACE  Claude Code marketplace source (default: the GitHub repo)
#   SANDFLOW_NODE         node to use (default: node on PATH)
#   SANDFLOW_NO_PATH=1    don't add ~/.sandflow/bin to PATH in your shell profiles
set -euo pipefail

on() { case "${1:-}" in ''|0|false|no|off|FALSE|NO|OFF) return 1 ;; *) return 0 ;; esac; }
want_plugin=true; want_mcp=true; want_checker=false
on "${SANDFLOW_NO_PLUGIN:-}" && want_plugin=false
on "${SANDFLOW_NO_MCP:-}" && want_mcp=false
on "${SANDFLOW_CHECKER:-}" && want_checker=true
while [ "$#" -gt 0 ]; do
    case "$1" in
        --no-plugin) want_plugin=false ;;
        --no-mcp) want_mcp=false ;;
        --checker) want_checker=true ;;
        -h|--help)
            sed -n '2,20p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true
            exit 0 ;;
        *) printf 'Unknown option: %s (see --help)\n' "$1" >&2; exit 2 ;;
    esac
    shift
done

step() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'Sandflow installation failed: %s\n' "$*" >&2; exit 1; }
# Single-quote a string for a shell script.
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

msys=false
case "$(uname -s)" in
    Linux|Darwin) ;;
    MINGW*|MSYS*|CYGWIN*) msys=true ;;
    *) die "unsupported OS $(uname -s). On Windows use install.ps1." ;;
esac

root=${SANDFLOW_HOME:-$HOME/.sandflow}
if $msys && command -v cygpath >/dev/null 2>&1; then root=$(cygpath -u "$root"); fi
repo=${SANDFLOW_REPO:-kafuexe/sandflow}
cli_dir="$root/cli"
bin_dir="$root/bin"
notes=()
later=()

printf '\nSandflow installer\n\n'

# --- Node.js 22+ --------------------------------------------------------------
step 'Checking Node.js...'
node_help='Install Node.js 22 or newer, open a new terminal and rerun this installer:
  nvm (https://github.com/nvm-sh/nvm): nvm install 22
  macOS: brew install node@22
  Debian/Ubuntu: NodeSource (https://github.com/nodesource/distributions), then sudo apt install nodejs
  or the installer from https://nodejs.org'
node=${SANDFLOW_NODE:-$(command -v node 2>/dev/null || true)}
[ -n "$node" ] || die "Sandflow needs Node.js 22 or newer, and node wasn't found on PATH.
$node_help"
node_version=$("$node" -p 'process.versions.node' 2>/dev/null) || die "couldn't run $node.
$node_help"
[ "${node_version%%.*}" -ge 22 ] 2>/dev/null || die "Sandflow needs Node.js 22 or newer; $node is $node_version.
$node_help"
npm=$(command -v npm 2>/dev/null || true)
if [ -x "$(dirname "$node")/npm" ]; then npm="$(dirname "$node")/npm"; fi
[ -n "$npm" ] || die 'npm was not found next to node or on PATH. Reinstall Node.js (it includes npm).'
printf 'Using node %s (%s)\n' "$node_version" "$node"

if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL --retry 3 -H 'User-Agent: sandflow-installer' -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -q --header='User-Agent: sandflow-installer' -O "$2" "$1"; }
else
    die 'curl or wget is needed to download Sandflow.'
fi
sha256() { "$node" -e 'const c=require("crypto"),f=require("fs");console.log(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$1"; }

mkdir -p "$root"
temporary=$(mktemp -d "$root/.install-XXXXXXXX")
stage=
cleanup() {
    rm -rf "$temporary"
    if [ -n "$stage" ]; then rm -rf "$stage"; fi
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
tarball="$temporary/sandflow-cli.tgz"
package_dir=

# --- 1. The CLI package: a given tarball, a release asset, or a source build ----
if [ -n "${SANDFLOW_CLI_URL:-}" ]; then
    step "Using the CLI package from $SANDFLOW_CLI_URL"
    case "$SANDFLOW_CLI_URL" in
        http://*|https://*) fetch "$SANDFLOW_CLI_URL" "$tarball" || die "couldn't download $SANDFLOW_CLI_URL" ;;
        *) [ -f "$SANDFLOW_CLI_URL" ] || die "SANDFLOW_CLI_URL is neither a URL nor an existing file: $SANDFLOW_CLI_URL"
           cp "$SANDFLOW_CLI_URL" "$tarball" ;;
    esac
    if [ -n "${SANDFLOW_CLI_SHA256:-}" ]; then
        [ "$(sha256 "$tarball")" = "$(printf '%s' "$SANDFLOW_CLI_SHA256" | tr 'A-F' 'a-f' | tr -d '[:space:]')" ] \
            || die 'the CLI package does not match SANDFLOW_CLI_SHA256.'
        printf 'Checksum OK.\n'
    fi
else
    tag=${SANDFLOW_VERSION:-}
    case "$tag" in ''|v*) ;; *) tag="v$tag" ;; esac
    # Release download URLs, not the GitHub API: the API allows 60 anonymous requests an hour per IP, which
    # shared networks and CI run out of. `latest/download` redirects to the newest release's asset.
    if [ -n "$tag" ]; then
        base="https://github.com/$repo/releases/download/$tag"; which=$tag
    else
        base="https://github.com/$repo/releases/latest/download"; which='the latest release'
    fi
    step "Downloading sandflow-cli.tgz from $which..."
    if fetch "$base/sandflow-cli.tgz" "$tarball" 2>/dev/null; then
        if fetch "$base/sandflow-cli.tgz.sha256" "$temporary/sandflow-cli.tgz.sha256" 2>/dev/null; then
            expected=$(awk '{print tolower($1); exit}' "$temporary/sandflow-cli.tgz.sha256")
            [ "$(sha256 "$tarball")" = "$expected" ] \
                || die 'the downloaded sandflow-cli.tgz does not match its published sha256; nothing was installed.'
            printf 'Checksum OK.\n'
        else
            warn 'the release has no sandflow-cli.tgz.sha256; installing without a checksum check.'
        fi
    else
        what="couldn't download sandflow-cli.tgz from $which"
        warn "$what; building the CLI from source instead (needs git; takes a few minutes)."
        command -v git >/dev/null 2>&1 || die 'building from source needs git (apt install git / brew install git), then rerun.'
        clone_args=(clone --depth 1)
        [ -z "$tag" ] || clone_args+=(--branch "$tag")
        GIT_TERMINAL_PROMPT=0 git "${clone_args[@]}" "https://github.com/$repo.git" "$temporary/src" || die "git clone of $repo failed"
        (cd "$temporary/src" && "$npm" ci --no-audit --no-fund && "$npm" run build:cli) || die 'building the CLI from source failed'
        package_dir="$temporary/src/dist-cli"
        [ -f "$package_dir/package.json" ] || die 'the source build produced no dist-cli/package.json.'
    fi
fi

if [ -z "$package_dir" ]; then
    mkdir "$temporary/extract"
    (cd "$temporary/extract" && tar -xzf ../sandflow-cli.tgz) || die "couldn't extract sandflow-cli.tgz"
    if [ -f "$temporary/extract/package.json" ]; then
        package_dir="$temporary/extract"
    else
        for d in "$temporary/extract"/*/; do
            if [ -f "$d/package.json" ]; then package_dir=${d%/}; break; fi
        done
    fi
    [ -n "$package_dir" ] || die 'the downloaded archive has no package.json.'
fi
[ -f "$package_dir/sandflow.mjs" ] || die 'the CLI package has no sandflow.mjs.'
version=$("$node" -p 'require(process.argv[1]).version' "$package_dir/package.json")

# --- 2. Stage, install runtime dependencies, swap in ---------------------------
step "Installing Sandflow CLI $version into $cli_dir..."
stage="$root/cli.new-$$-$RANDOM"
mv "$package_dir" "$stage"
(cd "$stage" && "$npm" install --omit=dev --no-audit --no-fund) || die 'npm install of the CLI dependencies failed'

if [ -f "$cli_dir/sandflow.mjs" ] && [ -f "$root/daemon.json" ]; then
    printf 'Stopping the running Sandflow daemon so it can be replaced (its runs pause and can continue later)...\n'
    "$node" "$cli_dir/sandflow.mjs" shutdown || true
fi
old=
if [ -e "$cli_dir" ]; then
    old="$root/cli.old-$$-$RANDOM"
    mv "$cli_dir" "$old" || die "couldn't replace $cli_dir. Stop Sandflow (sandflow shutdown) and rerun."
fi
if ! mv "$stage" "$cli_dir"; then
    [ -z "$old" ] || mv "$old" "$cli_dir"
    die "couldn't move the new CLI into $cli_dir"
fi
stage=
[ -z "$old" ] || rm -rf "$old"

# --- 3. Launcher ---------------------------------------------------------------
mkdir -p "$bin_dir"
shim="$bin_dir/sandflow"
{
    printf '#!/bin/sh\n# Sandflow CLI launcher (written by the Sandflow installer).\n'
    printf 'node_bin=%s\n' "$(sq "$node")"
    printf '[ -x "$node_bin" ] || node_bin=node\n'
    printf 'exec "$node_bin" %s "$@"\n' "$(sq "$cli_dir/sandflow.mjs")"
} > "$shim.tmp"
chmod 755 "$shim.tmp"
mv "$shim.tmp" "$shim"

step 'Checking the launcher...'
reported=$("$shim" --version) || die 'the installed sandflow command does not run'
printf 'sandflow --version: %s\n' "$reported"

# --- 4. PATH -------------------------------------------------------------------
marker='# added by the Sandflow installer'
if [ "$bin_dir" = "$HOME/.sandflow/bin" ]; then
    path_line="export PATH=\"\$HOME/.sandflow/bin:\$PATH\" $marker"
else
    path_line="export PATH=$(sq "$bin_dir"):\"\$PATH\" $marker"
fi
if on "${SANDFLOW_NO_PATH:-}"; then
    notes+=("PATH left unchanged (SANDFLOW_NO_PATH); run $shim directly.")
else
    profiles=()
    for f in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do [ -f "$f" ] && profiles+=("$f"); done
    case "${SHELL:-}" in */zsh) [ -f "$HOME/.zshrc" ] || profiles+=("$HOME/.zshrc") ;; esac
    [ "${#profiles[@]}" -gt 0 ] || profiles+=("$HOME/.profile")
    added=()
    for f in "${profiles[@]}"; do
        if ! grep -qF "$marker" "$f" 2>/dev/null; then
            printf '\n%s\n' "$path_line" >> "$f"
            added+=("$f")
        fi
    done
    [ "${#added[@]}" -eq 0 ] || notes+=("Added $bin_dir to PATH in ${added[*]}: open a new terminal to use \`sandflow\`.")
fi
case ":$PATH:" in *":$bin_dir:"*) ;; *) export PATH="$bin_dir:$PATH" ;; esac

# --- 5. Claude Code: plugin and MCP server -------------------------------------
claude=$(command -v claude 2>/dev/null || true)
market_source=${SANDFLOW_MARKETPLACE:-$repo}
add_line="claude mcp add --scope user sandflow -- $(sq "$shim") mcp"
# Classify Claude Code's user-scope `sandflow` MCP entry: none | same | cli (an older `sandflow mcp`) |
# bridge (the desktop app's) | foreign (someone else's) | unreadable.
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
if $want_plugin; then
    if [ -n "$claude" ]; then
        step 'Adding the Claude Code plugin (sand@sandflow)...'
        has_name() { "$node" -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{let l=[];try{l=JSON.parse(s)}catch{}process.exit(Array.isArray(l)&&l.some((m)=>m&&(m.name===process.argv[1]||m.id===process.argv[1]))?0:1)})' "$1"; }
        if "$claude" plugin marketplace list --json 2>/dev/null | has_name sandflow; then
            market_cmd=(plugin marketplace update sandflow)
        else
            market_cmd=(plugin marketplace add "$market_source")
        fi
        if "$claude" "${market_cmd[@]}"; then
            if "$claude" plugin list --json 2>/dev/null | has_name sand@sandflow; then
                plugin_cmd=(plugin update sand@sandflow)
            else
                plugin_cmd=(plugin install sand@sandflow)
            fi
            if "$claude" "${plugin_cmd[@]}"; then
                notes+=('Claude Code plugin sand@sandflow installed: /sand:flow, /sand:schedule, /sand:edit.')
            else
                warn "couldn't install the sand plugin."
                later+=('claude plugin install sand@sandflow')
            fi
        else
            warn "couldn't add the sandflow marketplace."
            later+=("claude plugin marketplace add $market_source" 'claude plugin install sand@sandflow')
        fi
    else
        later+=("claude plugin marketplace add $market_source" 'claude plugin install sand@sandflow')
    fi
fi
if $want_mcp; then
    if [ -n "$claude" ]; then
        step 'Registering the sandflow MCP server with Claude Code (user scope)...'
        claude_json="${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"
        state=$("$node" -e "$mcp_check_js" "$claude_json" "$shim" mcp) || state=unreadable
        add=false
        case "$state" in
            same) notes+=('The sandflow MCP server was already registered with Claude Code.') ;;
            none) add=true ;;
            cli|bridge)
                [ "$state" != bridge ] || notes+=("Replaced the desktop app's sandflow MCP bridge with the CLI's \`sandflow mcp\`.")
                "$claude" mcp remove --scope user sandflow || true
                add=true ;;
            foreign)
                warn 'Claude Code already has a different MCP server named "sandflow"; left it as it is.'
                later+=('claude mcp remove --scope user sandflow   # only if you no longer need it' "$add_line") ;;
            *)
                warn "couldn't read $claude_json; MCP server not registered."
                later+=("$add_line") ;;
        esac
        if $add; then
            if "$claude" mcp add --scope user sandflow -- "$shim" mcp; then
                notes+=('Registered the sandflow MCP server with Claude Code (user scope).')
            else
                warn "couldn't register the MCP server."
                later+=("$add_line")
            fi
        fi
    else
        later+=("$add_line")
    fi
fi
if [ -z "$claude" ] && { $want_plugin || $want_mcp; }; then
    notes+=('Claude Code (claude) was not found on PATH; after installing it run the commands below.')
fi

# --- 6. Hourly checker ---------------------------------------------------------
if $want_checker; then
    step 'Installing the hourly checker...'
    if "$shim" checker install; then
        notes+=('Hourly checker installed: paused runs continue unattended.')
    else
        warn 'sandflow checker install failed.'
        later+=('sandflow checker install')
    fi
fi

printf '\nSandflow CLI %s is installed.\n' "$version"
printf '  CLI:       %s\n  Launcher:  %s\n  Data:      %s\n' "$cli_dir" "$shim" "$root/data"
for n in "${notes[@]+"${notes[@]}"}"; do printf '  - %s\n' "$n"; done
if [ "${#later[@]}" -gt 0 ]; then
    printf '\nRun later:\n'
    for l in "${later[@]}"; do printf '  %s\n' "$l"; done
fi
printf '\nNext:\n'
printf '  Restart Claude Code, then ask it: /sand:flow <your task>\n'
printf '  sandflow --ui      open the Sandflow UI in the browser\n'
printf '  sandflow -r        pick a recent run and continue it\n'
$want_checker || printf '  sandflow checker install   continue paused runs hourly\n'
