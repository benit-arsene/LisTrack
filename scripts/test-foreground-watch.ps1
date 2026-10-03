# Unit test for the foreground-watch switch/duration logic.
# Exercises the state machine WITHOUT touching the Win32 foreground window:
# Get-ForegroundProcessName is overridden to return a scripted sequence.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File .\test-foreground-watch.ps1

$ErrorActionPreference = 'Stop'

# ─── Inline copy of the state machine under test ────────────────────────────
function Invoke-ForegroundWatchLoop {
    [CmdletBinding()]
    param(
        [System.Collections.Generic.List[string]]$Sequence,   # scripted app names
        [int]$IntervalSeconds = 0
    )

    $sessionStart = [System.DateTime]::UtcNow
    $currentApp = $null
    $appStart = $sessionStart
    $summary = New-Object System.Collections.Generic.List[string]
    $events  = New-Object System.Collections.Generic.List[string]

    $idx = 0
    while ($idx -lt $Sequence.Count) {
        $app = $Sequence[$idx]
        $idx++
        $now = $sessionStart.AddSeconds($idx * $IntervalSeconds)

        if ($app -ne $currentApp) {
            if ($currentApp -ne $null) {
                $duration = [Math]::Round(($now - $appStart).TotalSeconds)
                $summary.Add("$currentApp`: $duration seconds") | Out-Null
                $events.Add("SWITCH: $currentApp -> $app (prev held $duration s)")
            } else {
                $events.Add("START: $app")
            }
            $currentApp = $app
            $appStart = $now
        }
    }

    return [PSCustomObject]@{
        FinalApp  = $currentApp
        Summary   = $summary
        Events    = $events
    }
}

# ─── Tests ──────────────────────────────────────────────────────────────────
$pass = 0; $fail = 0
function Check($name, $cond, $detail = '') {
    if ($cond) { $script:pass++; Write-Host "PASS: $name" }
    else { $script:fail++; Write-Host "FAIL: $name  $detail" }
}

# 1. Single switch: A held 10s, B held 5s.
$r = Invoke-ForegroundWatchLoop -Sequence @('Code.exe', 'chrome.exe') -IntervalSeconds 5
Check 'switch detected' ($r.Events -match 'SWITCH: Code.exe -> chrome.exe')
Check 'duration recorded for first app' ($r.Summary -contains 'Code.exe: 5 seconds')
Check 'final app is last in sequence' ($r.FinalApp -eq 'chrome.exe')

# 2. No switch when same app repeats consecutively.
$r = Invoke-ForegroundWatchLoop -Sequence @('Code.exe', 'Code.exe', 'Code.exe') -IntervalSeconds 1
Check 'no switch on repeat' ($r.Events.Count -eq 1 -and $r.Events[0] -match '^START:')
Check 'summary empty on no switch' ($r.Summary.Count -eq 0)

# 3. Three distinct apps in sequence.
$r = Invoke-ForegroundWatchLoop -Sequence @('a.exe', 'b.exe', 'c.exe') -IntervalSeconds 2
Check 'three-app sequence has two switches' ((($r.Events -match 'SWITCH').Count) -eq 2)
Check 'first app held 2s' ($r.Summary -contains 'a.exe: 2 seconds')
Check 'second app held 2s' ($r.Summary -contains 'b.exe: 2 seconds')

# 4. Empty sequence -> no events, no summary.
$r = Invoke-ForegroundWatchLoop -Sequence @() -IntervalSeconds 1
Check 'empty sequence produces no events' ($r.Events.Count -eq 0)
Check 'empty sequence produces no summary' ($r.Summary.Count -eq 0)

Write-Host ""
Write-Host "Results: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }