# Sandflow CLI + Claude Code plugin installer for Windows (no administrator rights needed).
#
#   irm https://raw.githubusercontent.com/kafuexe/sandflow/main/scripts/install.ps1 | iex
#
# With options:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/kafuexe/sandflow/main/scripts/install.ps1))) -Checker
#
#   -NoPlugin   SANDFLOW_NO_PLUGIN=1   don't add the Claude Code plugin (/sand:flow, /sand:schedule, /sand:edit)
#   -NoMcp      SANDFLOW_NO_MCP=1      don't register the `sandflow` MCP server with Claude Code
#   -Checker    SANDFLOW_CHECKER=1     also install the hourly checker (`sandflow checker install`)
#
# Other environment overrides:
#   SANDFLOW_VERSION      release tag to install (default: the latest release), e.g. v0.2.0
#   SANDFLOW_CLI_URL      a sandflow-cli.tgz URL or local path to install instead of a release asset
#   SANDFLOW_CLI_SHA256   expected sha256 of SANDFLOW_CLI_URL (optional)
#   SANDFLOW_HOME         install root (default: ~\.sandflow)
#   SANDFLOW_REPO         GitHub repo (default: kafuexe/sandflow)
#   SANDFLOW_MARKETPLACE  Claude Code marketplace source (default: the GitHub repo)
#   SANDFLOW_NODE         node.exe to use (default: node on PATH)
#   SANDFLOW_NO_PATH=1    don't add ~\.sandflow\bin to the user PATH
[CmdletBinding()]
param([switch]$NoPlugin, [switch]$NoMcp, [switch]$Checker)

& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    # Windows PowerShell 5.1 may default to TLS 1.0, which GitHub refuses.
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

    function Test-On([string]$value) { return ($value -and @('0', 'false', 'no', 'off') -notcontains $value.Trim().ToLowerInvariant()) }
    function Invoke-Checked([string]$failure) {
        # Native commands don't honor $ErrorActionPreference; check their exit code explicitly.
        if ($LASTEXITCODE -ne 0) { throw "$failure (exit code $LASTEXITCODE)" }
    }
    function Write-Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
    function Write-Warn([string]$text) { Write-Host "warning: $text" -ForegroundColor Yellow }
    function New-Id { return [Guid]::NewGuid().ToString('N').Substring(0, 12) }
    # Run a native command without letting its stderr or exit code stop the script; returns its exit code.
    function Invoke-Soft([string]$exe, [string[]]$arguments) {
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { & $exe @arguments | Out-Host } catch { Write-Warn $_.Exception.Message; return 1 } finally { $ErrorActionPreference = $previous }
        return $LASTEXITCODE
    }
    function Get-Download([string]$url, [string]$file) {
        Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing -Headers @{ 'User-Agent' = 'sandflow-installer' }
    }
    function Get-Sha256([string]$file) { return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }

    function Find-Node {
        $node = $env:SANDFLOW_NODE
        if (-not $node) {
            $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($cmd) { $node = $cmd.Source }
        }
        $help = "Install Node.js 22 or newer, open a new terminal and rerun this installer:`n" +
            "  winget install OpenJS.NodeJS.LTS`n" +
            "  or nvm-windows (https://github.com/coreybutler/nvm-windows): nvm install 22; nvm use 22`n" +
            "  or the installer from https://nodejs.org"
        if (-not $node) { throw "Sandflow needs Node.js 22 or newer, and node wasn't found on PATH.`n$help" }
        $version = "$(& $node -p 'process.versions.node')".Trim()
        if ($LASTEXITCODE -ne 0 -or $version -notmatch '^(\d+)\.') { throw "Couldn't run $node.`n$help" }
        if ([int]$Matches[1] -lt 22) { throw "Sandflow needs Node.js 22 or newer; $node is $version.`n$help" }
        return @{ Path = $node; Version = $version }
    }

    function Find-Npm([string]$node) {
        # npm.cmd, never npm.ps1 (blocked under the default execution policy).
        $beside = Join-Path (Split-Path -Parent $node) 'npm.cmd'
        if (Test-Path -LiteralPath $beside) { return $beside }
        $cmd = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cmd) { return $cmd.Source }
        throw 'npm was not found next to node or on PATH. Reinstall Node.js (it includes npm).'
    }

    # The folder holding package.json inside an extracted tarball (`npm pack` puts everything under package/).
    function Find-PackageRoot([string]$dir) {
        if (Test-Path -LiteralPath (Join-Path $dir 'package.json')) { return $dir }
        $subs = @(Get-ChildItem -LiteralPath $dir -Directory)
        foreach ($sub in $subs) {
            if (Test-Path -LiteralPath (Join-Path $sub.FullName 'package.json')) { return $sub.FullName }
        }
        throw 'The downloaded archive has no package.json.'
    }

    # Ensure `dir` is on the user PATH. Reads the raw registry value so %VARIABLES% in it stay unexpanded and keeps
    # its kind (REG_EXPAND_SZ); no setx, so nothing is truncated.
    function Add-UserPath([string]$dir) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        try {
            $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
            if ($raw) { $kind = $key.GetValueKind('Path') }
            $entries = @($raw -split ';' | Where-Object { $_ })
            $want = $dir.TrimEnd('\')
            foreach ($entry in $entries) {
                if ([Environment]::ExpandEnvironmentVariables($entry).TrimEnd('\') -ieq $want) { return $false }
            }
            $key.SetValue('Path', (($entries + $dir) -join ';'), $kind)
        } finally {
            $key.Close()
        }
        Send-EnvironmentChange
        return $true
    }

    # Tell Explorer (and new terminals) the environment changed, as [Environment]::SetEnvironmentVariable does.
    function Send-EnvironmentChange {
        try {
            if (-not ('SandflowInstaller.Native' -as [type])) {
                Add-Type -Namespace SandflowInstaller -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
            }
            $result = [UIntPtr]::Zero
            [void][SandflowInstaller.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
        } catch {
            Write-Warn 'Open a new terminal to pick up the PATH change.'
        }
    }

    # Classify Claude Code's user-scope `sandflow` MCP entry: none | same | cli (an older `sandflow mcp`) |
    # bridge (the desktop app's) | foreign (someone else's) | unreadable.
    $mcpCheckJs = @'
const fs = require("fs");
const [file, command, ...args] = process.argv.slice(2);
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
'@

    $root = $env:SANDFLOW_HOME
    if (-not $root) { $root = Join-Path $HOME '.sandflow' }
    $root = [IO.Path]::GetFullPath($root)
    $repo = $env:SANDFLOW_REPO
    if (-not $repo) { $repo = 'kafuexe/sandflow' }
    $wantPlugin = -not ($NoPlugin -or (Test-On $env:SANDFLOW_NO_PLUGIN))
    $wantMcp = -not ($NoMcp -or (Test-On $env:SANDFLOW_NO_MCP))
    $wantChecker = $Checker -or (Test-On $env:SANDFLOW_CHECKER)
    $cliDir = Join-Path $root 'cli'
    $binDir = Join-Path $root 'bin'
    $temporary = $null
    $stage = $null
    $notes = New-Object System.Collections.Generic.List[string]

    try {
        Write-Host "`nSandflow installer`n"
        Write-Step 'Checking Node.js...'
        $node = Find-Node
        $npm = Find-Npm $node.Path
        Write-Host "Using node $($node.Version) ($($node.Path))"

        New-Item -ItemType Directory -Force -Path $root | Out-Null
        $temporary = Join-Path $root ('.install-' + (New-Id))
        New-Item -ItemType Directory -Path $temporary | Out-Null
        $tarball = Join-Path $temporary 'sandflow-cli.tgz'
        $packageDir = $null

        # 1. Get the CLI package: a given tarball, a release asset, or a build from source.
        if ($env:SANDFLOW_CLI_URL) {
            $source = $env:SANDFLOW_CLI_URL
            Write-Step "Using the CLI package from $source"
            if ($source -match '^https?://') { Get-Download $source $tarball }
            elseif (Test-Path -LiteralPath $source -PathType Leaf) { Copy-Item -LiteralPath $source -Destination $tarball }
            else { throw "SANDFLOW_CLI_URL is neither a URL nor an existing file: $source" }
            if ($env:SANDFLOW_CLI_SHA256) {
                if ((Get-Sha256 $tarball) -ne $env:SANDFLOW_CLI_SHA256.Trim().ToLowerInvariant()) { throw 'The CLI package does not match SANDFLOW_CLI_SHA256.' }
                Write-Host 'Checksum OK.'
            }
        } else {
            $tag = $env:SANDFLOW_VERSION
            if ($tag -and -not $tag.StartsWith('v')) { $tag = "v$tag" }
            # Release download URLs, not the GitHub API: the API allows 60 anonymous requests an hour per IP, which
            # shared networks and CI run out of. `latest/download` redirects to the newest release's asset.
            $base = "https://github.com/$repo/releases/latest/download"
            $which = 'the latest release'
            if ($tag) { $base = "https://github.com/$repo/releases/download/$tag"; $which = $tag }
            Write-Step "Downloading sandflow-cli.tgz from $which..."
            $downloaded = $true
            try { Get-Download "$base/sandflow-cli.tgz" $tarball } catch { $downloaded = $false }
            if ($downloaded) {
                $sumFile = Join-Path $temporary 'sandflow-cli.tgz.sha256'
                $hasSum = $true
                try { Get-Download "$base/sandflow-cli.tgz.sha256" $sumFile } catch { $hasSum = $false }
                if ($hasSum) {
                    $expected = ((Get-Content -LiteralPath $sumFile -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
                    if ((Get-Sha256 $tarball) -ne $expected) { throw 'The downloaded sandflow-cli.tgz does not match its published sha256; nothing was installed.' }
                    Write-Host 'Checksum OK.'
                } else {
                    Write-Warn 'The release has no sandflow-cli.tgz.sha256; installing without a checksum check.'
                }
            } else {
                $what = "Couldn't download sandflow-cli.tgz from $which"
                Write-Warn "$what; building the CLI from source instead (needs git; takes a few minutes)."
                $git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
                if (-not $git) { throw 'Building from source needs git: winget install Git.Git, then rerun.' }
                $src = Join-Path $temporary 'src'
                $cloneArgs = @('clone', '--depth', '1')
                if ($tag) { $cloneArgs += @('--branch', $tag) }
                $cloneArgs += @("https://github.com/$repo.git", $src)
                $env:GIT_TERMINAL_PROMPT = '0'
                & $git.Source @cloneArgs
                Invoke-Checked "git clone of $repo failed"
                Push-Location -LiteralPath $src
                try {
                    & $npm ci --no-audit --no-fund
                    Invoke-Checked 'npm ci failed'
                    & $npm run build:cli
                    Invoke-Checked 'npm run build:cli failed'
                } finally {
                    Pop-Location
                }
                $packageDir = Join-Path $src 'dist-cli'
                if (-not (Test-Path -LiteralPath (Join-Path $packageDir 'package.json'))) { throw 'The source build produced no dist-cli\package.json.' }
            }
        }

        if (-not $packageDir) {
            $extract = Join-Path $temporary 'extract'
            New-Item -ItemType Directory -Path $extract | Out-Null
            $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
            if (-not (Test-Path -LiteralPath $tar)) { $tar = 'tar' }
            & $tar -xzf $tarball -C $extract
            Invoke-Checked 'Could not extract sandflow-cli.tgz'
            $packageDir = Find-PackageRoot $extract
        }
        if (-not (Test-Path -LiteralPath (Join-Path $packageDir 'sandflow.mjs'))) { throw 'The CLI package has no sandflow.mjs.' }
        $version = "$((Get-Content -LiteralPath (Join-Path $packageDir 'package.json') -Raw | ConvertFrom-Json).version)"

        # 2. Stage next to the install, install its runtime dependencies there, then swap it in.
        Write-Step "Installing Sandflow CLI $version into $cliDir..."
        $stage = Join-Path $root ('cli.new-' + (New-Id))
        Move-Item -LiteralPath $packageDir -Destination $stage
        Push-Location -LiteralPath $stage
        try {
            & $npm install --omit=dev --no-audit --no-fund
            Invoke-Checked 'npm install of the CLI dependencies failed'
        } finally {
            Pop-Location
        }

        $oldMjs = Join-Path $cliDir 'sandflow.mjs'
        if ((Test-Path -LiteralPath $oldMjs) -and (Test-Path -LiteralPath (Join-Path $root 'daemon.json'))) {
            Write-Host 'Stopping the running Sandflow daemon so it can be replaced (its runs pause and can continue later)...'
            [void](Invoke-Soft $node.Path @($oldMjs, 'shutdown'))
        }
        $old = $null
        if (Test-Path -LiteralPath $cliDir) {
            $old = Join-Path $root ('cli.old-' + (New-Id))
            $moved = $false
            for ($i = 0; $i -lt 10 -and -not $moved; $i++) {
                try { Move-Item -LiteralPath $cliDir -Destination $old; $moved = $true } catch { Start-Sleep -Seconds 1 }
            }
            if (-not $moved) { throw "Couldn't replace $cliDir (files in use). Stop Sandflow (sandflow shutdown) and rerun." }
        }
        try {
            Move-Item -LiteralPath $stage -Destination $cliDir
            $stage = $null
        } catch {
            if ($old) { Move-Item -LiteralPath $old -Destination $cliDir }
            throw
        }
        if ($old) { Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue }

        # 3. Launchers in bin\: sandflow.cmd (cmd, Task Scheduler, Claude Code), sandflow.ps1, and sandflow for Git Bash.
        New-Item -ItemType Directory -Force -Path $binDir | Out-Null
        $nodeExe = $node.Path
        if ($nodeExe -match '[^\x20-\x7E]' -or $nodeExe -match '[%&^]') { $nodeExe = 'node' }
        $cmdShim = Join-Path $binDir 'sandflow.cmd'
        $ascii = New-Object System.Text.ASCIIEncoding
        [IO.File]::WriteAllText($cmdShim, ("@echo off`r`n" +
            "rem Sandflow CLI launcher (written by the Sandflow installer).`r`n" +
            "setlocal`r`n" +
            "set `"SANDFLOW_NODE_EXE=$nodeExe`"`r`n" +
            "if not exist `"%SANDFLOW_NODE_EXE%`" set `"SANDFLOW_NODE_EXE=node`"`r`n" +
            "`"%SANDFLOW_NODE_EXE%`" `"%~dp0..\cli\sandflow.mjs`" %*`r`n" +
            "exit /b %ERRORLEVEL%`r`n"), $ascii)
        $psShim = Join-Path $binDir 'sandflow.ps1'
        $quotedNode = $node.Path.Replace("'", "''")
        [IO.File]::WriteAllText($psShim, ("# Sandflow CLI launcher (written by the Sandflow installer).`r`n" +
            "`$node = '$quotedNode'`r`n" +
            "if (-not (Test-Path -LiteralPath `$node)) { `$node = 'node' }`r`n" +
            "& `$node (Join-Path `$PSScriptRoot '..\cli\sandflow.mjs') @args`r`n" +
            "exit `$LASTEXITCODE`r`n"), (New-Object System.Text.UTF8Encoding $true))
        [IO.File]::WriteAllText((Join-Path $binDir 'sandflow'), ("#!/bin/sh`n" +
            "# Sandflow CLI launcher (written by the Sandflow installer).`n" +
            "exec node `"`$(dirname `"`$0`")/../cli/sandflow.mjs`" `"`$@`"`n"), $ascii)

        Write-Step 'Checking the launcher...'
        $reported = "$(& $cmdShim --version)".Trim()
        Invoke-Checked 'The installed sandflow command does not run'
        Write-Host "sandflow --version: $reported"

        # 4. PATH (user scope).
        if (Test-On $env:SANDFLOW_NO_PATH) {
            $notes.Add("PATH left unchanged (SANDFLOW_NO_PATH); run $cmdShim directly.")
        } elseif (Add-UserPath $binDir) {
            $notes.Add("Added $binDir to your user PATH: open a new terminal to use ``sandflow``.")
        }
        if (($env:Path -split ';') -notcontains $binDir) { $env:Path = "$binDir;$env:Path" }

        # 5. Claude Code: the plugin and the MCP server.
        # The first claude on PATH that Windows can run directly (claude.exe, or npm's claude.cmd).
        $claudeExe = @(Get-Command claude -CommandType Application -ErrorAction SilentlyContinue |
            Where-Object { @('.exe', '.cmd', '.bat') -contains [IO.Path]::GetExtension($_.Source).ToLowerInvariant() }) | Select-Object -First 1
        $marketSource = $env:SANDFLOW_MARKETPLACE
        if (-not $marketSource) { $marketSource = $repo }
        $mcpCommand = @('cmd', '/c', $cmdShim, 'mcp')
        $later = New-Object System.Collections.Generic.List[string]
        if ($wantPlugin) {
            if ($claudeExe) {
                Write-Step 'Adding the Claude Code plugin (sand@sandflow)...'
                $claudePath = $claudeExe.Source
                $previous = $ErrorActionPreference
                $ErrorActionPreference = 'Continue'
                $markets = $null
                try { $markets = (& $claudePath plugin marketplace list --json 2>$null | Out-String) | ConvertFrom-Json } catch { $markets = $null }
                $installed = $null
                try { $installed = (& $claudePath plugin list --json 2>$null | Out-String) | ConvertFrom-Json } catch { $installed = $null }
                $ErrorActionPreference = $previous
                if (@($markets | Where-Object { $_.name -eq 'sandflow' }).Count -gt 0) {
                    $code = Invoke-Soft $claudePath @('plugin', 'marketplace', 'update', 'sandflow')
                } else {
                    $code = Invoke-Soft $claudePath @('plugin', 'marketplace', 'add', $marketSource)
                }
                if ($code -ne 0) {
                    Write-Warn "Couldn't add the sandflow marketplace."
                    $later.Add("claude plugin marketplace add $marketSource")
                    $later.Add('claude plugin install sand@sandflow')
                } else {
                    if (@($installed | Where-Object { $_.id -eq 'sand@sandflow' }).Count -gt 0) {
                        $code = Invoke-Soft $claudePath @('plugin', 'update', 'sand@sandflow')
                    } else {
                        $code = Invoke-Soft $claudePath @('plugin', 'install', 'sand@sandflow')
                    }
                    if ($code -ne 0) { Write-Warn "Couldn't install the sand plugin."; $later.Add('claude plugin install sand@sandflow') }
                    else { $notes.Add('Claude Code plugin sand@sandflow installed: /sand:flow, /sand:schedule, /sand:edit.') }
                }
            } else {
                $later.Add("claude plugin marketplace add $marketSource")
                $later.Add('claude plugin install sand@sandflow')
            }
        }
        if ($wantMcp) {
            $addLine = "claude mcp add --scope user sandflow -- cmd /c `"$cmdShim`" mcp"
            if ($claudeExe) {
                Write-Step 'Registering the sandflow MCP server with Claude Code (user scope)...'
                $claudePath = $claudeExe.Source
                $claudeJson = Join-Path $HOME '.claude.json'
                if ($env:CLAUDE_CONFIG_DIR) { $claudeJson = Join-Path $env:CLAUDE_CONFIG_DIR '.claude.json' }
                $checkFile = Join-Path $temporary 'mcp-check.cjs'
                [IO.File]::WriteAllText($checkFile, $mcpCheckJs, $ascii)
                $state = "$(& $node.Path $checkFile $claudeJson @mcpCommand)".Trim()
                Invoke-Checked 'Could not inspect the Claude Code configuration'
                $add = $false
                switch ($state) {
                    'same' { $notes.Add('The sandflow MCP server was already registered with Claude Code.') }
                    'none' { $add = $true }
                    'unreadable' { Write-Warn "Couldn't read $claudeJson; MCP server not registered."; $later.Add($addLine) }
                    'foreign' {
                        Write-Warn 'Claude Code already has a different MCP server named "sandflow"; left it as it is.'
                        $later.Add('claude mcp remove --scope user sandflow   # only if you no longer need it')
                        $later.Add($addLine)
                    }
                    { $_ -eq 'cli' -or $_ -eq 'bridge' } {
                        # An older `sandflow mcp`, or the desktop app's bridge: ours to replace.
                        if ($state -eq 'bridge') { $notes.Add("Replaced the desktop app's sandflow MCP bridge with the CLI's ``sandflow mcp``.") }
                        [void](Invoke-Soft $claudePath @('mcp', 'remove', '--scope', 'user', 'sandflow'))
                        $add = $true
                    }
                    default { Write-Warn "Unexpected MCP check result '$state'; MCP server not registered."; $later.Add($addLine) }
                }
                if ($add) {
                    $code = Invoke-Soft $claudePath (@('mcp', 'add', '--scope', 'user', 'sandflow', '--') + $mcpCommand)
                    if ($code -ne 0) { Write-Warn "Couldn't register the MCP server."; $later.Add($addLine) }
                    else { $notes.Add('Registered the sandflow MCP server with Claude Code (user scope).') }
                }
            } else {
                $later.Add($addLine)
            }
        }
        if (-not $claudeExe -and ($wantPlugin -or $wantMcp)) {
            $notes.Add('Claude Code (claude) was not found on PATH; after installing it run the commands below.')
        }

        # 6. The hourly checker.
        if ($wantChecker) {
            Write-Step 'Installing the hourly checker...'
            if ((Invoke-Soft $cmdShim @('checker', 'install')) -ne 0) { Write-Warn 'sandflow checker install failed.'; $later.Add('sandflow checker install') }
            else { $notes.Add('Hourly checker installed: paused runs continue unattended.') }
        }

        Write-Host ''
        Write-Host "Sandflow CLI $version is installed." -ForegroundColor Green
        Write-Host "  CLI:       $cliDir"
        Write-Host "  Launcher:  $cmdShim"
        Write-Host "  Data:      $(Join-Path $root 'data')"
        foreach ($note in $notes) { Write-Host "  - $note" }
        if ($later.Count -gt 0) {
            Write-Host "`nRun later:"
            foreach ($line in $later) { Write-Host "  $line" }
        }
        Write-Host "`nNext:"
        Write-Host '  Restart Claude Code, then ask it: /sand:flow <your task>'
        Write-Host '  sandflow --ui      open the Sandflow UI in the browser'
        Write-Host '  sandflow -r        pick a recent run and continue it'
        if (-not $wantChecker) { Write-Host '  sandflow checker install   continue paused runs hourly' }
    } catch {
        Write-Host "Sandflow installation failed: $($_.Exception.Message)" -ForegroundColor Red
        $global:LASTEXITCODE = 1
        if ($PSCommandPath) { exit 1 }
    } finally {
        # Only delete the exact random folders this run created under the install root.
        foreach ($dir in @($temporary, $stage)) {
            if ($dir -and (Test-Path -LiteralPath $dir)) {
                $resolved = [IO.Path]::GetFullPath($dir)
                if ($resolved.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
                    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
                }
            }
        }
    }
}
