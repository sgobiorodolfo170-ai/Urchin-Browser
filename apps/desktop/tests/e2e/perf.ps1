# W7 Performance: cold start time + memory
$ErrorActionPreference = 'Stop'
$electron = 'G:\pj\pj--ing\111111\Urchin-Browser\node_modules\.pnpm\electron@32.3.3\node_modules\electron\dist\electron.exe'
$appPath = 'g:\pj\pj--ing\111111\Urchin-Browser\apps\desktop'
$totalRuns = 11

function Get-ElectronProcessTree {
    param([int]$RootPid)
    $procs = @()
    $root = Get-Process -Id $RootPid -ErrorAction SilentlyContinue
    if ($root) { $procs += $root }
    $children = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ParentProcessId -eq $RootPid }
    foreach ($child in $children) {
        $cp = Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
        if ($cp) { $procs += $cp }
        $gcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ParentProcessId -eq $child.ProcessId }
        foreach ($gc in $gcs) {
            $gp = Get-Process -Id $gc.ProcessId -ErrorAction SilentlyContinue
            if ($gp) { $procs += $gp }
        }
    }
    return $procs
}

function Measure-ColdStart {
    param([int]$RunIndex)
    $testDir = Join-Path $env:TEMP "urchin-perf-$RunIndex-$(Get-Random)"
    New-Item -ItemType Directory -Path $testDir -Force | Out-Null
    $logFile = Join-Path $testDir 'out.log'
    $env:URCHIN_TEST_USER_DATA = $testDir
    $env:PLAYWRIGHT = '1'
    $env:NODE_ENV = 'production'
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = Start-Process -FilePath $electron -ArgumentList "." -NoNewWindow -PassThru -RedirectStandardOutput $logFile -WorkingDirectory $appPath
    $windowShown = $false
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and -not $proc.HasExited) {
        Start-Sleep -Milliseconds 100
        if (Test-Path $logFile) {
            $content = Get-Content $logFile -Raw -ErrorAction SilentlyContinue
            if ($content -match 'window shown') { $sw.Stop(); $windowShown = $true; break }
        }
    }
    if (-not $windowShown) { $sw.Stop() }
    if (-not $proc.HasExited) {
        $tree = Get-ElectronProcessTree -RootPid $proc.Id
        $tree | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    }
    Start-Sleep -Milliseconds 800
    Remove-Item -Path $testDir -Recurse -Force -ErrorAction SilentlyContinue
    return $sw.ElapsedMilliseconds
}

function Get-Percentile {
    param([double[]]$arr, [int]$p)
    $sorted = $arr | Sort-Object
    $idx = [Math]::Ceiling(($p / 100.0) * $sorted.Count) - 1
    if ($idx -lt 0) { $idx = 0 }
    if ($idx -ge $sorted.Count) { $idx = $sorted.Count - 1 }
    return $sorted[$idx]
}

Write-Host "=== Urchin Browser W7 Performance ==="
Write-Host ""
Write-Host "--- Cold Start ($totalRuns runs, first warmup, P95 <= 3000ms) ---"
$times = @()
for ($i = 1; $i -le $totalRuns; $i++) {
    $elapsed = Measure-ColdStart -RunIndex $i
    $tag = if ($i -eq 1) { " (warmup)" } else { "" }
    Write-Host ("  Run {0,2}: {1,6}ms{2}" -f $i, $elapsed, $tag)
    if ($i -gt 1) { $times += [double]$elapsed }
}

if ($times.Count -gt 0) {
    $p50 = Get-Percentile -arr $times -p 50
    $p95 = Get-Percentile -arr $times -p 95
    $max = ($times | Measure-Object -Maximum).Maximum
    $min = ($times | Measure-Object -Minimum).Minimum
    Write-Host ""
    Write-Host ("  Stats (excl warmup): min={0}ms / p50={1}ms / p95={2}ms / max={3}ms" -f $min, $p50, $p95, $max)
    $pass = $p95 -le 3000
    Write-Host ("  P95 threshold 3000ms: {0}" -f $(if ($pass) { 'PASS' } else { 'FAIL' }))
}
Write-Host ""

# Memory: single tab idle
Write-Host "--- Memory (1 tab idle, <= 500MB threshold for 10 tabs) ---"
$testDir = Join-Path $env:TEMP "urchin-perf-mem-$(Get-Random)"
New-Item -ItemType Directory -Path $testDir -Force | Out-Null
$env:URCHIN_TEST_USER_DATA = $testDir
$env:PLAYWRIGHT = '1'
$env:NODE_ENV = 'production'
$proc = Start-Process -FilePath $electron -ArgumentList "." -NoNewWindow -PassThru -WorkingDirectory $appPath
Start-Sleep -Seconds 6
$tree = Get-ElectronProcessTree -RootPid $proc.Id
$totalWs = ($tree | Measure-Object -Property WorkingSet64 -Sum).Sum
$procCount = ($tree | Measure-Object).Count
$memMB = $totalWs / 1024 / 1024
Write-Host ("  1 tab idle: {0:N1} MB ({1} processes)" -f $memMB, $procCount)
$tree | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500
Remove-Item -Path $testDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "=== Done ==="
