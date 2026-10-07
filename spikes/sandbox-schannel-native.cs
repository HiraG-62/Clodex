using System;
using System.Runtime.InteropServices;
public static class SchannelProbe {
  [StructLayout(LayoutKind.Sequential)] struct Handle { public IntPtr lower,upper; }
  [StructLayout(LayoutKind.Sequential)] struct Credential {
    public uint version,count; public IntPtr certificates,store; public uint mappers;
    public IntPtr mapper; public uint algorithmCount; public IntPtr algorithms; public uint enabledProtocols,minCipher,maxCipher,lifespan,flags,format;
  }
  [DllImport("secur32.dll",CharSet=CharSet.Unicode)] static extern int AcquireCredentialsHandle(string principal,string package,uint use,IntPtr logon,IntPtr auth,IntPtr getKey,IntPtr arg,out Handle credential,out long expiry);
  [DllImport("secur32.dll")] static extern int FreeCredentialsHandle(ref Handle credential);
  [DllImport("secur32.dll")] static extern int LsaConnectUntrusted(out IntPtr handle);
  [DllImport("secur32.dll")] static extern int LsaDeregisterLogonProcess(IntPtr handle);
  [DllImport("ncrypt.dll",CharSet=CharSet.Unicode)] static extern int NCryptOpenStorageProvider(out IntPtr provider,string name,uint flags);
  [DllImport("ncrypt.dll",CharSet=CharSet.Unicode)] static extern int NCryptCreatePersistedKey(IntPtr provider,out IntPtr key,string algorithm,string name,uint spec,uint flags);
  [DllImport("ncrypt.dll")] static extern int NCryptFinalizeKey(IntPtr key,uint flags);
  [DllImport("ncrypt.dll")] static extern int NCryptFreeObject(IntPtr handle);
  [DllImport("bcrypt.dll",CharSet=CharSet.Unicode)] static extern int BCryptOpenAlgorithmProvider(out IntPtr algorithm,string name,string implementation,uint flags);
  [DllImport("bcrypt.dll")] static extern int BCryptCloseAlgorithmProvider(IntPtr algorithm,uint flags);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,int size,out int needed);
  [DllImport("advapi32.dll")] static extern bool IsTokenRestricted(IntPtr token);
  [DllImport("secur32.dll")] static extern int LsaGetLogonSessionData(IntPtr logon,out IntPtr data);
  [DllImport("secur32.dll")] static extern int LsaFreeReturnBuffer(IntPtr data);
  static void Result(string name,int code) {Console.WriteLine(name+"=0x"+code.ToString("X8"));}
  public static void Main() {
    IntPtr current;if(OpenProcessToken(GetCurrentProcess(),8,out current)){
      Console.WriteLine("IsTokenRestricted="+IsTokenRestricted(current));
      IntPtr stats=Marshal.AllocHGlobal(256);int needed;
      if(GetTokenInformation(current,10,stats,256,out needed)){IntPtr data;int code=LsaGetLogonSessionData(IntPtr.Add(stats,8),out data);Result("LsaGetLogonSessionData",code);if(code==0)LsaFreeReturnBuffer(data);}
      Marshal.FreeHGlobal(stats);CloseHandle(current);
    }
    foreach(uint access in new uint[]{8,2,0x20000}) {IntPtr token;bool ok=OpenProcessToken(GetCurrentProcess(),access,out token);Result("OpenSelfToken."+access,ok?0:Marshal.GetLastWin32Error());if(ok)CloseHandle(token);}
    IntPtr lsa; int status=LsaConnectUntrusted(out lsa);Result("LsaConnectUntrusted",status);if(status==0)LsaDeregisterLogonProcess(lsa);
    foreach(string package in new[]{"Negotiate","Microsoft Unified Security Protocol Provider"}){
      Handle credential;long expiry;status=AcquireCredentialsHandle(null,package,2,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,out credential,out expiry);
      Result("Acquire.default."+package,status);if(status==0)FreeCredentialsHandle(ref credential);
    }
    foreach(uint flags in new uint[]{0,0x18}) {
      var data=new Credential();data.version=4;data.flags=flags;
      IntPtr buffer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Credential)));
      try {Marshal.StructureToPtr(data,buffer,false);Handle credential;long expiry;
        status=AcquireCredentialsHandle(null,"Microsoft Unified Security Protocol Provider",2,IntPtr.Zero,buffer,IntPtr.Zero,IntPtr.Zero,out credential,out expiry);
        Result("Acquire.schannel.flags"+flags,status);if(status==0)FreeCredentialsHandle(ref credential);
      }finally{Marshal.FreeHGlobal(buffer);}
    }
    IntPtr provider;status=NCryptOpenStorageProvider(out provider,"Microsoft Software Key Storage Provider",0);Result("NCryptOpenStorageProvider",status);
    if(status==0){IntPtr key;status=NCryptCreatePersistedKey(provider,out key,"RSA",null,0,0);Result("NCryptCreate.ephemeral",status);if(status==0){Result("NCryptFinalize",NCryptFinalizeKey(key,0));NCryptFreeObject(key);}NCryptFreeObject(provider);}
    foreach(string name in new[]{"RNG","SHA256","AES","ECDH_P256"}){IntPtr algorithm;status=BCryptOpenAlgorithmProvider(out algorithm,name,null,0);Result("BCrypt."+name,status);if(status==0)BCryptCloseAlgorithmProvider(algorithm,0);}
  }
}
