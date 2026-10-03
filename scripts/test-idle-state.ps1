# Unit tests for the idle/active state decision in idle-state.ps1.
# Exercises the state machine WITHOUT any Win32 call and WITHOUT real waiting:
# the idle age is supplied as a literal and the clock is never read.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File .\test-idle-state.ps1

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$helper = Join-Path $PSScriptRoot 'idle-state.ps1'

# Dot-source the real helper (not a copy) so the tests cover shipped code.
. $helper

# ─── Harness ────────────────────────────────────────────────────────────────
$pass = 0; $fail = 0
function Check($name, $cond, $detail = '') {
    if ($cond) { $script:pass++; Write-Host "PASS: $name" }
    else { $script:fail++; Write-Host "FAIL: $name  $detail" }
}

# Feed a scripted sequence of idle ages and collect the resulting states.
function Invoke-IdleSequence {
    param(
        [double[]]$Ages,
        [double]$IdleThresholdSeconds = 60
    )
    $states = @()
    foreach ($a in $Ages) {
        $states += Get-IdleState -LastInputAgeSeconds $a -IdleThresholdSeconds $IdleThresholdSeconds
    }
    return $states
}

function States-Are($states, $expected) {
    if ($states.Count -ne $expected.Count) { return $false }
    for ($i = 0; $i -lt $expected.Count; $i++) {
        if ($states[$i] -ne $expected[$i]) { return $false }
    }
    return $true
}

Write-Host "== Required examples (threshold 60) =="
Check 'age 10 -> Active'  ((Get-IdleState -LastInputAgeSeconds 10) -eq 'Active')
Check 'age 59 -> Active'  ((Get-IdleState -LastInputAgeSeconds 59) -eq 'Active')
Check 'age 60 -> Idle'    ((Get-IdleState -LastInputAgeSeconds 60) -eq 'Idle')
Check 'age 61 -> Idle'    ((Get-IdleState -LastInputAgeSeconds 61) -eq 'Idle')

Write-Host ""
Write-Host "== Default threshold is 60 =="
Check 'default: age 59 -> Active' ((Get-IdleState -LastInputAgeSeconds 59) -eq 'Active')
Check 'default: age 60 -> Idle'   ((Get-IdleState -LastInputAgeSeconds 60) -eq 'Idle')
Check 'default: age 61 -> Idle'   ((Get-IdleState -LastInputAgeSeconds 61) -eq 'Idle')

Write-Host ""
Write-Host "== Boundary: below / at / above the threshold =="
Check 'just below (59.999) -> Active' ((Get-IdleState -LastInputAgeSeconds 59.999) -eq 'Active')
Check 'exactly at (60) -> Idle'       ((Get-IdleState -LastInputAgeSeconds 60)     -eq 'Idle')
Check 'just above (60.001) -> Idle'   ((Get-IdleState -LastInputAgeSeconds 60.001) -eq 'Idle')
Check 'boundary: fractional age respected' ((Get-IdleState -LastInputAgeSeconds 59.9999999 -IdleThresholdSeconds 60) -eq 'Active')

Write-Host ""
Write-Host "== Threshold = 1 =="
Check 'threshold 1: age 0 -> Active'   ((Get-IdleState -LastInputAgeSeconds 0 -IdleThresholdSeconds 1) -eq 'Active')
Check 'threshold 1: age 0.9 -> Active' ((Get-IdleState -LastInputAgeSeconds 0.9 -IdleThresholdSeconds 1) -eq 'Active')
Check 'threshold 1: age 1 -> Idle'     ((Get-IdleState -LastInputAgeSeconds 1 -IdleThresholdSeconds 1) -eq 'Idle')
Check 'threshold 1: age 5 -> Idle'     ((Get-IdleState -LastInputAgeSeconds 5 -IdleThresholdSeconds 1) -eq 'Idle')

Write-Host ""
Write-Host "== State transitions =="
$s = Invoke-IdleSequence -Ages @(5, 10)
Check 'Active -> Active' (States-Are $s @('Active', 'Active')) "got $($s -join ',')"

$s = Invoke-IdleSequence -Ages @(5, 90)
Check 'Active -> Idle' (States-Are $s @('Active', 'Idle')) "got $($s -join ',')"

$s = Invoke-IdleSequence -Ages @(90, 200)
Check 'Idle -> Idle' (States-Are $s @('Idle', 'Idle')) "got $($s -join ',')"

$s = Invoke-IdleSequence -Ages @(90, 5)
Check 'Idle -> Active' (States-Are $s @('Idle', 'Active')) "got $($s -join ',')"

$s = Invoke-IdleSequence -Ages @(5, 59, 60, 61, 10, 0) -IdleThresholdSeconds 60
Check 'long mixed sequence' (States-Are $s @('Active', 'Active', 'Idle', 'Idle', 'Active', 'Active')) "got $($s -join ',')"

