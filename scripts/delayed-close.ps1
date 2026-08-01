param([int]$DelayMs=300)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WC {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
"@
Start-Sleep -Milliseconds $DelayMs
$WM_CLOSE = 0x10
$att=0
while($att -lt 40) {
  $p = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -ne "" } | Select-Object -First 1
  if($p) {
    [WC]::PostMessage($p.MainWindowHandle, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Write-Host "POSTED_WM_CLOSE_AFTER_${DelayMs}ms_Attempt=$att_hWnd=$($p.MainWindowHandle)"
    break
  }
  Start-Sleep -Milliseconds 25
  $att++
}
