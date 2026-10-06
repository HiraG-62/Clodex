import { expect, it, vi } from "vitest";
import { WindowsAccountSetup } from "./account-setup.js";
import { accountSetupSource } from "./admin-scripts.js";

it("DPAPI 保存後に平文ファイルを作り、SID とファイル名だけを UAC に渡す", async () => {
  const calls: string[] = [];
  const host = vi.fn(async (script: string) => {
    calls.push(script);
    return script.includes("$State|ConvertTo-Json -Compress") ? JSON.stringify({ humanSid: "S-1-5-21-1", agentSid: null }) : "";
  });
  await new WindowsAccountSetup("C:\\Users\\human", host).create();
  const encrypt = calls.findIndex((script) => script.includes("ConvertFrom-SecureString $Secret"));
  const handoff = calls.findIndex((script) => script.includes("$Credential.GetNetworkCredential().Password $true"));
  const elevated = calls.findIndex((script) => script.includes("-Verb RunAs"));
  expect(encrypt).toBeLessThan(handoff);
  expect(handoff).toBeLessThan(elevated);
  expect(calls[elevated]).toContain('-HumanSid "S-1-5-21-1"');
  expect(calls[elevated]).toContain('-SecretFile "C:\\Users\\human\\.clodex\\sandbox-admin\\password"');
  expect(calls[elevated]).not.toContain("GetNetworkCredential");
  expect(calls[0]).toContain("[IO.File]::Delete");
  expect(calls[elevated + 1]).toContain("[IO.File]::Delete");
  expect(accountSetupSource).not.toContain("ConvertFrom-SecureString");
  expect(accountSetupSource.indexOf("[IO.File]::Delete($SecretFile)")).toBeLessThan(accountSetupSource.indexOf("New-LocalUser"));
});

it("UAC の拒否・異常終了でも平文を除去し、プロファイル作成に進まない", async () => {
  const calls: string[] = [];
  const host = vi.fn(async (script: string) => {
    calls.push(script);
    if (script.includes("-Verb RunAs")) throw new Error("UAC 拒否");
    return script.includes("$State|ConvertTo-Json -Compress") ? JSON.stringify({ humanSid: "S-1-5-21-1", agentSid: null }) : "";
  });
  await expect(new WindowsAccountSetup("C:\\Users\\human", host).create()).rejects.toThrow("UAC 拒否");
  expect(calls.at(-1)).toContain("[IO.File]::Delete");
  expect(calls.some((script) => script.includes("-LoadUserProfile"))).toBe(false);
});