Write-Host ""
Write-Host "== Invalid / negative age is handled safely =="
Check 'age -1 -> Active'          ((Get-IdleState -LastInputAgeSeconds -1) -eq 'Active')
Check 'age -10000 -> Active'      ((Get-IdleState -LastInputAgeSeconds -10000) -eq 'Active')
Check 'age NaN -> Active'         ((Get-IdleState -LastInputAgeSeconds ([double]::NaN)) -eq 'Active')
Check 'age +Infinity -> Active'   ((Get-IdleState -LastInputAgeSeconds ([double]::PositiveInfinity)) -eq 'Active')
Check 'age -Infinity -> Active'   ((Get-IdleState -LastInputAgeSeconds ([double]::NegativeInfinity)) -eq 'Active')
Check 'negative age with threshold 1 -> Active' ((Get-IdleState -LastInputAgeSeconds -5 -IdleThresholdSeconds 1) -eq 'Active')
Check 'negative age never reported Idle' ((Get-IdleState -LastInputAgeSeconds -5 -IdleThresholdSeconds 1) -eq 'Active')

Write-Host ""
Write-Host "== Invalid threshold falls back to the 60s default =="
Check 'threshold -1, age 30 -> Active' ((Get-IdleState -LastInputAgeSeconds 30 -IdleThresholdSeconds -1) -eq 'Active')
Check 'threshold -1, age 60 -> Idle'   ((Get-IdleState -LastInputAgeSeconds 60 -IdleThresholdSeconds -1) -eq 'Idle')
Check 'threshold NaN, age 30 -> Active' ((Get-IdleState -LastInputAgeSeconds 30 -IdleThresholdSeconds ([double]::NaN)) -eq 'Active')
Check 'threshold +Inf, age 30 -> Active' ((Get-IdleState -LastInputAgeSeconds 30 -IdleThresholdSeconds ([double]::PositiveInfinity)) -eq 'Active')
Check 'threshold 0 -> falls back to default' ((Get-IdleState -LastInputAgeSeconds 10 -IdleThresholdSeconds 0) -eq 'Active')
Check 'threshold 0 never disables tracking' ((Get-IdleState -LastInputAgeSeconds 61 -IdleThresholdSeconds 0) -eq 'Idle')

Write-Host ""
Write-Host "== Empty / minimal input is handled safely =="
Check 'no arguments at all -> Active' ((Get-IdleState) -eq 'Active')
Check 'null age -> Active'            ((Get-IdleState -LastInputAgeSeconds $null) -eq 'Active')
Check 'null threshold, age 10 -> Active' ((Get-IdleState -LastInputAgeSeconds 10 -IdleThresholdSeconds $null) -eq 'Active')
Check 'null threshold, age 61 -> Idle'   ((Get-IdleState -LastInputAgeSeconds 61 -IdleThresholdSeconds $null) -eq 'Idle')
Check 'all null -> Active'            ((Get-IdleState -LastInputAgeSeconds $null -IdleThresholdSeconds $null) -eq 'Active')
Check 'exactly one value returned'    (@(Get-IdleState -LastInputAgeSeconds 61).Count -eq 1)
Check 'return value is a known state' (@('Active', 'Idle') -contains (Get-IdleState -LastInputAgeSeconds 61))

Write-Host ""
Write-Host "== Determinism / purity =="
$repeat = @(1, 2, 3, 4, 5 | ForEach-Object { Get-IdleState -LastInputAgeSeconds 61 })
Check 'repeated calls are stable' (States-Are $repeat @('Idle', 'Idle', 'Idle', 'Idle', 'Idle'))
Check 'no shared state between calls' ((Get-IdleState -LastInputAgeSeconds 10) -eq 'Active' -and
                                       (Get-IdleState -LastInputAgeSeconds 10) -eq 'Active')
$monotonic = Invoke-IdleSequence -Ages @(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10) -IdleThresholdSeconds 5
Check 'aging only moves Active -> Idle' (States-Are $monotonic @('Active', 'Active', 'Active', 'Active', 'Active', 'Idle', 'Idle', 'Idle', 'Idle', 'Idle', 'Idle'))

Write-Host ""
Write-Host "== Script entry point =="
$out = & powershell -NoProfile -ExecutionPolicy Bypass -File $helper -LastInputAgeSeconds 10
Check 'run as script, age 10 -> Active' ($out.Trim() -eq 'Active') "got '$out'"
$out = & powershell -NoProfile -ExecutionPolicy Bypass -File $helper -LastInputAgeSeconds 61
Check 'run as script, age 61 -> Idle' ($out.Trim() -eq 'Idle') "got '$out'"
$out = & powershell -NoProfile -ExecutionPolicy Bypass -File $helper
Check 'run as script, no arguments -> Active' ($out.Trim() -eq 'Active') "got '$out'"
$stray = . $helper
Check 'dot-sourcing emits no output' (@($stray).Count -eq 0)

Write-Host ""
Write-Host "Results: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
