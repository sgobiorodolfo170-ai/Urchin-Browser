# Read-only Windows resident page attribution; no working-set trimming.
# Layout: https://learn.microsoft.com/windows/win32/api/psapi/ns-psapi-psapi_working_set_block
param([Parameter(Mandatory=$true)][string]$ProcessIds)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
public static class UrchinWorkingSet {
 public static HashSet<string> SharedImagePages = new HashSet<string>();
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int id);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("psapi.dll", SetLastError=true)] static extern bool QueryWorkingSet(IntPtr h, IntPtr buffer, int size);
 public class Bucket { public string name; public long residentBytes; public long sharedAcrossProcessesBytes; }
 public class Result { public int pid; public long residentBytes; public long sharedAcrossProcessesBytes; public long exclusiveResidentBytes; public long privateCommittedBytes; public long sharedNonModuleBytes; public Bucket[] buckets; }
 public static Result Snapshot(int id) {
  if (IntPtr.Size != 8) throw new Exception("64-bit PowerShell required");
  var process = Process.GetProcessById(id);
  var modules = process.Modules.Cast<ProcessModule>().OrderBy(m => m.BaseAddress.ToInt64()).ToArray();
  var groups = new Dictionary<string,Bucket>();
  var h = OpenProcess(0x0410, false, id);
  if (h == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
  IntPtr buffer = IntPtr.Zero;
  try {
   int size = 1024*1024;
   while (true) {
    buffer = Marshal.AllocHGlobal(size);
    if (QueryWorkingSet(h, buffer, size)) break;
    var error = Marshal.GetLastWin32Error();
    Marshal.FreeHGlobal(buffer); buffer = IntPtr.Zero;
    if (error != 24 || size >= 128*1024*1024) throw new System.ComponentModel.Win32Exception(error);
    size *= 2;
   }
   var count = Marshal.ReadInt64(buffer);
   long shared = 0; long sharedNonModule = 0;
   for (long i=0; i<count; i++) {
    ulong flags = unchecked((ulong)Marshal.ReadInt64(buffer, checked((int)((i+1)*8))));
    long addr = unchecked((long)(flags & 0xfffffffffffff000UL));
    bool isShared = (flags & 256) != 0 && ((flags >> 5) & 7) > 1;
    string name = "[non-module mappings / heaps]";
    int low=0, high=modules.Length-1, found=-1;
    while(low<=high) { int mid=(low+high)/2; if(modules[mid].BaseAddress.ToInt64()<=addr){found=mid;low=mid+1;}else high=mid-1; }
    if(found>=0 && addr < modules[found].BaseAddress.ToInt64()+modules[found].ModuleMemorySize) name=modules[found].ModuleName;
    Bucket bucket;
    if(!groups.TryGetValue(name,out bucket)){bucket=new Bucket {name=name};groups.Add(name,bucket);}
    bucket.residentBytes += 4096;
    if(isShared){
     shared+=4096; bucket.sharedAcrossProcessesBytes+=4096;
     if(name != "[non-module mappings / heaps]") SharedImagePages.Add(modules[found].FileName.ToLowerInvariant()+":"+(addr-modules[found].BaseAddress.ToInt64()).ToString("x"));
     else sharedNonModule += 4096;
    }
   }
   return new Result {pid=id,residentBytes=count*4096,sharedAcrossProcessesBytes=shared,exclusiveResidentBytes=count*4096-shared,privateCommittedBytes=process.PrivateMemorySize64,sharedNonModuleBytes=sharedNonModule,buckets=groups.Values.OrderByDescending(b=>b.residentBytes).ToArray()};
  } finally { if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer); CloseHandle(h); }
 }
}
'@
$results = foreach ($processIdText in $ProcessIds.Split(',')) {
 try { [UrchinWorkingSet]::Snapshot([int]$processIdText) }
 catch { [pscustomobject]@{pid=[int]$processIdText;error=$_.Exception.Message} }
}
$exclusive = ($results | Measure-Object -Property exclusiveResidentBytes -Sum).Sum
$sharedNonImage = ($results | Measure-Object -Property sharedNonModuleBytes -Sum).Sum
$sharedImagesUnique = [UrchinWorkingSet]::SharedImagePages.Count * 4096L
[pscustomobject]@{
 processes = @($results)
 sharedImagesUniqueResidentBytes = $sharedImagesUnique
 summedExclusiveResidentBytes = $exclusive
 summedSharedNonImageResidentBytes = $sharedNonImage
 residentUnionUpperBoundBytes = $exclusive + $sharedNonImage + $sharedImagesUnique
 note = 'Image pages shared across processes are deduplicated by file path and image offset. Shared non-image mappings remain summed, so this is an upper bound, not an exact PSS or a replacement budget metric.'
} | ConvertTo-Json -Depth 6 -Compress
