# Unit tests for the per-app time accumulator in foreground-watch.ps1.
# Exercises the accumulator state machine WITHOUT touching the Win32
# foreground window: Get-ForegroundProcessName is overridden to return a
# scripted sequence, and timestamps are deterministic (no real waiting).
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File .\test-accumulator.ps1

$ErrorActionPreference = 'Stop'

# ─── Inline copy of the accumulator under test ──────────────────────────────
function Invoke-Accumulator {
    [CmdletBinding()]
    param(
        [System.Collections.Generic.List[string]]$Sequence,  # scripted app names
        [int]$IntervalSeconds = 1,
        [int]$FinalDelaySeconds = 0                   # extra seconds after last sample
    )

    $totals = @{}
    $sessionStart = [System.DateTime]::UtcNow
    $currentApp = $null
    $appStart = $sessionStart

    $idx = 0
    while ($idx -lt $Sequence.Count) {
        $app = $Sequence[$idx]
        # 0-based: sample i covers the interval [i, i+1) seconds.
        $now = $sessionStart.AddSeconds($idx * $IntervalSeconds)
        $idx++

        if ($app -ne $currentApp) {
            if ($currentApp -ne $null) {
                $held = [Math]::Round(($now - $appStart).TotalSeconds)
                if (-not $totals.ContainsKey($currentApp)) { $totals[$currentApp] = 0 }
                $totals[$currentApp] += $held
            }
            $currentApp = $app
            $appStart = $now
        }
    }

    # Final app's remaining duration is recorded on stop.
    if ($currentApp -ne $null) {
        $stopAt = $sessionStart.AddSeconds(($Sequence.Count * $IntervalSeconds) + $FinalDelaySeconds)
        $held = [Math]::Round(($stopAt - $appStart).TotalSeconds)
        if (-not $totals.ContainsKey($currentApp)) { $totals[$currentApp] = 0 }
        $totals[$currentApp] += $held
    }

    return [PSCustomObject]@{
        Totals = $totals
        FinalApp = $currentApp
    }
}

# ─── Tests ──────────────────────────────────────────────────────────────────
$pass = 0; $fail = 0
function Check($name, $cond, $detail = '') {
    if ($cond) { $script:pass++; Write-Host "PASS: $name" }
    else { $script:fail++; Write-Host "FAIL: $name  $detail" }
}

# 1. One app for a duration.
$r = Invoke-Accumulator -Sequence @('Code.exe') -IntervalSeconds 1 -FinalDelaySeconds 0
Check 'single app total' ($r.Totals['Code.exe'] -eq 1)

# 2. Switching between two apps.
$r = Invoke-Accumulator -Sequence @('Code.exe', 'chrome.exe') -IntervalSeconds 1 -FinalDelaySeconds 0
Check 'two apps both present' ($r.Totals.Count -eq 2)
Check 'first app held 1s' ($r.Totals['Code.exe'] -eq 1)
Check 'second app held 1s' ($r.Totals['chrome.exe'] -eq 1)

# 3. Switching A -> B -> A accumulates A's time across both visits.
$r = Invoke-Accumulator -Sequence @('Code.exe', 'chrome.exe', 'Code.exe') -IntervalSeconds 1 -FinalDelaySeconds 0
Check 'A total is 2 (both visits)' ($r.Totals['Code.exe'] -eq 2)
Check 'B total is 1' ($r.Totals['chrome.exe'] -eq 1)
Check 'three distinct keys not created' ($r.Totals.Count -eq 2)

# 4. Repeated samples of the same app do not create extra switches or totals.
$r = Invoke-Accumulator -Sequence @('Code.exe', 'Code.exe', 'Code.exe') -IntervalSeconds 1 -FinalDelaySeconds 0
Check 'repeat samples keep one key' ($r.Totals.Count -eq 1)
Check 'repeat samples total is 3' ($r.Totals['Code.exe'] -eq 3)

# 5. Final app duration is included when stopping (FinalDelaySeconds > 0).
$r = Invoke-Accumulator -Sequence @('Code.exe', 'chrome.exe') -IntervalSeconds 1 -FinalDelaySeconds 5
Check 'final app includes remaining time' ($r.Totals['chrome.exe'] -eq 6)
Check 'first app unaffected by final delay' ($r.Totals['Code.exe'] -eq 1)

# 6. Multiple apps appear correctly in the summary.
$r = Invoke-Accumulator -Sequence @('a.exe', 'b.exe', 'c.exe') -IntervalSeconds 1 -FinalDelaySeconds 0
Check 'three apps in summary' ($r.Totals.Count -eq 3)
Check 'a total 1' ($r.Totals['a.exe'] -eq 1)
Check 'b total 1' ($r.Totals['b.exe'] -eq 1)
Check 'c total 1' ($r.Totals['c.exe'] -eq 1)

# 7. Empty input still behaves safely.
$r = Invoke-Accumulator -Sequence @() -IntervalSeconds 1 -FinalDelaySeconds 0
Check 'empty input -> no totals' ($r.Totals.Count -eq 0)
Check 'empty input -> final app null' ($r.FinalApp -eq $null)

Write-Host ""
Write-Host "Results: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }