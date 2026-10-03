# Unit tests for the idle-age reader in idle-age.ps1.
#
# Split into two parts:
#   1. Pure conversion/calculation tests - fully deterministic, no Win32 query,
#      no clock read, no waiting. A test seam (-InputReader) supplies scripted
#      tick readings so the wraparound and failure paths are reproducible.
#   2. One live smoke test - a single real GetLastInputInfo call, no waiting and
#      no synthetic input.
#
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File .\test-idle-age.ps1

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$helper = Join-Path $PSScriptRoot 'idle-age.ps1'

# Dot-source the real helper (not a copy) so the tests cover shipped code.
. $helper

# ─── Harness ────────────────────────────────────────────────────────────────
$pass = 0; $fail = 0
function Check($name, $cond, $detail = '') {
    if ($cond) { $script:pass++; Write-Host "PASS: $name" }
    else { $script:fail++; Write-Host "FAIL: $name  $detail" }
}

# Runs $block and reports whether it threw. Used for the documented failure paths.
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

# Full-pipeline check through Get-IdleAgeSeconds with scripted tick readings.
function Invoke-ScriptedIdleAge {
    param($CurrentTickCount, $LastInputTickCount)
    Get-IdleAgeSeconds -InputReader {
        @{ Succeeded = $true; LastInputTickCount = $LastInputTickCount; CurrentTickCount = $CurrentTickCount }
    }
}

# ─── 1a. Tick delta: normal values ──────────────────────────────────────────
Write-Host "== Tick delta: normal values =="
Check 'zero elapsed -> 0 ms'         ((Get-TickDeltaMilliseconds -CurrentTickCount 1000 -LastInputTickCount 1000) -eq 0)
Check '1 second elapsed'             ((Get-TickDeltaMilliseconds -CurrentTickCount 61000 -LastInputTickCount 60000) -eq 1000)
Check '60 seconds elapsed'           ((Get-TickDeltaMilliseconds -CurrentTickCount 120000 -LastInputTickCount 60000) -eq 60000)
Check-Throws 'tick delta: implausible forward gap rejected' `
                                     { Get-TickDeltaMilliseconds -CurrentTickCount 100 -LastInputTickCount 5000 } 'not credible'
Check 'delta type is unsigned'       ((Get-TickDeltaMilliseconds -CurrentTickCount 2000 -LastInputTickCount 1000).GetType().Name -eq 'UInt64')

# ─── 1b. Tick delta: counter wraparound ─────────────────────────────────────
# The 32-bit tick counter wraps every ~49.7 days (4294967296 ms).
Write-Host ""
Write-Host "== Tick delta: 32-bit wraparound =="
# Just before the wrap, then just after: delta must be the small real gap.
Check 'wrap: 5 ms after wrap'         ((Get-TickDeltaMilliseconds -CurrentTickCount 5 -LastInputTickCount 4294967290) -eq 11)
Check 'wrap: 1 ms after wrap'         ((Get-TickDeltaMilliseconds -CurrentTickCount 1 -LastInputTickCount 4294967295) -eq 2)
Check 'wrap: exactly at wrap'         ((Get-TickDeltaMilliseconds -CurrentTickCount 0 -LastInputTickCount 4294967295) -eq 1)
Check 'wrap: no wrap, ordinary delta' ((Get-TickDeltaMilliseconds -CurrentTickCount 3000 -LastInputTickCount 1000) -eq 2000)
Check 'wrap: high counter, no wrap needed' ((Get-TickDeltaMilliseconds -CurrentTickCount 4294967295 -LastInputTickCount 4294907295) -eq 60000)
Check 'wrap: delta stays in range'    ((Get-TickDeltaMilliseconds -CurrentTickCount 5 -LastInputTickCount 4294967290) -le 4294967295)
Check-Throws 'wrap: ~49.7 day gap is ambiguous and rejected' `
                                     { Get-TickDeltaMilliseconds -CurrentTickCount 4294967295 -LastInputTickCount 4000 } 'not credible'

# ─── 1c. Milliseconds to seconds ────────────────────────────────────────────
Write-Host ""
Write-Host "== Conversion to seconds =="
Check '0 ms -> 0 seconds'      ((ConvertTo-IdleAgeSeconds -DeltaMilliseconds 0) -eq 0.0)
Check '1 ms -> 0.001 seconds'  ((ConvertTo-IdleAgeSeconds -DeltaMilliseconds 1) -eq 0.001)
Check '1000 ms -> 1 second'    ((ConvertTo-IdleAgeSeconds -DeltaMilliseconds 1000) -eq 1.0)
Check '5704 ms -> 5.704 s'     ((ConvertTo-IdleAgeSeconds -DeltaMilliseconds 5704) -eq 5.704)
Check '60000 ms -> 60 seconds' ((ConvertTo-IdleAgeSeconds -DeltaMilliseconds 60000) -eq 60.0)
Check '3600000 ms -> 1 hour'   ((ConvertTo-IdleAgeSeconds -DeltaMilliseconds 3600000) -eq 3600.0)
Check 'seconds type is double' ((ConvertTo-IdleAgeSeconds -DeltaMilliseconds 1500).GetType().Name -eq 'Double')

# ─── 1d. Invalid input handling ─────────────────────────────────────────────
Write-Host ""
Write-Host "== Invalid input handling =="
Check-Throws 'age: negative delta rejected'    { ConvertTo-IdleAgeSeconds -DeltaMilliseconds -1 } 'must not be negative'
Check-Throws 'age: null delta rejected'        { ConvertTo-IdleAgeSeconds -DeltaMilliseconds $null } 'null'
Check-Throws 'age: non-numeric delta rejected' { ConvertTo-IdleAgeSeconds -DeltaMilliseconds 'abc' } 'not a number'
Check-Throws 'age: zero tick rate rejected'    { ConvertTo-IdleAgeSeconds -DeltaMilliseconds 1000 -MillisecondsPerSecond 0 } 'greater than 0'
Check-Throws 'tick: null current rejected'     { Get-TickDeltaMilliseconds -CurrentTickCount $null -LastInputTickCount 0 } 'null'
Check-Throws 'tick: negative current rejected' { Get-TickDeltaMilliseconds -CurrentTickCount -1 -LastInputTickCount 0 } '32-bit tick range'
Check-Throws 'tick: non-numeric rejected'      { Get-TickDeltaMilliseconds -CurrentTickCount 'abc' -LastInputTickCount 0 } 'not a number'
Check-Throws 'tick: out of range rejected'     { Get-TickDeltaMilliseconds -CurrentTickCount 4294967296 -LastInputTickCount 0 } '32-bit tick range'
Check-Throws 'tick: implausible gap rejected'  { Get-TickDeltaMilliseconds -CurrentTickCount 0 -LastInputTickCount 2000000000 } 'not credible'
Check-Throws 'age: implausible gap rejected'   { Invoke-ScriptedIdleAge -CurrentTickCount 0 -LastInputTickCount 2000000000 } 'not credible'

