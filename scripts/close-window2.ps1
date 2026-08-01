Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32Close2 {
    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
$WM_CLOSE = 0x10
$altF4Sent = $false
$p = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne "" } | Select-Object -First 1
if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
    Write-Host "Found MainWindowHandle=$($p.MainWindowHandle) Title=$($p.MainWindowTitle)"
    [Win32Close2]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 300
    [Win32Close2]::PostMessage($p.MainWindowHandle, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Write-Host "WM_CLOSE posted"
    Start-Sleep -Seconds 6
    $proc = Get-Process electron -ErrorAction SilentlyContinue
    Write-Host ("Alive electron count=" + $proc.Count)
    if ($proc) { $proc | Format-Table Id, MainWindowTitle -AutoSize }
} else { Write-Host "No electron window found" }
