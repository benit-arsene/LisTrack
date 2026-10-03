# Unit tests for the idle-aware accumulator in foreground-watch.ps1.
#
# These drive the REAL New-ActivityAccumulator / Step-ActivityAccumulator /
# Invoke-ActivityLoop / Stop-ActivityAccumulator functions, dot-sourced from
# foreground-watch.ps1. Nothing waits and nothing touches Win32: the foreground
# app, the idle age and the UTC clock are all scripted, so a 60-second idle
# threshold is crossed in microseconds.
#
# Idle ages are modelled physically: the user's last input happens at a given
# sample index, and the reported idle age is the time elapsed since then. Ages
# therefore climb one second per sample instead of jumping, which is what a
# real GetLastInputInfo reading does.
#
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File .\test-foreground-idle.ps1

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$watcher = Join-Path $PSScriptRoot 'foreground-watch.ps1'

# Dot-source the real watcher. Its main body is guarded, so this only loads
# functions and starts no polling loop.
. $watcher

# ─── Harness ────────────────────────────────────────────────────────────────
$pass = 0; $fail = 0
function Check($name, $cond, $detail = '') {
    if ($cond) { $script:pass++; Write-Host "PASS: $name" }
    else { $script:fail++; Write-Host "FAIL: $name  $detail" }
}

function Check-Throws($name, [scriptblock]$block, $pattern = '') {
    try {
        $null = & $block
        Check $name $false 'expected a terminating error, but none was thrown'
    } catch {
        if ($pattern -and ($_.Exception.Message -notmatch $pattern)) {
            Check $name $false "wrong message: $($_.Exception.Message)"
        } else {
            Check $name $true
        }
    }
}

$epoch = [datetime]::Parse('2026-01-01T10:00:00Z').ToUniversalTime()

# Builds a sample list.
#   Plan   - ordered segments, e.g. @(@{ App = 'Code.exe'; Seconds = 81 })
#   Inputs - sample indices at which the user last provided input. An index
#            below 0 means the last input happened before the session started
#            (so the session begins already idle). An empty list means the user
#            keeps inputting and the age stays 0 throughout.
function New-Session {
    param(
        [hashtable[]]$Plan,
        [int[]]$Inputs = @(),
        [int]$IntervalSeconds = 1
    )

    $apps = @()
    $ages = @()
    $i = 0
    foreach ($seg in $Plan) {
        for ($k = 0; $k -lt $seg.Seconds; $k++) {
            $apps += $seg.App
            $lastInput = $null
            foreach ($t in $Inputs) { if ($t -le $i) { $lastInput = $t } }
            if ($null -eq $lastInput) { $ages += 0 } else { $ages += ($i - $lastInput) * $IntervalSeconds }
            $i++
        }
    }
    return [PSCustomObject]@{ Apps = $apps; Ages = $ages }
}

