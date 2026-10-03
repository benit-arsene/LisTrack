<#
.SYNOPSIS
    LisTrack Windows Desktop - idle/active state decision (pure function).

.DESCRIPTION
    Maps a "seconds since last user input" reading to a single deterministic
    state: 'Active' or 'Idle'. This helper performs NO I/O and NO waiting: the
    caller supplies the idle age, so the result is a pure function of
    (lastInputAgeSeconds, idleThresholdSeconds) and is fully unit-testable
    without any real waiting or Win32 dependency.

    Decision rule (inclusive lower bound on the idle side):
        Active  when  lastInputAgeSeconds <  idleThresholdSeconds
        Idle    when  lastInputAgeSeconds >= idleThresholdSeconds

    Reads ONLY: a caller-supplied numeric idle age and threshold.
    Does NOT: query the keyboard or mouse, call GetLastInputInfo or any other
    Win32 API, read window contents, open a socket, write to disk, or emit
    telemetry. Obtaining the idle age itself is a separate, later step and is
    NOT implemented here.

    Use as a library (dot-source):
        . .\scripts\idle-state.ps1
        Get-IdleState -LastInputAgeSeconds 10     # -> Active

    Use as a script:
        powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\idle-state.ps1 -LastInputAgeSeconds 10
        powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\idle-state.ps1 -LastInputAgeSeconds 61
        # -> Idle

.PARAMETER LastInputAgeSeconds
    Seconds elapsed since the most recent user input. Negative, NaN and
    infinite values are clamped to 0 (treated as a fresh input -> Active).

.PARAMETER IdleThresholdSeconds
    Idle boundary in seconds (default 60). Must be greater than 0. A value of
    0 or less, plus NaN and infinite values, falls back to the default: note
    that PowerShell binds $null to 0 for a numeric parameter, so a null
    threshold is unusable too and must never silently disable tracking.
#>
[CmdletBinding()]
param(
    [double]$LastInputAgeSeconds = 0,
    [double]$IdleThresholdSeconds = 60
)

Set-StrictMode -Version Latest

# ─── State decision ─────────────────────────────────────────────────────────
function Get-IdleState {
    [CmdletBinding()]
    param(
        # $null binds to 0, so a missing reading degrades to "just had input".
        [double]$LastInputAgeSeconds = 0,
        [double]$IdleThresholdSeconds = 60
    )

    # An unusable threshold must never widen the idle window, so fall back to
    # the documented default instead of trusting the caller. 0 counts as
    # unusable: it would report every sample as Idle and silently disable
    # tracking. ($null also arrives here as 0, see .PARAMETER above.)
    $threshold = $IdleThresholdSeconds
    if ([double]::IsNaN($threshold) -or [double]::IsInfinity($threshold) -or $threshold -le 0) {
        $threshold = 60
    }

    # Age cannot be negative. Clamping to 0 keeps the comparison total and
    # fails safe: an implausible reading is not treated as idleness.
    $age = $LastInputAgeSeconds
    if ([double]::IsNaN($age) -or [double]::IsInfinity($age) -or $age -lt 0) {
        $age = 0
    }

    if ($age -ge $threshold) {
        return 'Idle'
    }
    return 'Active'
}

# Emit a result only when run directly; stay silent when dot-sourced so the
# caller gets the function definitions and nothing else.
if ($MyInvocation.InvocationName -ne '.') {
    Get-IdleState -LastInputAgeSeconds $LastInputAgeSeconds -IdleThresholdSeconds $IdleThresholdSeconds
}
