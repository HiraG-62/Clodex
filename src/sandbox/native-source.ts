export const nativeSource = String.raw`
using System;
using System.Linq;
using System.Text;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Collections.Generic;
public static class TokenLauncher {
  const uint WRITE_RESTRICTED=0x8, TOKEN_ASSIGN_PRIMARY=1, TOKEN_DUPLICATE=2, TOKEN_QUERY=8, TOKEN_ADJUST_DEFAULT=0x80, SE_GROUP_LOGON_ID=0xc0000000;
  const int TOKEN_GROUPS=2, TOKEN_DEFAULT_DACL=6, TOKEN_RESTRICTED_SIDS=11;
  const uint DUPLICATE_SAME_ACCESS=2, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x2000, RESUME_FAILED=0xffffffff;
  const int STARTF_USESTDHANDLES=0x100, CREATE_SUSPENDED=4, CREATE_NO_WINDOW=0x08000000, JOB_EXTENDED_LIMIT=9, STD_INPUT_HANDLE=-10;
  [StructLayout(LayoutKind.Sequential)] struct SidEntry { public IntPtr sid; public uint attributes; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
    public int cb; public string reserved,desktop,title; public int x,y,xSize,ySize,xChars,yChars,fill,flags;
    public short show,reserved2; public IntPtr reservedPointer,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public int pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct Limit { public BasicLimit basic; public Io io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr token,uint flags,uint disabled,IntPtr disabledSids,uint privileges,IntPtr deletedPrivileges,uint count,[In] SidEntry[] restricting,out IntPtr result);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr buffer,int size,out int needed);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,int kind,IntPtr buffer,int size);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool IsTokenRestricted(IntPtr token);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern int RegOpenKeyEx(IntPtr key,string name,uint options,uint access,out IntPtr result);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern int RegCreateKeyEx(IntPtr key,string name,uint reserved,string type,uint options,uint access,IntPtr security,out IntPtr result,out uint disposition);
  [DllImport("advapi32.dll")] static extern int RegCloseKey(IntPtr key);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSidToSid(string text,out IntPtr sid);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessAsUser(IntPtr token,string app,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,int flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo result);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool DeleteFile(string path);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int index);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr process,IntPtr handle,IntPtr target,out IntPtr copy,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Limit limit,int length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  static void Check(bool ok,string operation) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error(),operation+": "+new Win32Exception(Marshal.GetLastWin32Error()).Message); }
  static string Quote(string value) {
    var b=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) { if(c=='\\') { slashes++; continue; } if(c=='\"') { b.Append('\\',slashes*2+1); b.Append(c); } else { b.Append('\\',slashes); b.Append(c); } slashes=0; }
    b.Append('\\',slashes*2); b.Append('"'); return b.ToString();
  }
  static List<Tuple<string,uint>> Groups(IntPtr token,int kind) {
    int size; GetTokenInformation(token,kind,IntPtr.Zero,0,out size);
    IntPtr buffer=Marshal.AllocHGlobal(size);
    try {
      Check(GetTokenInformation(token,kind,buffer,size,out size),"GetTokenInformation");
      int count=Marshal.ReadInt32(buffer); var result=new List<Tuple<string,uint>>();
      for(int i=0;i<count;i++) {
        var entry=(SidEntry)Marshal.PtrToStructure(IntPtr.Add(buffer,IntPtr.Size+i*Marshal.SizeOf(typeof(SidEntry))),typeof(SidEntry));
        result.Add(Tuple.Create(new SecurityIdentifier(entry.sid).Value,entry.attributes));
      }
      return result;
    } finally {Marshal.FreeHGlobal(buffer);}
  }
  static void SetDefaultDacl(IntPtr token,string restrictingSid) {
    string user; using(var identity=WindowsIdentity.GetCurrent()) user=identity.User.Value;
    var descriptor=new RawSecurityDescriptor("D:(A;;GA;;;"+user+")(A;;GA;;;"+restrictingSid+")(A;;GA;;;SY)");
    var bytes=new byte[descriptor.DiscretionaryAcl.BinaryLength]; descriptor.DiscretionaryAcl.GetBinaryForm(bytes,0);
    IntPtr acl=Marshal.AllocHGlobal(bytes.Length),info=Marshal.AllocHGlobal(IntPtr.Size);
    try {Marshal.Copy(bytes,0,acl,bytes.Length);Marshal.WriteIntPtr(info,acl);Check(SetTokenInformation(token,TOKEN_DEFAULT_DACL,info,IntPtr.Size),"SetTokenInformation default DACL");}
    finally {Marshal.FreeHGlobal(info);Marshal.FreeHGlobal(acl);}
  }
  public static int Main(string[] args) {
    try {
      using(var identity=WindowsIdentity.GetCurrent()) {
        if(args.Length==1 && args[0]=="--inspect") { Console.WriteLine("{\"sid\":\""+identity.User.Value+"\",\"restricted\":"+IsTokenRestricted(identity.Token).ToString().ToLowerInvariant()+",\"restrictingSids\":["+String.Join(",",Groups(identity.Token,TOKEN_RESTRICTED_SIDS).Select(group=>"\""+group.Item1+"\""))+ "]}"); return 0; }
        if(new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator)) throw new Exception("elevated token rejected");
      }
      if(args.Length<4) throw new ArgumentException("sid cwd timeout application [arguments]");
      return Run(args[0],args[1],UInt32.Parse(args[2]),args[3],args.Skip(4).ToArray());
    } catch(Exception error) { Console.Error.WriteLine(error.ToString()); return 1; }
  }
  static int Run(string sidText,string cwd,uint timeout,string app,string[] args) {
    using(var identity=WindowsIdentity.GetCurrent()) if(identity.User.Value!=sidText) throw new Exception("agent SID mismatch");
    IntPtr original=IntPtr.Zero,restricted=IntPtr.Zero,job=IntPtr.Zero;
    var allocatedSids=new List<IntPtr>();
    var handles=new IntPtr[3]; var info=new ProcessInfo();
    try {
      Check(OpenProcessToken(GetCurrentProcess(),TOKEN_ASSIGN_PRIMARY|TOKEN_DUPLICATE|TOKEN_QUERY|TOKEN_ADJUST_DEFAULT,out original),"OpenProcessToken");
      if(IsTokenRestricted(original)) throw new Exception("caller already restricted; SID intersection requires separate investigation");
      var logon=Groups(original,TOKEN_GROUPS).Single(group=>(group.Item2&SE_GROUP_LOGON_ID)==SE_GROUP_LOGON_ID);
      var sidTexts=new List<string>{sidText,logon.Item1,"S-1-1-0","S-1-5-32-545"};
      var entries=new List<SidEntry>();
      foreach(string text in sidTexts){IntPtr sid;Check(ConvertStringSidToSid(text,out sid),"ConvertStringSidToSid");allocatedSids.Add(sid);var entry=new SidEntry();entry.sid=sid;entries.Add(entry);}
      Check(CreateRestrictedToken(original,WRITE_RESTRICTED,0,IntPtr.Zero,0,IntPtr.Zero,(uint)entries.Count,entries.ToArray(),out restricted),"CreateRestrictedToken");
      SetDefaultDacl(restricted,sidText);
      for(int i=0;i<handles.Length;i++) Check(DuplicateHandle(GetCurrentProcess(),GetStdHandle(STD_INPUT_HANDLE-i),GetCurrentProcess(),out handles[i],0,true,DUPLICATE_SAME_ACCESS),"DuplicateHandle");
      job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"CreateJobObject");
      var limit=new Limit(); limit.basic.flags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; Check(SetInformationJobObject(job,JOB_EXTENDED_LIMIT,ref limit,Marshal.SizeOf(limit)),"SetInformationJobObject");
      var startup=new Startup(); startup.cb=Marshal.SizeOf(startup); startup.flags=STARTF_USESTDHANDLES; startup.input=handles[0]; startup.output=handles[1]; startup.error=handles[2];
      var command=new StringBuilder(String.Join(" ",new[]{app}.Concat(args).Select(Quote)));
      Check(CreateProcessAsUser(restricted,app,command,IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|CREATE_NO_WINDOW,IntPtr.Zero,cwd,ref startup,out info),"CreateProcessAsUser");
      if(!AssignProcessToJobObject(job,info.process)) { int error=Marshal.GetLastWin32Error(); TerminateProcess(info.process,1); throw new Win32Exception(error,"AssignProcessToJobObject"); }
      if(ResumeThread(info.thread)==RESUME_FAILED) throw new Win32Exception(Marshal.GetLastWin32Error(),"ResumeThread");
      if(WaitForSingleObject(info.process,timeout)!=0) throw new TimeoutException("restricted child timeout");
      uint code; Check(GetExitCodeProcess(info.process,out code),"GetExitCodeProcess"); return (int)code;
    } finally {
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(info.thread!=IntPtr.Zero) CloseHandle(info.thread); if(info.process!=IntPtr.Zero) CloseHandle(info.process);
      foreach(var handle in handles) if(handle!=IntPtr.Zero) CloseHandle(handle);
      if(restricted!=IntPtr.Zero) CloseHandle(restricted); if(original!=IntPtr.Zero) CloseHandle(original); foreach(IntPtr sid in allocatedSids) LocalFree(sid);
    }
  }
}
`;
