Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32Close {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@
$hWnd = [Win32Close]::FindWindow($null, "Urchin Browser")
Write-Host "hWnd=$hWnd"
if ($hWnd -ne [IntPtr]::Zero) {
    $WM_CLOSE = 0x10
    [Win32Close]::PostMessage($hWnd, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Write-Host "WM_CLOSE posted"
    Start-Sleep -Seconds 5
    $proc = Get-Process electron -ErrorAction SilentlyContinue
    Write-Host ("Alive electron count=" + $proc.Count)
    if ($proc) { $proc | Format-Table Id, MainWindowTitle -AutoSize }
} else { Write-Host "Window not found" }
