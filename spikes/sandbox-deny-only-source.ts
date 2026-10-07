import { nativeSource } from "../src/sandbox/native-source.js";

export function denyOnlySource(interactive = false): string {
  const groups='DISABLED_GROUPS={"S-1-5-11","S-1-5-4"}';
  if (!nativeSource.includes(groups)) throw new Error("helper の構造が変わったため再確認が必要");
  return nativeSource.replace(groups,interactive?groups:'DISABLED_GROUPS={"S-1-5-11"}').replace(
    'if(args.Length==1 && args[0]=="--inspect") {',
    'if(args.Length==1 && args[0]=="--inspect") { foreach(var group in Groups(identity.Token,TOKEN_GROUPS))Console.WriteLine("group="+group.Item1+" attributes="+group.Item2);',
  );
}
