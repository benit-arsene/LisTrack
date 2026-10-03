<#
.SYNOPSIS
    LisTrack Windows Desktop - foreground-application detector (proof of concept).

.DESCRIPTION
    LOCAL DEVELOPMENT ONLY. Polls the Win32 foreground window, resolves it to an
    executable name, and logs every application switch plus the duration the
    previous application was active. Everything stays in memory; nothing is
    written to disk, no network, no telemetry.

    Collects ONLY: executable/application identity, foreground state, timestamps.
    Does NOT collect: window contents, keystrokes, screenshots, URLs, passwords,
    clipboard, microphone, camera, files, or message contents.

    Run:
        powershell -ExecutionPolicy Bypass -File .\scripts\foreground-watch.ps1
        or double-click: .\scripts\run-foreground-watch.bat

.PARAMETER IntervalSeconds
    Polling interval in seconds (default 1).

.PARAMETER MaxSeconds
    Auto-stop after N seconds (default 0 = run until Ctrl+C).
#>
[CmdletBinding()]
param(
    [int]$IntervalSeconds = 1,
    [int]$MaxSeconds = 0
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ─── Win32 P/Invoke (foreground window + owning process id) ─────────────────
if (-not ('ForegroundWin32' -as [System.Type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ForegroundWin32 {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint lpdwProcessId);
}
'@
}

# ─── Resolve the foreground window to an executable name ────────────────────
function Get-ForegroundProcessName {
    $hwnd = [ForegroundWin32]::GetForegroundWindow()
    if ($hwnd -eq [IntPtr]::Zero) { return '(none)' }

    $pidVal = [UInt32]0
    $null = [ForegroundWin32]::GetWindowThreadProcessId($hwnd, [ref]$pidVal)
    if ($pidVal -eq 0) { return '(none)' }

    try {
        $proc = [System.Diagnostics.Process]::GetProcessById($pidVal)
        if ($proc -ne $null -and $proc.ProcessName) {
            return $proc.ProcessName + '.exe'
        }
    } catch {
        # Process vanished, or access denied (different user / elevation).
    }
    return '(unknown)'
}

# ─── Main loop ──────────────────────────────────────────────────────────────
$sessionStart = Get-Date
$currentApp = $null
$appStart = $sessionStart
$summary = New-Object System.Collections.Generic.List[string]

$cancel = $false
try {
    [System.Console]::CancelKeyPress.Add({
        $global:cancel = $true
    })
} catch {
    # No console attached (e.g. redirected output) - Ctrl+C not observable.
}

Write-Host "LisTrack foreground watcher (PoC) - Ctrl+C to stop; switches logged below."
while (-not $cancel) {
    $app = Get-ForegroundProcessName
    $now = Get-Date

    if ($app -ne $currentApp) {
        if ($currentApp -ne $null) {
            $duration = [Math]::Round(($now - $appStart).TotalSeconds)
            $summary.Add("$currentApp`: $duration seconds") | Out-Null
            Write-Host "$currentApp`: $duration seconds"
        }
        Write-Host "[$($now.ToString('HH:mm:ss'))] Active: $app"
        $currentApp = $app
        $appStart = $now
    }

    if ($MaxSeconds -gt 0 -and (($now - $sessionStart).TotalSeconds) -ge $MaxSeconds) {
        break
    }

    Start-Sleep -Seconds $IntervalSeconds
}

Write-Host ""
Write-Host "Session summary:"
if ($summary.Count -eq 0) {
    Write-Host "(no switches recorded)"
} else {
    $summary | ForEach-Object { Write-Host $_ }
}