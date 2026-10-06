import { expect, it } from "vitest";
import { accountSetupSource, accountUninstallSource } from "./admin-scripts.js";
import { runHost, psQuote } from "./powershell.js";

it.runIf(process.platform === "win32")("管理者スクリプトの構文を実行せずに PowerShell 5.1 で検証する", async () => {
  for (const source of [accountSetupSource, accountUninstallSource]) {
    const encoded = Buffer.from(source, "utf8").toString("base64");
    const errors = await runHost(`$Tokens=$null;$Errors=$null;[void][Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psQuote(encoded)})),[ref]$Tokens,[ref]$Errors);$Errors|ForEach-Object {$_.Message}`);
    expect(errors).toBe("");
  }
});

it("Deny の除去は記録した SID と権利に限定し、継承の保護状態を変えない", () => {
  expect(accountUninstallSource).toContain("$Legacy.deniedDrives");
  expect(accountUninstallSource).toContain("$Ace.SecurityIdentifier.Value -eq $Sid.Value");
  expect(accountUninstallSource).toContain("$Ace.AccessMask -eq $DriveDenyRights");
  expect(accountUninstallSource).not.toContain("SetAccessRuleProtection");
  expect(accountUninstallSource).not.toContain("Remove-Item -Recurse");
});
