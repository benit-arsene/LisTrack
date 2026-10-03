<#
.SYNOPSIS
    LisTrack Windows Desktop - foreground-application detector (proof of concept).

.DESNOPSIS
    LOCAL DEVELOPMENT ONLY. Polls the Win32 foreground window, resolves it to an
    executable name, and accumulates per-application time. Everything stays in
    memory; nothing is written to disk, no network, no telemetry.

    Application time accumulates ONLY while the machine is Active. The idle age
    is read with GetLastInputInfo (see .\idle-age.ps1) and converted to a state
    with Get-IdleState (see .\idle-state.ps1). While the state is Idle the
    accumulator is paused, so idle time is never credited to any application:

        Active -> app accumulates from the start of the active period
        Idle   -> active period is closed at the exact instant the idle began
        Active -> accumulation resumes from the resume point

    Collects ONLY: executable/application identity, active/idle state,
    timestamps, durations.
    Does NOT collect: which key or mouse button was used, keyboard text, mouse
    coordinates, window titles, window contents, screenshots, clipboard,
    browser URLs, files, messages, microphone, or camera. GetLastInputInfo
    returns a timestamp only - no keyboard or mouse hook is installed.

    Run:
        powershell -ExecutionPolicy Bypass -File .\scripts\foreground-watch.ps1
        or double-click: .\scripts\run-foreground-watch.bat

.PARAMETER IntervalSeconds
    Polling interval in seconds (default 1).

.PARAMETER MaxSeconds
    Auto-stop after N seconds (default 0 = run until Ctrl+C).

.PARAMETER IdleThresholdSeconds
    Seconds without input before the machine is treated as Idle (default 60).
    This is the only idle threshold in the watcher; it is passed straight to
    Get-IdleState, which owns the decision logic.
