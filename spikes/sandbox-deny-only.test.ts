import { expect, test } from "vitest";
import { denyOnlySource } from "./sandbox-deny-only-source.js";

test("診断トークンは AU のみ無効化し、restricting SID は空にする", () => {
  const source = denyOnlySource();
  expect(source).toContain('DISABLED_GROUPS={"S-1-5-11"}');
  expect(source).toContain("CreateRestrictedToken(original,RESTRICTED_TOKEN_FLAGS,(uint)entries.Count,entries.ToArray(),0,IntPtr.Zero,0,new SidEntry[0],out restricted)");
  expect(source).toContain('ProtectedDescriptor(human)');
  expect(source).toContain('SetDefaultDacl(restricted,sidText,logon.Item1)');
});
test("INTERACTIVE 追加時は2つのグループを無効化する",()=>{
  expect(denyOnlySource(true)).toContain('DISABLED_GROUPS={"S-1-5-11","S-1-5-4"}');
});