# Runs a scripted session through the real loop.
function Run-Session {
    param(
        $Session,
        [int]$IdleThresholdSeconds = 60,
        [int]$IntervalSeconds = 1,
        [int]$FinalDelaySeconds = 0
    )

    $cursor = @{ i = 0 }
    $events = New-Object System.Collections.Generic.List[string]

    $acc = Invoke-ActivityLoop `
        -AppProvider { $Session.Apps[$cursor.i] } `
        -IdleProbe {
            $age = $Session.Ages[$cursor.i]
            @{ AgeSeconds = $age
               State      = Get-IdleState -LastInputAgeSeconds $age `
                                        -IdleThresholdSeconds $IdleThresholdSeconds }
        } `
        -Clock {
            $t = $epoch.AddSeconds($cursor.i * $IntervalSeconds)
            $cursor.i++
            $t
        } `
        -EventSink { param($line) $events.Add($line) | Out-Null } `
        -Delay { } `
        -ShouldStop { $cursor.i -ge $Session.Apps.Count } `
        -IntervalSeconds $IntervalSeconds

    $stopAt = $epoch.AddSeconds(($Session.Apps.Count * $IntervalSeconds) + $FinalDelaySeconds)
    $acc = Stop-ActivityAccumulator -Accumulator $acc -Timestamp $stopAt

    return [PSCustomObject]@{
        Totals        = $acc.Totals
        Events        = $events
        IdleSeconds   = $acc.IdleSeconds
        ActiveSeconds = $acc.ActiveSeconds
        CurrentApp    = $acc.CurrentApp
        LastState     = $acc.LastState
    }
}

function Count-Lines($events, $pattern) {
    return @($events | Where-Object { $_ -match $pattern }).Count
}

# A session where the user never stops inputting, so the age stays 0.
function New-FlatSession {
    param([string[]]$Apps)
    $ages = @()
    foreach ($a in $Apps) { $ages += 0 }
    return [PSCustomObject]@{ Apps = $Apps; Ages = $ages }
}

# The pre-idle algorithm, verbatim, on the same synthetic clock. Used to prove
# the integrated accumulator is unchanged when no idle period occurs.
function Invoke-LegacyAccumulator {
    param([string[]]$Sequence, [int]$IntervalSeconds = 1, [int]$FinalDelaySeconds = 0)

    $totals = @{}
    $sessionStart = $epoch
    $currentApp = $null
    $appStart = $sessionStart

    $idx = 0
    while ($idx -lt $Sequence.Count) {
        $app = $Sequence[$idx]
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
    if ($currentApp -ne $null) {
        $stopAt = $sessionStart.AddSeconds(($Sequence.Count * $IntervalSeconds) + $FinalDelaySeconds)
        $held = [Math]::Round(($stopAt - $appStart).TotalSeconds)
        if (-not $totals.ContainsKey($currentApp)) { $totals[$currentApp] = 0 }
        $totals[$currentApp] += $held
    }
    return $totals
}

# ─── 1. Active app accumulates normally ─────────────────────────────────────
Write-Host "== 1. Active accumulation =="
# Constant input, so the age stays 0 and the state never leaves Active.
$r = Run-Session (New-Session -Plan @(@{ App = 'Code.exe'; Seconds = 20 }))
Check 'active: 20s on one app'     ($r.Totals['Code.exe'] -eq 20) "got $($r.Totals['Code.exe'])"
Check 'active: reports Active'     ($r.Events -match '^\[\d\d:\d\d:\d\d\] Active: Code\.exe$')
Check 'active: no Idle line'       (-not ($r.Events -match ' Idle: '))
Check 'active: idle total is zero' ($r.IdleSeconds -eq 0)
Check 'active: ends Active'        ($r.LastState -eq 'Active')

# ─── 2/3. Active -> Idle pauses and excludes the idle duration ──────────────
Write-Host ""
Write-Host "== 2/3. Active -> Idle excludes idle time =="
# Last input at sample 20; the age reaches the 60s threshold at sample 80.
$r = Run-Session (New-Session -Plan @(@{ App = 'Code.exe'; Seconds = 81 }) -Inputs @(20))
Check 'idle: credited up to last input' ($r.Totals['Code.exe'] -eq 20) "got $($r.Totals['Code.exe'])"
Check 'idle: 61 idle seconds not credited' ($r.Totals['Code.exe'] -lt 25)
Check 'idle: reports Idle transition' ($r.Events -match ' Idle: ')
Check 'idle: idle time tracked apart' ($r.IdleSeconds -eq 61) "got $($r.IdleSeconds)"
Check 'idle: ends Idle'              ($r.LastState -eq 'Idle')
Check 'idle: Active line precedes Idle line' (
    (@($r.Events) | ForEach-Object { $_ }) -match 'Active: Code\.exe$' -and
    $r.Events[0] -match 'Active' -and $r.Events[1] -match 'Idle:')

# Exactly one sample earlier: the age only reaches 59, so it stays Active.
$r = Run-Session (New-Session -Plan @(@{ App = 'Code.exe'; Seconds = 80 }) -Inputs @(20))
Check 'boundary: age 59 stays Active' ($r.LastState -eq 'Active')
Check 'boundary: full 80s accrued'    ($r.Totals['Code.exe'] -eq 80) "got $($r.Totals['Code.exe'])"

# The same 81 samples with a raised threshold never go idle.
$r = Run-Session (New-Session -Plan @(@{ App = 'Code.exe'; Seconds = 81 }) -Inputs @(20)) -IdleThresholdSeconds 120
Check 'boundary: threshold 120 stays Active' ($r.LastState -eq 'Active')
Check 'boundary: threshold 120 accrues all'  ($r.Totals['Code.exe'] -eq 81) "got $($r.Totals['Code.exe'])"

# ─── 4/5. Idle -> Active resumes, same app ──────────────────────────────────
Write-Host ""
Write-Host "== 4/5. Resume accumulation =="
# Inputs at sample 20 and again at 120, so idleness spans samples 80..120.
$r = Run-Session (New-Session -Plan @(@{ App = 'Code.exe'; Seconds = 141 }) -Inputs @(20, 120))
# 20s before the idle (closed at sample 80) + 21s after the resume at sample
# 120. The 100s idle in between is dropped, so 41 + 100 = 141 = session length.
Check 'resume: 20 + 21 = 41s'        ($r.Totals['Code.exe'] -eq 41) "got $($r.Totals['Code.exe'])"
Check 'resume: idle excluded'        ($r.IdleSeconds -eq 100) "got $($r.IdleSeconds)"
Check 'resume: active total matches' ($r.ActiveSeconds -eq 41) "got $($r.ActiveSeconds)"
Check 'resume: active + idle = session' (($r.ActiveSeconds + $r.IdleSeconds) -eq 141)
Check 'resume: three state lines'    (Count-Lines $r.Events 'Active: |Idle: ') -eq 3
Check 'resume: reports Active again' ($r.Events -match ' Active: Code\.exe$')
Check 'resume: ends Active'          ($r.LastState -eq 'Active')

# ─── 6. App switch while idle ───────────────────────────────────────────────
Write-Host ""
Write-Host "== 6. App switch while idle =="
# Idle from sample 80; the switch to chrome happens at 81, while still idle;
# the user returns at 160.
$r = Run-Session (New-Session -Plan @(
        @{ App = 'Code.exe';  Seconds = 81 }
        @{ App = 'chrome.exe'; Seconds = 90 }
    ) -Inputs @(20, 160))
Check 'idle switch: Code keeps only pre-idle time' ($r.Totals['Code.exe'] -eq 20) "got $($r.Totals['Code.exe'])"
Check 'idle switch: Chrome credited from resume'    ($r.Totals['chrome.exe'] -eq 11) "got $($r.Totals['chrome.exe'])"
Check 'idle switch: both apps present'             ($r.Totals.Count -eq 2)
Check 'idle switch: sorted keys'  ((@($r.Totals.Keys) | Sort-Object) -join ',') -eq 'Code.exe,chrome.exe'
Check 'idle switch: reports switch while idle' (
    $r.Events -match 'Idle: chrome\.exe \(foreground changed while idle\)')
Check 'idle switch: Chrome becomes current' ($r.CurrentApp -eq 'chrome.exe')
Check 'idle switch: no Active line for the idle switch' (
    (Count-Lines $r.Events 'Active: chrome\.exe$') -eq 1)

# ─── 7. Repeated idle samples add nothing ───────────────────────────────────
Write-Host ""
Write-Host "== 7. Repeated Idle samples =="
$r = Run-Session (New-Session -Plan @(@{ App = 'Code.exe'; Seconds = 120 }) -Inputs @(20))
Check 'idle repeat: total unchanged' ($r.Totals['Code.exe'] -eq 20) "got $($r.Totals['Code.exe'])"
Check 'idle repeat: one Idle line'   ((Count-Lines $r.Events 'Idle: ') -eq 1)
Check 'idle repeat: idle time grows' ($r.IdleSeconds -eq 100) "got $($r.IdleSeconds)"
Check 'idle repeat: active unchanged across 40 idle samples' (
    (Run-Session (New-Session -Plan @(@{ App = 'Code.exe'; Seconds = 81 }) -Inputs @(20))).Totals['Code.exe'] -eq 20)

# ─── 8/12. App switches while Active behave exactly as before ───────────────
Write-Host ""
Write-Host "== 8/12. Unchanged behaviour without idle periods =="
$r = Run-Session (New-Session -Plan @(
        @{ App = 'Code.exe';  Seconds = 20 }
        @{ App = 'chrome.exe'; Seconds = 20 }
    ))
Check 'switch: Code.exe gets 20s'   ($r.Totals['Code.exe'] -eq 20) "got $($r.Totals['Code.exe'])"
Check 'switch: chrome.exe gets 20s' ($r.Totals['chrome.exe'] -eq 20) "got $($r.Totals['chrome.exe'])"
Check 'switch: two Active lines'    ((Count-Lines $r.Events 'Active: ') -eq 2)

$r = Run-Session (New-Session -Plan @(
        @{ App = 'a.exe'; Seconds = 10 }
        @{ App = 'b.exe'; Seconds = 10 }
        @{ App = 'c.exe'; Seconds = 10 }
    ))
Check 'three apps'   ($r.Totals.Count -eq 3)
Check 'a.exe 10s'     ($r.Totals['a.exe'] -eq 10)
Check 'b.exe 10s'     ($r.Totals['b.exe'] -eq 10)
Check 'c.exe 10s'     ($r.Totals['c.exe'] -eq 10)
Check 'three apps: total 30s' ($r.ActiveSeconds -eq 30) "got $($r.ActiveSeconds)"

# Repeated samples of one app must not create extra switches.
$r = Run-Session (New-Session -Plan @(@{ App = 'Code.exe'; Seconds = 10 }))
Check 'repeats: one key'            ($r.Totals.Count -eq 1)
Check 'repeats: total 10s'          ($r.Totals['Code.exe'] -eq 10)
Check 'repeats: single Active line' ((Count-Lines $r.Events 'Active: ') -eq 1)

# Same app returning later keeps accumulating into one key.
$r = Run-Session (New-Session -Plan @(
        @{ App = 'Code.exe';    Seconds = 5 }
        @{ App = 'chrome.exe';  Seconds = 5 }
        @{ App = 'Code.exe';    Seconds = 5 }
    ))
Check 'round-trip: one key per app' ($r.Totals.Count -eq 2)
Check 'round-trip: Code.exe 10s'    ($r.Totals['Code.exe'] -eq 10) "got $($r.Totals['Code.exe'])"
Check 'round-trip: chrome.exe 5s'   ($r.Totals['chrome.exe'] -eq 5) "got $($r.Totals['chrome.exe'])"

# Byte-for-byte equivalence with the pre-idle algorithm when nothing goes idle.
foreach ($case in @(
        @{ Apps = @('Code.exe', 'chrome.exe', 'Code.exe'); Delay = 0 }
        @{ Apps = @('a.exe', 'b.exe', 'c.exe', 'd.exe');       Delay = 5 }
        @{ Apps = @('Code.exe');                               Delay = 30 }
    )) {
    $new = Run-Session (New-FlatSession -Apps $case.Apps) -FinalDelaySeconds $case.Delay
    $old = Invoke-LegacyAccumulator -Sequence $case.Apps -FinalDelaySeconds $case.Delay
    $same = ($new.Totals.Count -eq $old.Count)
    foreach ($k in $old.Keys) { if ($new.Totals[$k] -ne $old[$k]) { $same = $false } }
    Check "legacy equivalence: $($case.Apps -join '/') delay $($case.Delay)" $same `
          "new=$((($new.Totals.Keys | Sort-Object | ForEach-Object { "$_=$($new.Totals[$_])" }) -join ',')) old=$((($old.Keys | Sort-Object | ForEach-Object { "$_=$($old[$_])" }) -join ','))"
}

# ─── 9. Multiple apps accumulate correctly around idle periods ──────────────
Write-Host ""
Write-Host "== 9. Multiple apps across idle periods =="
# Active 0..90, idle 90..200 (switch at 41 is still active), active again 200+.
$r = Run-Session (New-Session -Plan @(
        @{ App = 'Code.exe';    Seconds = 41 }
        @{ App = 'chrome.exe';  Seconds = 180 }
    ) -Inputs @(90, 200))
Check 'multi: Code.exe active time'   ($r.Totals['Code.exe'] -eq 41) "got $($r.Totals['Code.exe'])"
Check 'multi: chrome active time'     ($r.Totals['chrome.exe'] -eq 70) "got $($r.Totals['chrome.exe'])"
Check 'multi: active total'           ($r.ActiveSeconds -eq 111) "got $($r.ActiveSeconds)"
Check 'multi: idle total'             ($r.IdleSeconds -eq 110) "got $($r.IdleSeconds)"
Check 'multi: active + idle = session' (($r.ActiveSeconds + $r.IdleSeconds) -eq 221)
Check 'multi: both apps present'      ($r.Totals.Count -eq 2)

# ─── 10. Final active period included on stop ───────────────────────────────
Write-Host ""
Write-Host "== 10. Final active period on stop =="
$r = Run-Session (New-Session -Plan @(@{ App = 'Code.exe'; Seconds = 20 })) -FinalDelaySeconds 5
Check 'final: active tail included'   ($r.Totals['Code.exe'] -eq 25) "got $($r.Totals['Code.exe'])"

# Stopping while idle must not credit the open idle period.
$r = Run-Session (New-Session -Plan @(@{ App = 'Code.exe'; Seconds = 81 }) -Inputs @(20)) -FinalDelaySeconds 30
Check 'final: idle stop credits none' ($r.Totals['Code.exe'] -eq 20) "got $($r.Totals['Code.exe'])"
Check 'final: idle stop tracked'      ($r.IdleSeconds -eq 91) "got $($r.IdleSeconds)"

# ─── 11. A session containing only idle time ────────────────────────────────
Write-Host ""
Write-Host "== 11. Idle-only session =="
$r = Run-Session (New-Session -Plan @(@{ App = 'Code.exe'; Seconds = 120 }) -Inputs @(-100))
Check 'idle-only: no usage recorded'  ($r.Totals.Count -eq 0) "got $($r.Totals.Count) keys"
Check 'idle-only: zero active time'   ($r.ActiveSeconds -eq 0)
Check 'idle-only: idle tracked'       ($r.IdleSeconds -eq 220) "got $($r.IdleSeconds)"
Check 'idle-only: reports Idle'       ($r.Events -match ' Idle: ')
Check 'idle-only: never reports Active' ((Count-Lines $r.Events 'Active: ') -eq 0)

# Apps that only ever appeared while idle earn nothing.
$r = Run-Session (New-Session -Plan @(
        @{ App = 'Code.exe';   Seconds = 5 }
        @{ App = 'chrome.exe'; Seconds = 10 }
    ) -Inputs @(-100))
Check 'idle-only: neither app counted' ($r.Totals.Count -eq 0)
Check 'idle-only: switch still reported' (
    $r.Events -match 'Idle: chrome\.exe \(foreground changed while idle\)')

# ─── 12b. The threshold is configurable, with one source of truth ───────────
Write-Host ""
Write-Host "== 12b. Configurable idle threshold =="
$sess = New-Session -Plan @(@{ App = 'Code.exe'; Seconds = 60 }) -Inputs @(20)
$r1  = Run-Session $sess -IdleThresholdSeconds 5
$r60 = Run-Session $sess -IdleThresholdSeconds 60
Check 'threshold 5: goes Idle'         ($r1.LastState -eq 'Idle')
Check 'threshold 5: idle excluded'     ($r1.Totals['Code.exe'] -eq 20) "got $($r1.Totals['Code.exe'])"
Check 'threshold 60: stays Active'     ($r60.LastState -eq 'Active')
Check 'threshold 60: full 60s'         ($r60.Totals['Code.exe'] -eq 60) "got $($r60.Totals['Code.exe'])"

# ─── Determinism and error handling ─────────────────────────────────────────
Write-Host ""
Write-Host "== Determinism and error handling =="
$sess = New-Session -Plan @(@{ App = 'Code.exe'; Seconds = 141 }) -Inputs @(20, 120)
$first  = Run-Session $sess
$second = Run-Session $sess
Check 'determinism: identical totals' ($first.Totals['Code.exe'] -eq $second.Totals['Code.exe'])
Check 'determinism: identical events' ((@($first.Events) -join '|') -eq (@($second.Events) -join '|'))
Check 'determinism: identical idle'   ($first.IdleSeconds -eq $second.IdleSeconds)

Check-Throws 'unknown idle state rejected' {
    $acc = New-ActivityAccumulator
    Step-ActivityAccumulator -Accumulator $acc -App 'a.exe' -Timestamp $epoch -IdleState 'Maybe'
} 'Unknown idle state'

# A negative duration can never subtract from a total.
$acc = New-ActivityAccumulator
Add-ActivityTime -Accumulator $acc -App 'a.exe' -Duration ([TimeSpan]::FromSeconds(-50))
Check 'negative duration clamped'    ($acc.Totals['a.exe'] -eq 0) "got $($acc.Totals['a.exe'])"
Add-ActivityTime -Accumulator $acc -App 'a.exe' -Duration ([TimeSpan]::FromSeconds(12.5))
# MidpointRounding.ToEven, exactly as the pre-idle accumulator rounded.
Check 'duration rounds as before'    ($acc.Totals['a.exe'] -eq 12) "got $($acc.Totals['a.exe'])"
Add-ActivityTime -Accumulator $acc -App 'a.exe' -Duration ([TimeSpan]::FromSeconds(13.5))
Check 'rounding stays ToEven'        ($acc.Totals['a.exe'] -eq 26) "got $($acc.Totals['a.exe'])"

# An unusable idle age must not invent active time.
$r = Run-Session ([PSCustomObject]@{ Apps = @('a.exe', 'a.exe', 'a.exe', 'a.exe')
                                     Ages = @(0, [double]::NaN, [double]::PositiveInfinity, 0) })
Check 'bad idle age ignored'         ($r.LastState -eq 'Active') "got $($r.LastState)"

# ─── Parameter plumbing ─────────────────────────────────────────────────────
Write-Host ""
Write-Host "== Parameter plumbing =="
# Dot-sourcing a helper runs its param block in the caller's scope, which used
# to overwrite the watcher's own -IdleThresholdSeconds with the helper default
# of 60. The watcher therefore captures its parameters first; these assertions
# guard that pattern.
Check 'watcher captures poll interval'    ($pollIntervalSeconds -eq 1) "got '$pollIntervalSeconds'"
Check 'watcher captures max seconds'      ($runMaxSeconds -eq 0) "got '$runMaxSeconds'"
Check 'watcher captures idle threshold'   ($idleThreshold -eq 60) "got '$idleThreshold'"

# The regression that matters: a NON-DEFAULT threshold must survive. Dot-source
# the watcher with real arguments and inspect what it captured. The raw name is
# expected to have been overwritten by a helper param block, which is exactly
# why the watcher captured its own copy first.
$captured = & {
    . $watcher -IntervalSeconds 3 -MaxSeconds 11 -IdleThresholdSeconds 7
    [PSCustomObject]@{
        Threshold = $idleThreshold
        Interval  = $pollIntervalSeconds
        Max       = $runMaxSeconds
        Raw       = $IdleThresholdSeconds
    }
}
Check 'watcher keeps a non-default idle threshold' ($captured.Threshold -eq 7) "got '$($captured.Threshold)'"
Check 'watcher keeps a non-default interval'       ($captured.Interval -eq 3) "got '$($captured.Interval)'"
Check 'watcher keeps non-default max seconds'       ($captured.Max -eq 11) "got '$($captured.Max)'"
Check 'raw threshold was clobbered by a helper'    ($captured.Raw -eq 60) "got '$($captured.Raw)'"

# Demonstrate the hazard the capture exists to defeat.
$clobberProbe = & {
    param($IdleThresholdSeconds)
    . (Join-Path $PSScriptRoot 'idle-state.ps1')
    $IdleThresholdSeconds
} 5
Check 'helper dot-source would clobber a bare name' ($clobberProbe -eq 60) "got '$clobberProbe'"

# The threshold reaches Get-IdleState explicitly, not via a script variable.
Check 'probe: age 5, threshold 3 -> Idle' `
    ((Get-IdleProbe -IdleAgeSeconds 5 -IdleThresholdSeconds 3).State -eq 'Idle')
Check 'probe: age 5, threshold 60 -> Active' `
    ((Get-IdleProbe -IdleAgeSeconds 5 -IdleThresholdSeconds 60).State -eq 'Active')
Check 'probe: age 60, threshold 60 -> Idle' `
    ((Get-IdleProbe -IdleAgeSeconds 60 -IdleThresholdSeconds 60).State -eq 'Idle')
Check 'probe: carries the raw age' `
    ((Get-IdleProbe -IdleAgeSeconds 42.5 -IdleThresholdSeconds 60).AgeSeconds -eq 42.5)
Check 'probe: threshold is honoured, not fixed at 60' `
    ((Get-IdleProbe -IdleAgeSeconds 3 -IdleThresholdSeconds 1).State -eq 'Idle')

Write-Host ""
Write-Host "Results: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
