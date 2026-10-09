param(
  [Parameter(Mandatory=$true)][int]$HubPid,
  [Parameter(Mandatory=$true)][int]$TargetPid,
  [Parameter(Mandatory=$true)][string]$ResultFile
)

$started = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$source = @'
using System;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class OrphanJob {
  const uint KILL_ON_JOB_CLOSE = 0x2000;
  const int JobObjectExtendedLimitInformation = 9;
  const uint PROCESS_SET_QUOTA = 0x100, PROCESS_TERMINATE = 1, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, SYNCHRONIZE = 0x100000;
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long processTime, jobTime; public uint flags; public UIntPtr min, max; public uint active; public UIntPtr affinity; public uint priority, scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct Limit { public BasicLimit basic; public Io io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limit info, int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool okay, string action) { if (!okay) throw new Win32Exception(Marshal.GetLastWin32Error(), action); }
  public static void Run(int hubPid, int targetPid, string output, long started, long compiled) {
    IntPtr hub=OpenProcess(SYNCHRONIZE,false,hubPid);
    Check(hub!=IntPtr.Zero,"OpenProcess hub");
    IntPtr target=OpenProcess(PROCESS_SET_QUOTA|PROCESS_TERMINATE|PROCESS_QUERY_LIMITED_INFORMATION,false,targetPid);
    Check(target!=IntPtr.Zero,"OpenProcess target");
    IntPtr job=CreateJobObject(IntPtr.Zero,null);
    Check(job!=IntPtr.Zero,"CreateJobObject");
    try {
      Limit limit=new Limit();limit.basic.flags=KILL_ON_JOB_CLOSE;
      Check(SetInformationJobObject(job,JobObjectExtendedLimitInformation,ref limit,Marshal.SizeOf(typeof(Limit))),"SetInformationJobObject");
      Check(AssignProcessToJobObject(job,target),"AssignProcessToJobObject");
      long assigned=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
      System.IO.File.WriteAllText(output,"{\"started\":"+started+",\"compiled\":"+compiled+",\"assigned\":"+assigned+",\"status\":\"assigned\"}");
      WaitForSingleObject(hub,0xffffffff);
      long closed=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
      CloseHandle(job);job=IntPtr.Zero;
      System.IO.File.WriteAllText(output,"{\"started\":"+started+",\"compiled\":"+compiled+",\"assigned\":"+assigned+",\"closed\":"+closed+",\"status\":\"closed\"}");
    } finally { if(job!=IntPtr.Zero)CloseHandle(job);CloseHandle(target);CloseHandle(hub); }
  }
}
'@

try {
  Add-Type -TypeDefinition $source -ErrorAction Stop
  $compiled = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  [OrphanJob]::Run($HubPid, $TargetPid, $ResultFile, $started, $compiled)
} catch {
  @{ status = 'error'; message = $_.Exception.Message; started = $started; failed = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultFile -Encoding UTF8
  exit 1
}
