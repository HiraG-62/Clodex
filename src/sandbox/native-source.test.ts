import { expect, it } from "vitest";
import { nativeSource } from "./native-source.js";

it("AU と INTERACTIVE のみを deny-only にし、restricting SID を渡さない", () => {
  expect(nativeSource).toContain('DISABLED_GROUPS={"S-1-5-11","S-1-5-4"}');
  expect(nativeSource).toContain(
    "CreateRestrictedToken(original,RESTRICTED_TOKEN_FLAGS,(uint)entries.Count,entries.ToArray(),0,IntPtr.Zero,0,new SidEntry[0],out restricted)",
  );
  expect(nativeSource).toContain("RESTRICTED_TOKEN_FLAGS=0");
});
