import { nativeSource } from "../src/sandbox/native-source.js";

export function denyOnlySource(): string {
  const call = 'Check(CreateRestrictedToken(original,RESTRICTED_TOKEN_FLAGS,0,IntPtr.Zero,0,IntPtr.Zero,(uint)entries.Count,entries.ToArray(),out restricted),"CreateRestrictedToken");';
  if (!nativeSource.includes(call)) throw new Error("helper の構造が変わったため再確認が必要");
  return nativeSource.replace('if(args.Length==1 && args[0]=="--inspect") {', 'if(args.Length==1 && args[0]=="--inspect") { foreach(var group in Groups(identity.Token,TOKEN_GROUPS))Console.WriteLine("group="+group.Item1+" attributes="+group.Item2);').replace(call, String.raw`
      IntPtr au;Check(ConvertStringSidToSid("S-1-5-11",out au),"AU SID");allocatedSids.Add(au);
      var disabled=new SidEntry();disabled.sid=au;
      var disabledBuffer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SidEntry)));
      try {
        Marshal.StructureToPtr(disabled,disabledBuffer,false);
        Check(CreateRestrictedToken(original,0,1,disabledBuffer,0,IntPtr.Zero,0,new SidEntry[0],out restricted),"CreateRestrictedToken deny-only");
      } finally {Marshal.FreeHGlobal(disabledBuffer);}
      Console.Error.WriteLine("deny-only AU attributes="+Groups(restricted,TOKEN_GROUPS).Single(group=>group.Item1=="S-1-5-11").Item2);
  `);
}
