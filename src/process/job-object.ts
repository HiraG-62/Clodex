import { spawn } from "node:child_process";
import { POWERSHELL, psArgs } from "../sandbox/powershell.js";

const JOB_TIMEOUT_MS = 10_000;
const oneLine = (message: string): string => message.replace(/\s+/g, " ").trim();

const nativeSource = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class HubJob {
  const uint PROCESS_SET_QUOTA=0x100, PROCESS_TERMINATE=1, PROCESS_DUP_HANDLE=0x40, DUPLICATE_SAME_ACCESS=2, KILL_ON_JOB_CLOSE=0x2000;
  const int JobObjectExtendedLimitInformation=9;
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct Limit { public BasicLimit basic; public Io io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr copy,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Limit info,int size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool okay,string action) { if(!okay) throw new Win32Exception(Marshal.GetLastWin32Error(),action); }
  public static void Attach(int pid) {
    IntPtr hub=IntPtr.Zero,job=IntPtr.Zero;
    try {
      hub=OpenProcess(PROCESS_SET_QUOTA|PROCESS_TERMINATE|PROCESS_DUP_HANDLE,false,pid);
      Check(hub!=IntPtr.Zero,"OpenProcess");
      job=CreateJobObject(IntPtr.Zero,null);
      Check(job!=IntPtr.Zero,"CreateJobObject");
      var limit=new Limit(); limit.basic.flags=KILL_ON_JOB_CLOSE;
      Check(SetInformationJobObject(job,JobObjectExtendedLimitInformation,ref limit,Marshal.SizeOf(typeof(Limit))),"SetInformationJobObject");
      IntPtr copy;
      Check(DuplicateHandle(GetCurrentProcess(),job,hub,out copy,0,false,DUPLICATE_SAME_ACCESS),"DuplicateHandle");
      Check(AssignProcessToJobObject(job,hub),"AssignProcessToJobObject");
    } finally {
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(hub!=IntPtr.Zero) CloseHandle(hub);
    }
  }
}
`;

type HelperResult = { code: number | null; stderr: string };
type Helper = (script: string, signal: AbortSignal) => Promise<HelperResult>;

const runPowerShell: Helper = (script, signal) => new Promise((resolve, reject) => {
  const child = spawn(POWERSHELL, psArgs(script), { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], signal });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => { stderr += text; });
  child.once("error", reject);
  child.once("close", (code) => resolve({ code, stderr: stderr.trim() }));
});

export const registerHubJob = async ({
  platform = process.platform, pid = process.pid, run = runPowerShell, timeoutMs = JOB_TIMEOUT_MS,
}: { platform?: NodeJS.Platform; pid?: number; run?: Helper; timeoutMs?: number } = {}): Promise<{ ok: true } | { ok: false; message: string }> => {
  if (platform !== "win32") return { ok: true };
  const script = `$source = @'\n${nativeSource}\n'@; Add-Type -TypeDefinition $source; [HubJob]::Attach(${pid})`;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error("timeout"));
      reject(new Error("timeout"));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([run(script, controller.signal), deadline]);
    if (result.code !== 0) return { ok: false, message: oneLine(result.stderr) || `PowerShell exit ${result.code}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, message: oneLine(error instanceof Error ? error.message : String(error)) };
  } finally {
    if (timer) clearTimeout(timer);
  }
};