# ─── 1e. API failure handling (scripted, no real API call) ──────────────────
Write-Host ""
Write-Host "== API failure handling =="
Check-Throws 'API failure throws (never returns 0)' {
    Get-IdleAgeSeconds -InputReader { @{ Succeeded = $false } }
} 'GetLastInputInfo failed'
Check-Throws 'API failure does not return a misleading 0' {
    $v = Get-IdleAgeSeconds -InputReader { @{ Succeeded = $false } }
    if ($v -eq 0) { throw 'returned a misleading zero idle age' }
} 'GetLastInputInfo failed'
Check-Throws 'reader returning nothing is rejected' {
    Get-IdleAgeSeconds -InputReader { $null }
} 'did not return a tick result'
Check-Throws 'reader missing Succeeded is rejected' {
    Get-IdleAgeSeconds -InputReader { @{ LastInputTickCount = 1000; CurrentTickCount = 2000 } }
} "no 'Succeeded'"
Check-Throws 'reader missing LastInputTickCount is rejected' {
    Get-IdleAgeSeconds -InputReader { @{ Succeeded = $true; CurrentTickCount = 2000 } }
} "no 'LastInputTickCount'"
Check-Throws 'reader missing CurrentTickCount is rejected' {
    Get-IdleAgeSeconds -InputReader { @{ Succeeded = $true; LastInputTickCount = 1000 } }
} "no 'CurrentTickCount'"
Check-Throws 'reader returning a non-dictionary is rejected' {
    Get-IdleAgeSeconds -InputReader { 'nonsense' }
} 'did not return a tick result'

# ─── 1f. End-to-end with scripted readings ──────────────────────────────────
Write-Host ""
Write-Host "== End-to-end with scripted tick readings =="
Check 'scripted: 0 ms idle'         ((Invoke-ScriptedIdleAge -CurrentTickCount 5000 -LastInputTickCount 5000) -eq 0.0)
Check 'scripted: 5.704 s idle'      ((Invoke-ScriptedIdleAge -CurrentTickCount 6612500 -LastInputTickCount 6606796) -eq 5.704)
Check 'scripted: 60 s idle'         ((Invoke-ScriptedIdleAge -CurrentTickCount 120000 -LastInputTickCount 60000) -eq 60.0)
Check 'scripted: 61 s idle'         ((Invoke-ScriptedIdleAge -CurrentTickCount 121000 -LastInputTickCount 60000) -eq 61.0)
Check 'scripted: 59 s idle'         ((Invoke-ScriptedIdleAge -CurrentTickCount 119000 -LastInputTickCount 60000) -eq 59.0)
Check 'scripted: just below 60 s'   ((Invoke-ScriptedIdleAge -CurrentTickCount 60000 -LastInputTickCount 1) -eq 59.999)
Check 'scripted: wraparound gap'    ((Invoke-ScriptedIdleAge -CurrentTickCount 5 -LastInputTickCount 4294967290) -eq 0.011)
Check 'scripted: return is a number' ((Invoke-ScriptedIdleAge -CurrentTickCount 2000 -LastInputTickCount 1000) -is [double])
Check 'scripted: exactly one value'  (@(Invoke-ScriptedIdleAge -CurrentTickCount 2000 -LastInputTickCount 1000).Count -eq 1)

# ─── 2. Live smoke test (one real API call) ─────────────────────────────────
Write-Host ""
Write-Host "== Live smoke test: single real GetLastInputInfo call =="
$liveOk = $true
$liveError = ''
try {
    $age = Get-IdleAgeSeconds
} catch {
    $liveOk = $false
    $liveError = $_.Exception.Message
}
Check 'live: query succeeded without error' $liveOk $liveError
if ($liveOk) {
    Check 'live: returns a number'      ($age -is [double] -or $age -is [int] -or $age -is [long]) "got type $(if ($null -eq $age) { 'null' } else { $age.GetType().Name })"
    Check 'live: is not null'            ($null -ne $age)
    Check 'live: is non-negative'        ($age -ge 0) "got $age"
    Check 'live: is a finite number'     (-not [double]::IsNaN([double]$age) -and -not [double]::IsInfinity([double]$age)) "got $age"
    Check 'live: within credible range'  ($age -le 2147483.647) "got $age"
    Write-Host "      live idle age: $age seconds"
}

# ─── 3. Library hygiene ─────────────────────────────────────────────────────
Write-Host ""
Write-Host "== Library hygiene =="
$stray = . $helper
Check 'dot-sourcing emits no output' (@($stray).Count -eq 0)

Write-Host ""
Write-Host "Results: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
