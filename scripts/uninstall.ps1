# Removes the Sandflow CLI, its launcher and PATH entry, the hourly checker, pending schedules, the Claude Code
# plugin and the MCP entry the installer registered. Keeps ~\.sandflow\data and history.jsonl unless -Purge.
#
#   irm https://raw.githubusercontent.com/kafuexe/sandflow/main/scripts/uninstall.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/kafuexe/sandflow/main/scripts/uninstall.ps1))) -Purge
#
#   -Purge   SANDFLOW_PURGE=1   also delete ~\.sandflow entirely (flows, settings, run data, history)
#   SANDFLOW_HOME (install root), SANDFLOW_NO_PATH=1 (leave the user PATH alone) as for install.ps1.
[CmdletBinding()]
param([switch]$Purge)

& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'

    function Test-On([string]$value) { return ($value -and @('0', 'false', 'no', 'off') -notcontains $value.Trim().ToLowerInvariant()) }
    function Write-Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
    function Write-Warn([string]$text) { Write-Host "warning: $text" -ForegroundColor Yellow }
    function Invoke-Soft([string]$exe, [string[]]$arguments) {
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { & $exe @arguments | Out-Host } catch { Write-Warn $_.Exception.Message; return 1 } finally { $ErrorActionPreference = $previous }
        return $LASTEXITCODE
    }
    function Get-Json([string]$exe, [string[]]$arguments) {
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { return (& $exe @arguments 2>$null | Out-String) | ConvertFrom-Json } catch { return $null } finally { $ErrorActionPreference = $previous }
    }

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
    $doPurge = $Purge -or (Test-On $env:SANDFLOW_PURGE)
    $cliDir = Join-Path $root 'cli'
    $binDir = Join-Path $root 'bin'
    $cmdShim = Join-Path $binDir 'sandflow.cmd'
    $mjs = Join-Path $cliDir 'sandflow.mjs'
    $nodeCmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $node = $env:SANDFLOW_NODE
    if (-not $node -and $nodeCmd) { $node = $nodeCmd.Source }

    try {
        Write-Host "`nSandflow uninstaller`n"

        # 1. Things the CLI registered with the OS: the checker, pending schedules; then stop the daemon.
        if ($node -and (Test-Path -LiteralPath $mjs)) {
            Write-Step 'Removing the hourly checker and pending schedules...'
            [void](Invoke-Soft $node @($mjs, 'checker', 'uninstall'))
            $list = Get-Json $node @($mjs, 'schedule', 'list', '--json')
            $items = @()
            if ($list -is [array]) { $items = $list } elseif ($list -and $list.schedules) { $items = @($list.schedules) }
            foreach ($item in $items) {
                if ($item.id -and $item.state -eq 'scheduled') { [void](Invoke-Soft $node @($mjs, 'schedule', 'cancel', "$($item.id)")) }
            }
            if (Test-Path -LiteralPath (Join-Path $root 'daemon.json')) {
                Write-Step 'Stopping the Sandflow daemon...'
                [void](Invoke-Soft $node @($mjs, 'shutdown'))
            }
        }

        # 2. Claude Code.
        $claude = @(Get-Command claude -CommandType Application -ErrorAction SilentlyContinue |
            Where-Object { @('.exe', '.cmd', '.bat') -contains [IO.Path]::GetExtension($_.Source).ToLowerInvariant() }) | Select-Object -First 1
        if ($claude) {
            $claudePath = $claude.Source
            Write-Step 'Removing the Claude Code plugin...'
            if (@(Get-Json $claudePath @('plugin', 'list', '--json') | Where-Object { $_.id -eq 'sand@sandflow' }).Count -gt 0) {
                [void](Invoke-Soft $claudePath @('plugin', 'uninstall', 'sand@sandflow'))
            }
            if (@(Get-Json $claudePath @('plugin', 'marketplace', 'list', '--json') | Where-Object { $_.name -eq 'sandflow' }).Count -gt 0) {
                [void](Invoke-Soft $claudePath @('plugin', 'marketplace', 'remove', 'sandflow'))
            }
            if ($node) {
                $claudeJson = Join-Path $HOME '.claude.json'
                if ($env:CLAUDE_CONFIG_DIR) { $claudeJson = Join-Path $env:CLAUDE_CONFIG_DIR '.claude.json' }
                $checkFile = Join-Path ([IO.Path]::GetTempPath()) ('sandflow-mcp-check-' + [Guid]::NewGuid().ToString('N') + '.cjs')
                [IO.File]::WriteAllText($checkFile, $mcpCheckJs, (New-Object System.Text.ASCIIEncoding))
                try { $state = "$(& $node $checkFile $claudeJson cmd /c $cmdShim mcp)".Trim() } finally { Remove-Item -LiteralPath $checkFile -Force -ErrorAction SilentlyContinue }
                if ($state -eq 'same' -or $state -eq 'cli') {
                    Write-Step 'Removing the sandflow MCP server from Claude Code...'
                    [void](Invoke-Soft $claudePath @('mcp', 'remove', '--scope', 'user', 'sandflow'))
                } elseif ($state -eq 'bridge') {
                    Write-Host "Left the desktop app's sandflow MCP server in Claude Code (the app manages it)."
                } elseif ($state -eq 'foreign') {
                    Write-Host 'Left the "sandflow" MCP server in Claude Code: the installer did not register it.'
                }
            }
        } else {
            Write-Host 'Claude Code (claude) not found; if you added them, remove later with:'
            Write-Host '  claude plugin uninstall sand@sandflow; claude plugin marketplace remove sandflow; claude mcp remove --scope user sandflow'
        }

        # 3. The user PATH entry.
        if (-not (Test-On $env:SANDFLOW_NO_PATH)) {
            $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
            try {
                $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                $entries = @($raw -split ';' | Where-Object { $_ })
                $kept = @($entries | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ine $binDir.TrimEnd('\') })
                if ($kept.Count -ne $entries.Count) {
                    $key.SetValue('Path', ($kept -join ';'), $key.GetValueKind('Path'))
                    Write-Step "Removed $binDir from your user PATH."
                    # Broadcast the change (same as [Environment]::SetEnvironmentVariable does).
                    try {
                        if (-not ('SandflowInstaller.Native' -as [type])) {
                            Add-Type -Namespace SandflowInstaller -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
                        }
                        $result = [UIntPtr]::Zero
                        [void][SandflowInstaller.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
                    } catch { }
                }
            } finally {
                $key.Close()
            }
        }

        # 4. Files.
        if ($doPurge) {
            Write-Step "Deleting $root (flows, settings, run data and history)..."
            if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
        } else {
            Write-Step "Removing the CLI and launcher from $root..."
            foreach ($item in @($cliDir, $binDir, (Join-Path $root 'daemon.json'))) {
                if (Test-Path -LiteralPath $item) { Remove-Item -LiteralPath $item -Recurse -Force }
            }
            Write-Host "Kept your data in $root (data, history.jsonl, schedule logs). Rerun with -Purge to delete it too."
        }
        Write-Host "`nSandflow CLI uninstalled. Restart Claude Code to unload the plugin." -ForegroundColor Green
    } catch {
        Write-Host "Sandflow uninstall failed: $($_.Exception.Message)" -ForegroundColor Red
        $global:LASTEXITCODE = 1
        if ($PSCommandPath) { exit 1 }
    }
}
