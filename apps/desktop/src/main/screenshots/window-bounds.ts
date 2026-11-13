import { execFile } from 'node:child_process';
import { z } from 'zod';
import { promisify } from 'node:util';

/** EnumWindows 返回前到后的可见窗口；坐标是物理像素，与桌面截图一致。 */
export async function getWindowBounds(): Promise<
  { x: number; y: number; width: number; height: number }[]
> {
  if (process.platform !== 'win32') return [];
  const script = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class CaptureWindows {
  public delegate bool Callback(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int L,T,R,B; }
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out Rect r, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int value, int size);
  public static string Read() {
    SetProcessDPIAware();
    var rows = new List<string>();
    EnumWindows((h,p) => {
      Rect r;
      int cloaked;
      if (DwmGetWindowAttribute(h,14,out cloaked,4)==0 && cloaked!=0) return true;
      if (IsWindowVisible(h) && !IsIconic(h) && GetWindowRect(h,out r)) {
        Rect frame;
        if (DwmGetWindowAttribute(h,9,out frame,16)==0) r=frame;
        if (r.R-r.L>30 && r.B-r.T>30) rows.Add("{\"x\":"+r.L+",\"y\":"+r.T+",\"width\":"+(r.R-r.L)+",\"height\":"+(r.B-r.T)+"}");
      }
      return true;
    },IntPtr.Zero);
    return "["+string.Join(",",rows)+"]";
  }
}
"@
[CaptureWindows]::Read()
`;
  try {
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 5000 },
    );
    return z
      .array(z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }))
      .parse(JSON.parse(stdout.trim()));
  } catch {
    // 原生枚举不可用时仍允许手动框选。
    return [];
  }
}