#>
[CmdletBinding()]
param(
    [int]$IntervalSeconds = 1,
    [int]$MaxSeconds = 0,
    [int]$IdleThresholdSeconds = 60
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ─── Idle helpers (proved independently; not reimplemented here) ────────────
# Capture the parameters under distinct names FIRST. Dot-sourcing a script runs
# its param block in the caller's scope, so idle-state.ps1 and idle-age.ps1
# would otherwise overwrite $IdleThresholdSeconds with their own default of 60
# and silently discard whatever the caller passed to this watcher.
$pollIntervalSeconds = $IntervalSeconds
$runMaxSeconds      = $MaxSeconds
$idleThreshold      = $IdleThresholdSeconds

$helpers = @('idle-state.ps1', 'idle-age.ps1')
foreach ($helper in $helpers) {
    $helperPath = Join-Path $PSScriptRoot $helper
    if (-not (Test-Path -LiteralPath $helperPath)) {
        throw "Required idle helper not found next to this script: $helperPath"
    }
    . $helperPath
}
foreach ($fn in @('Get-IdleState', 'Get-IdleAgeSeconds')) {
    if (-not (Get-Command -Name $fn -ErrorAction SilentlyContinue)) {
        throw "Idle helper did not provide '$fn'; check scripts\$($helpers -join ' and scripts\')."
    }
}

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

# ─── Idle-aware accumulator ────────────────────────────────────────────────
# State machine, advanced one poll sample at a time. It is deliberately pure:
# every input is a scripted value (app name, timestamp, idle age), so the whole
# thing is testable without waiting and without touching Win32.
function New-ActivityAccumulator {
    [CmdletBinding()]
    param()

    return [PSCustomObject]@{
        Totals        = @{}      # app name -> accumulated ACTIVE seconds
        CurrentApp    = $null    # foreground app, tracked even while idle
        AppStart      = $null    # UTC start of the open active period; $null while idle
        LastState     = $null    # 'Active' / 'Idle', $null before the first sample
        IdleSince     = $null    # exact UTC start of the open idle period
        IdleSeconds   = 0.0      # completed idle seconds (never credited to an app)
        ActiveSeconds = 0.0      # completed active seconds (diagnostics only)
    }
}

function Add-ActivityTime {
    # Credits one app with a duration. Negative durations are clamped to 0 so an
    # app that became foreground after the idle already began earns nothing.
    [CmdletBinding()]
    param(
        $Accumulator,
        [string]$App,
        [TimeSpan]$Duration
    )

    if ($null -eq $App) { return }

    $seconds = [Math]::Round([Math]::Max(0.0, $Duration.TotalSeconds))
    if (-not $Accumulator.Totals.ContainsKey($App)) { $Accumulator.Totals[$App] = 0 }
    $Accumulator.Totals[$App] += $seconds
    $Accumulator.ActiveSeconds += $seconds
}

function Step-ActivityAccumulator {
    <#
    .SYNOPSIS
        Advances the accumulator by one poll sample and returns any log lines.

    .DESCRIPTION
        Uses a single UTC clock. The only difference from the pre-idle logic is
        that the active period is closed at the exact instant the idle began
        (sample time minus idle age) instead of at the sample time, so the
        seconds spent idle are never attributed to the application.

        Mutates and returns $Accumulator.

    .PARAMETER Accumulator
        State from New-ActivityAccumulator.

    .PARAMETER App
        Foreground executable name for this sample.

    .PARAMETER Timestamp
        UTC sample time.

    .PARAMETER IdleState
        'Active' or 'Idle', as decided by Get-IdleState.

    .PARAMETER IdleAgeSeconds
        Idle age for this sample, used to locate the exact idle boundary.
    #>
    [CmdletBinding()]
    param(
        $Accumulator,
        [string]$App,
        [datetime]$Timestamp,
        [string]$IdleState,
        $IdleAgeSeconds = 0
    )

    $events = New-Object System.Collections.Generic.List[string]
    $stamp  = $Timestamp.ToString('HH:mm:ss')
    $prev   = $Accumulator.LastState

    # Exact instant the current idle period started. Invalid ages are ignored so
    # a bad reading can never invent or erase active time.
    $idleStart = $null
    if ($null -ne $IdleAgeSeconds) {
        $age = [double]$IdleAgeSeconds
        if (-not [double]::IsNaN($age) -and -not [double]::IsInfinity($age) -and $age -ge 0) {
            $idleStart = $Timestamp.AddSeconds(-1 * $age)
        }
    }

    switch ($IdleState) {
        'Active' {
            if ($prev -ne 'Active') {
                # Entering Active: resume (or open) an active period now. Any
                # app that was foreground during the idle earns nothing.
                if ($prev -eq 'Idle' -and $null -ne $Accumulator.IdleSince) {
                    $Accumulator.IdleSeconds += ($Timestamp - $Accumulator.IdleSince).TotalSeconds
                    $Accumulator.IdleSince = $null
                }
                $Accumulator.CurrentApp = $App
                $Accumulator.AppStart   = $Timestamp
                $events.Add("[$stamp] Active: $App") | Out-Null
            } elseif ($App -ne $Accumulator.CurrentApp) {
                # Still active, foreground changed: ordinary switch.
                Add-ActivityTime -Accumulator $Accumulator -App $Accumulator.CurrentApp `
                                 -Duration ($Timestamp - $Accumulator.AppStart)
                $Accumulator.CurrentApp = $App
                $Accumulator.AppStart   = $Timestamp
                $events.Add("[$stamp] Active: $App") | Out-Null
            }
        }

        'Idle' {
            if ($prev -ne 'Idle') {
                # Entering Idle: close the active period at the idle boundary,
                # never at the sample time, so idle seconds stay excluded.
                if ($null -ne $Accumulator.AppStart) {
                    $creditEnd = $idleStart
                    if ($null -eq $creditEnd -or $creditEnd -lt $Accumulator.AppStart) {
                        $creditEnd = $Accumulator.AppStart
                    }
                    Add-ActivityTime -Accumulator $Accumulator -App $Accumulator.CurrentApp `
                                     -Duration ($creditEnd - $Accumulator.AppStart)
                }
                $Accumulator.AppStart  = $null
                $Accumulator.IdleSince = $idleStart
                $Accumulator.CurrentApp = $App

                $shown = 0.0
                if ($null -ne $idleStart) { $shown = [Math]::Round([double]$IdleAgeSeconds, 1) }
                $events.Add("[$stamp] Idle: $shown seconds") | Out-Null
            } elseif ($App -ne $Accumulator.CurrentApp) {
                # Switch while already idle: remember the app so the resume
                # credits the right one, but credit nothing now.
                $Accumulator.CurrentApp = $App
                $events.Add("[$stamp] Idle: $App (foreground changed while idle)") | Out-Null
            }
        }

        default {
            throw "Unknown idle state '$IdleState'; expected 'Active' or 'Idle'."
        }
    }

    $Accumulator.LastState = $IdleState
    return [PSCustomObject]@{ State = $Accumulator; Events = $events }
}

