import { expect, test } from "vitest";
import { denyOnlySource } from "./sandbox-deny-only-source.js";

test("診断トークンは AU のみ無効化し、restricting SID は空にする", () => {
  const source = denyOnlySource();
  expect(source).toContain('ConvertStringSidToSid("S-1-5-11",out au)');
  expect(source).toContain("CreateRestrictedToken(original,0,1,disabledBuffer,0,IntPtr.Zero,0,new SidEntry[0],out restricted)");
  expect(source).toContain('ProtectedDescriptor(human)');
  expect(source).toContain('SetDefaultDacl(restricted,sidText,logon.Item1)');
});
