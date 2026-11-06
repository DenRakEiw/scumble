# CorridorKey spike (I0b): samples every IntervalMs the GPU dedicated memory of one process (Windows' "GPU Process
# Memory" counters, summed over its pid_<pid>_luid_* instances), the card's ("GPU Adapter Memory", per luid) and the
# private bytes of the given processes; one JSON line per sample on stdout. nvidia-smi cannot give per-process VRAM
# under WDDM (docs/PLAN_CORRIDORKEY.md §2.4), these counters can.
param([int]$ChildPid, [int]$MainPid, [int]$IntervalMs = 250)
$ErrorActionPreference = "SilentlyContinue"
$proc = New-Object System.Diagnostics.PerformanceCounterCategory("GPU Process Memory")
$adapter = New-Object System.Diagnostics.PerformanceCounterCategory("GPU Adapter Memory")
$pcs = @{}
function Raw($cat, $name, $inst) {
    $key = "$cat|$name|$inst"
    if (-not $pcs.ContainsKey($key)) { $pcs[$key] = New-Object System.Diagnostics.PerformanceCounter($cat, $name, $inst, $true) }
    try { return [int64]$pcs[$key].RawValue } catch { return [int64]0 }
}
$epoch = [DateTime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
while ($true) {
    $t = [int64](([DateTime]::UtcNow - $epoch).TotalMilliseconds)
    $ded = [int64]0; $shared = [int64]0; $n = 0
    foreach ($i in $proc.GetInstanceNames()) {
        if ($i.StartsWith("pid_$($ChildPid)_")) { $ded += Raw "GPU Process Memory" "Dedicated Usage" $i; $shared += Raw "GPU Process Memory" "Shared Usage" $i; $n++ }
    }
    $card = @{}
    foreach ($i in $adapter.GetInstanceNames()) { $card[$i] = Raw "GPU Adapter Memory" "Dedicated Usage" $i }
    $c = Get-Process -Id $ChildPid; $m = Get-Process -Id $MainPid
    $o = [ordered]@{ t = $t; child_gpu_ded = $ded; child_gpu_shared = $shared; child_gpu_instances = $n;
        child_private = $(if ($c) { $c.PrivateMemorySize64 } else { -1 }); child_ws = $(if ($c) { $c.WorkingSet64 } else { -1 });
        main_private = $(if ($m) { $m.PrivateMemorySize64 } else { -1 }); card_ded = $card }
    [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 3))
    [Console]::Out.Flush()
    Start-Sleep -Milliseconds $IntervalMs
}