function Stop-ActivityAccumulator {
    <#
    .SYNOPSIS
        Closes the open period and returns the final accumulator.

    .DESCRIPTION
        Credits the open active period if the session ended while Active.
        An open idle period is added to the idle total, never to an app.
    #>
    [CmdletBinding()]
    param(
        $Accumulator,
        [datetime]$Timestamp
    )

    if ($Accumulator.LastState -eq 'Active' -and $null -ne $Accumulator.AppStart) {
        Add-ActivityTime -Accumulator $Accumulator -App $Accumulator.CurrentApp `
                         -Duration ($Timestamp - $Accumulator.AppStart)
    }
    if ($null -ne $Accumulator.IdleSince) {
        $Accumulator.IdleSeconds += ($Timestamp - $Accumulator.IdleSince).TotalSeconds
        $Accumulator.IdleSince = $null
    }
    $Accumulator.AppStart = $null
    return $Accumulator
}

function Invoke-ActivityLoop {
    <#
    .SYNOPSIS
        Polls the foreground app and the idle state until stopped.

    .DESCRIPTION
        One code path for both the real run and the tests: every external
        dependency is a scriptblock, so tests inject scripted readings and a
        scripted clock and never wait.

    .PARAMETER AppProvider
        Scriptblock returning the foreground executable name.

    .PARAMETER IdleProbe
        Scriptblock returning @{ AgeSeconds = <number>; State = 'Active'|'Idle' }.

    .PARAMETER Clock
        Scriptblock returning the current UTC time.

    .PARAMETER EventSink
        Scriptblock receiving each log line (default Write-Host).

    .PARAMETER Delay
        Scriptblock performing the poll delay. Production sleeps; tests no-op.

    .PARAMETER ShouldStop
        Scriptblock returning $true to end the loop.
    #>
    [CmdletBinding()]
    param(
        [scriptblock]$AppProvider,
        [scriptblock]$IdleProbe,
        [scriptblock]$Clock,
        [scriptblock]$EventSink,
        [scriptblock]$Delay,
        [scriptblock]$ShouldStop,
        [int]$IntervalSeconds = 1,
        [int]$MaxSeconds = 0
    )

    if ($null -eq $EventSink) { $EventSink = { param($line) Write-Host $line } }

    $accumulator = New-ActivityAccumulator
    $sessionStart = $null

    while ($true) {
        if ($null -ne $ShouldStop -and (& $ShouldStop)) { break }

        $app   = & $AppProvider
        $probe = & $IdleProbe
        $now   = & $Clock

        # Taken from the first sample so the clock is read exactly once per
        # poll; a scripted clock must not be consumed before the loop starts.
        if ($null -eq $sessionStart) { $sessionStart = $now }

        $step = Step-ActivityAccumulator -Accumulator $accumulator -App ([string]$app) `
                    -Timestamp $now -IdleState $probe['State'] -IdleAgeSeconds $probe['AgeSeconds']
        $accumulator = $step.State

        foreach ($line in $step.Events) { & $EventSink $line }

        if ($MaxSeconds -gt 0 -and (($now - $sessionStart).TotalSeconds) -ge $MaxSeconds) { break }
        if ($null -ne $Delay) { & $Delay }
    }

    return $accumulator
}

function Get-IdleProbe {
    <#
    .SYNOPSIS
        Turns one idle-age reading into the probe the activity loop consumes.

    .DESCRIPTION
        The threshold is passed in explicitly rather than read from a script
        variable, so the decision cannot be changed by another script's param
        block.
    #>
    [CmdletBinding()]
    param(
        $IdleAgeSeconds,
        [int]$IdleThresholdSeconds
    )

    return @{
        AgeSeconds = $IdleAgeSeconds
        State      = (Get-IdleState -LastInputAgeSeconds $IdleAgeSeconds `
                                 -IdleThresholdSeconds $IdleThresholdSeconds)
    }
}

# ─── Main ───────────────────────────────────────────────────────────────────
# Run only when this file is executed, so tests can dot-source the functions
# above instead of starting a watcher.
if ($MyInvocation.InvocationName -ne '.') {

    $cancel = $false
    try {
        [System.Console]::CancelKeyPress.Add({
            $global:cancel = $true
        })
    } catch {
        # No console attached (e.g. redirected output) - Ctrl+C not observable.
    }

    Write-Host "LisTrack foreground watcher (PoC) - Ctrl+C to stop; switches logged below."
    Write-Host "Idle threshold: $idleThreshold seconds (application time accrues only while Active)."

    $accumulator = Invoke-ActivityLoop `
        -AppProvider { Get-ForegroundProcessName } `
        -IdleProbe {
            Get-IdleProbe -IdleAgeSeconds (Get-IdleAgeSeconds) -IdleThresholdSeconds $idleThreshold
        } `
        -Clock { [System.DateTime]::UtcNow } `
        -EventSink { param($line) Write-Host $line } `
        -Delay { Start-Sleep -Seconds $pollIntervalSeconds } `
        -ShouldStop { $global:cancel } `
        -IntervalSeconds $pollIntervalSeconds `
        -MaxSeconds $runMaxSeconds

    $accumulator = Stop-ActivityAccumulator -Accumulator $accumulator -Timestamp ([System.DateTime]::UtcNow)

    Write-Host ""
    Write-Host "Session summary:"
    if ($accumulator.Totals.Count -eq 0) {
        Write-Host "(no activity recorded)"
    } else {
        foreach ($app in ($accumulator.Totals.Keys | Sort-Object)) {
            Write-Host "$app`: $($accumulator.Totals[$app]) seconds"
        }
    }
    if ($accumulator.IdleSeconds -gt 0) {
        $idle = [Math]::Round($accumulator.IdleSeconds)
        Write-Host "Idle (not attributed to any app): $idle seconds"
    }
}
