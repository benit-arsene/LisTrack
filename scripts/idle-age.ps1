<#
.SYNOPSIS
    LisTrack Windows Desktop - idle age reader (seconds since last input).

.DESNOPSIS
    Windows-only helper that reports how many seconds have passed since the
    user last interacted with the machine, using the Win32 GetLastInputInfo
    API plus the GetTickCount tick counter.

    Collects ONLY: the elapsed time since the last input, as one number.
    Does NOT collect and CANNOT expose: which key was pressed, which mouse
    button was pressed, mouse coordinates, keyboard text, window titles,
    screenshots, clipboard contents, browser URLs, process contents, or
    microphone/camera data. The Win32 API used here reports a timestamp only -
    the input event and its content are never read, logged, or returned. There
    is no keyboard hook, no mouse hook, and no event interception anywhere in
    this file.

    Also does NOT: write to disk, open a socket, emit telemetry, or persist
    anything between runs.

    No real waiting is involved: this is a single instantaneous query.

    Use as a library (dot-source):
        . .\scripts\idle-age.ps1
        $age = Get-IdleAgeSeconds
        if ($age -ge 60) { 'user looks idle' }

    Use as a script (prints the current idle age in seconds):
        powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\idle-age.ps1

.NOTES
    Windows PowerShell 5.1 compatible. Uses no PowerShell 7-only features.

    Not wired into foreground-watch.ps1 yet; the idle-state decision lives
    separately in .\idle-state.ps1.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest

# Milliseconds per tick for both GetTickCount and GetLastInputInfo.dwTime.
$script:MillisecondsPerSecond = 1000

# GetTickCount is a 32-bit millisecond counter that wraps roughly every 49.7
# days. Modular subtraction stays correct for any real gap below this bound;
# beyond it a long idle can no longer be told apart from the wrap, so the
# reading is reported as untrustworthy rather than returned as a number.
$script:MaximumPlausibleIdleMilliseconds = 2147483647   # [int]::MaxValue, ~24.9 days

# ─── Win32 interop ──────────────────────────────────────────────────────────
function Initialize-IdleWin32 {
    <#
    .SYNOPSIS
        Compiles the user32.dll/kernel32.dll interop types once per session.
    #>
    if ('IdleInputWin32' -as [System.Type]) { return }

    try {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class IdleInputWin32
{
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    // Reports the tick time of the last input only - never the input itself.
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    // 32-bit millisecond counter, same clock base as LASTINPUTINFO.dwTime.
    [DllImport("kernel32.dll")]
    public static extern uint GetTickCount();
}
'@ -ErrorAction Stop
    } catch {
        throw ("Idle age error: could not load the Win32 interop types for " +
               "user32.dll/kernel32.dll: " + $_.Exception.Message)
    }
}

# ─── Pure helpers (no Win32 calls, fully deterministic) ─────────────────────
function Assert-TickCount {
    <#
    .SYNOPSIS
        Validates that a value is a 32-bit tick count, or throws.

    .PARAMETER Value
        Candidate tick value.

    .PARAMETER ParameterName
        Name used in the error message.
    #>
    [CmdletBinding()]
    param(
        $Value,
        [string]$ParameterName
    )

    if ($null -eq $Value) {
        throw "Idle age error: '$ParameterName' is null, so the time since the last input cannot be calculated."
    }

    $parsed = 0L
    if (-not [System.Int64]::TryParse([string]$Value, [ref]$parsed)) {
        throw "Idle age error: '$ParameterName' is not a number: '$Value'."
    }
    if ($parsed -lt 0 -or $parsed -gt 4294967295L) {
        throw "Idle age error: '$ParameterName' is outside the 32-bit tick range 0..4294967295: '$Value'."
    }
    return [uint32]$parsed
}

function Get-TickDeltaMilliseconds {
    <#
    .SYNOPSIS
        Milliseconds elapsed between two readings of the 32-bit tick counter.

    .DESCRIPTION
        Pure arithmetic. GetTickCount wraps every ~49.7 days, so the delta is
        computed modulo 2^32 by adding one full period before subtracting and
        then masking - this is correct on both sides of a wrap. (Plain uint64
        subtraction is NOT usable here: PowerShell promotes an underflowing
        uint64 subtraction to a negative Double instead of wrapping.)

    .PARAMETER CurrentTickCount
        Current reading of GetTickCount.

    .PARAMETER LastInputTickCount
        LASTINPUTINFO.dwTime from GetLastInputInfo.

    .PARAMETER MaximumPlausibleMilliseconds
        Reject gaps longer than this as untrustworthy (default 2147483647,
        ~24.9 days) rather than returning a misleading duration.
    #>
    [CmdletBinding()]
    param(
        $CurrentTickCount,
        $LastInputTickCount,
        [long]$MaximumPlausibleMilliseconds = 2147483647
    )

    $current = Assert-TickCount -Value $CurrentTickCount -ParameterName 'CurrentTickCount'
    $last    = Assert-TickCount -Value $LastInputTickCount -ParameterName 'LastInputTickCount'

    # 2^32 period added first so the subtraction cannot underflow.
    $delta = ([uint64]$current + [uint64]4294967296 - [uint64]$last) -band [uint64]4294967295L

    if ($delta -gt [uint64]$MaximumPlausibleMilliseconds) {
        throw ("Idle age error: computed gap of $delta ms is not credible (limit " +
               "$MaximumPlausibleMilliseconds ms), so the tick readings are treated as " +
               "unreliable instead of reporting a misleading idle duration.")
    }
    return $delta
}

function ConvertTo-IdleAgeSeconds {
    <#
    .SYNOPSIS
        Converts a non-negative millisecond duration into seconds.

    .PARAMETER DeltaMilliseconds
        Elapsed milliseconds; must be a non-negative integer.

    .PARAMETER MillisecondsPerSecond
        Tick resolution (default 1000 for GetTickCount).
    #>
    [CmdletBinding()]
    param(
        $DeltaMilliseconds,
        [long]$MillisecondsPerSecond = 1000
    )

    if ($null -eq $DeltaMilliseconds) {
        throw "Idle age error: 'DeltaMilliseconds' is null, so seconds cannot be computed."
    }

    $parsed = 0L
    if (-not [System.Int64]::TryParse([string]$DeltaMilliseconds, [ref]$parsed)) {
        throw "Idle age error: 'DeltaMilliseconds' is not a number: '$DeltaMilliseconds'."
    }
    if ($parsed -lt 0) {
        throw "Idle age error: 'DeltaMilliseconds' must not be negative: $parsed."
    }
    if ($MillisecondsPerSecond -le 0) {
        throw "Idle age error: 'MillisecondsPerSecond' must be greater than 0: $MillisecondsPerSecond."
    }

    return [double]$parsed / [double]$MillisecondsPerSecond
}

# ─── Win32 entry point ──────────────────────────────────────────────────────
function Get-IdleAgeSeconds {
    <#
    .SYNOPSIS
        Returns the number of seconds since the user last provided input.

    .DESCRIPTION
        Queries GetLastInputInfo once and subtracts its tick timestamp from the
        current GetTickCount value. Returns a [double] number of seconds.

        Nothing about the input itself is read or exposed - only the elapsed
        time since it happened.

        On failure this THROWS rather than returning a number, so a caller can
        never mistake an unreadable value for "the user just moved the mouse".
        Failures are: interop types unavailable, GetLastInputInfo returning
        false, a malformed reading, or a gap beyond the plausible maximum.

    .PARAMETER InputReader
        Test seam only. A scriptblock returning
        @{ Succeeded = $true; LastInputTickCount = <tick>; CurrentTickCount = <tick> }
        instead of querying the real API. Leave unset for normal use.

    .EXAMPLE
        $age = Get-IdleAgeSeconds
    #>
    [CmdletBinding()]
    param(
        [scriptblock]$InputReader
    )

    if ($null -eq $InputReader) {
        Initialize-IdleWin32

        $info = New-Object IdleInputWin32+LASTINPUTINFO
        $info.cbSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf([type][IdleInputWin32+LASTINPUTINFO])

        if (-not [IdleInputWin32]::GetLastInputInfo([ref]$info)) {
            $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw ("Idle age error: GetLastInputInfo failed (Win32 error $code). " +
                   "No idle age is reported.")
        }
        # Both readings come from the same 32-bit tick counter, which is what
        # makes the modular subtraction in Get-TickDeltaMilliseconds correct.
        $raw = @{
            Succeeded          = $true
            LastInputTickCount = $info.dwTime
            CurrentTickCount   = [IdleInputWin32]::GetTickCount()
        }
    } else {
        $raw = & $InputReader
    }

    if (-not ($raw -is [System.Collections.IDictionary])) {
        throw "Idle age error: the input reader did not return a tick result."
    }
    if (-not $raw.Contains('Succeeded')) {
        throw "Idle age error: the input reader result has no 'Succeeded' flag."
    }
    if ($raw['Succeeded'] -ne $true) {
        $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw ("Idle age error: GetLastInputInfo failed (Win32 error $code). " +
               "No idle age is reported.")
    }
    if (-not $raw.Contains('LastInputTickCount')) {
        throw "Idle age error: the input reader result has no 'LastInputTickCount'."
    }
    if (-not $raw.Contains('CurrentTickCount')) {
        throw "Idle age error: the input reader result has no 'CurrentTickCount'."
    }

    $deltaMs = Get-TickDeltaMilliseconds `
        -CurrentTickCount $raw['CurrentTickCount'] `
        -LastInputTickCount $raw['LastInputTickCount']

    return ConvertTo-IdleAgeSeconds -DeltaMilliseconds $deltaMs
}

# Print the idle age only when run directly; stay silent when dot-sourced so a
# caller receives just the function definitions.
if ($MyInvocation.InvocationName -ne '.') {
    Write-Output (Get-IdleAgeSeconds)
}
