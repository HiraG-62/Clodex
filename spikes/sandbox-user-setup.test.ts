import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { psQuote } from "./sandbox-user.js";

const setupPath = fileURLToPath(new URL("./sandbox-user-setup.ps1", import.meta.url));
const run = (script: string) => spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${script}`, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true });

describe.skipIf(process.platform !== "win32")("setup の副作用なし検証", () => {
  it("UTF-8 BOM 付きで PowerShell 5.1 の構文解析が通る", () => {
    expect([...readFileSync(setupPath).subarray(0, 3)]).toEqual([239, 187, 191]);
    const result = run(`$tokens=$null; $errors=$null; [void][Management.Automation.Language.Parser]::ParseFile(${psQuote(setupPath)},[ref]$tokens,[ref]$errors); if($errors.Count) { throw ($errors | Out-String) }`);
    expect(result.status, result.stderr).toBe(0);
  });

  it("Status は管理者判定や変更処理へ進まず、有無を JSON で返す", () => {
    const result = run(`function Get-LocalUser { param($Name,$ErrorAction) return $null }; function Test-Path { param($LiteralPath) return $false }; & ${psQuote(setupPath)} -Status`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ userExists: false, credentialExists: false, stateExists: false, configured: false });
  });

  it.each([true, false])("Status は完了記録 %s に従って configured を返す", complete => {
    const result = run(`function Get-LocalUser { param($Name,$ErrorAction) return @{SID=@{Value='test-agent'};Enabled=$true} }; function Test-Path { param($LiteralPath) return $true }; function Get-Content { param($LiteralPath,[switch]$Raw) @{humanSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;agentSid='test-agent';complete=$${complete}} | ConvertTo-Json }; & ${psQuote(setupPath)} -Status`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ userExists: true, credentialExists: true, stateExists: true, configured: complete });
  });

  it("セットアップ済みの再実行は再作成せず、別 SID や未完了状態は拒否する", () => {
    const result = run(`
$tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseFile(${psQuote(setupPath)},[ref]$tokens,[ref]$errors);
$fn=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-SetupAction'},$true);
if(-not $fn) { throw 'Get-SetupAction missing' }; . ([ScriptBlock]::Create($fn.Extent.Text));
$results=@(); $results+=Get-SetupAction $null $null $false 'human' 'E:\\test' 'C:\\artifacts';
$state=@{humanSid='human';agentSid='agent';project='E:\\test';artifacts='C:\\artifacts';complete=$true};
$agent=@{SID=@{Value='agent'};Enabled=$true};
$results+=Get-SetupAction $state $agent $true 'human' 'E:\\test' 'C:\\artifacts';
$results+=Get-SetupAction $state $agent $true 'human' 'E:\\test' 'C:\\artifacts';
$agent.SID.Value='other'; try { Get-SetupAction $state $agent $true 'human' 'E:\\test' 'C:\\artifacts'; throw 'unexpected-success' } catch { if($_.Exception.Message -eq 'unexpected-success') { throw }; $results+='rejected-sid' };
$agent.SID.Value='agent'; $state.complete=$false; try { Get-SetupAction $state $agent $true 'human' 'E:\\test' 'C:\\artifacts'; throw 'unexpected-success' } catch { if($_.Exception.Message -eq 'unexpected-success') { throw }; $results+='rejected-incomplete' };
$results | ConvertTo-Json -Compress`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["create", "reuse", "reuse", "rejected-sid", "rejected-incomplete"]);
  });
});
