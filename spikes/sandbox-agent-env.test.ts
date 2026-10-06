import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnvironmentScript, psQuote } from "./sandbox-user.js";

describe.skipIf(process.platform !== "win32")("専用ユーザーの環境構築", () => {
  it("ProfileList のプロファイルと Machine の PATH を使い、人の設定を置き換える", () => {
    const base = mkdtempSync(join(tmpdir(), "clodex-env-"));
    const profile = join(base, "Agent O'環境");
    const roaming = join(profile, "AppData", "Roaming");
    const local = join(profile, "AppData", "Local");
    const temp = join(local, "Temp");
    try {
      const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
function Get-ItemProperty { param($LiteralPath) $script:lookup=$LiteralPath; return @{ProfileImagePath=${psQuote(profile)}} };
$env:USERPROFILE='C:\\Human'; $env:APPDATA='C:\\Human\\Roaming'; $env:LOCALAPPDATA='C:\\Human\\Local'; $env:TEMP='C:\\Human\\Temp'; $env:TMP=$env:TEMP; $env:HOME='C:\\Human'; $env:PATH='C:\\Human\\bin'; $env:PSModulePath='C:\\Human\\Modules';
${agentEnvironmentScript()}
@{profile=$env:USERPROFILE;homeDrive=$env:HOMEDRIVE;homePath=$env:HOMEPATH;appData=$env:APPDATA;localAppData=$env:LOCALAPPDATA;temp=$env:TEMP;tmp=$env:TMP;home=$env:HOME;path=$env:PATH;modules=$env:PSModulePath;machinePath=[Environment]::GetEnvironmentVariable('Path','Machine');machineModules=[Environment]::GetEnvironmentVariable('PSModulePath','Machine');programFiles=$env:ProgramFiles;lookup=$script:lookup;sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value} | ConvertTo-Json -Compress`;
      const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true });
      expect(result.status, result.stderr).toBe(0);
      const env = JSON.parse(result.stdout) as Record<string, string | null>;
      expect(env).toMatchObject({ profile, homeDrive: profile.slice(0, 2), homePath: profile.slice(2), appData: roaming, localAppData: local, temp, tmp: temp, home: null });
      expect(env.path).toBe(`${profile}\\.local\\bin;${roaming}\\npm;${env.machinePath ?? ""}`);
      expect(env.modules).toBe(`${profile}\\Documents\\WindowsPowerShell\\Modules;${env.programFiles}\\WindowsPowerShell\\Modules;${env.machineModules ?? ""}`);
      expect(env.lookup).toBe(`HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\${env.sid}`);
      expect(existsSync(roaming)).toBe(true);
      expect(existsSync(temp)).toBe(true);
    } finally {
      for (const path of [temp, local, roaming, join(profile, "AppData"), profile, base]) if (existsSync(path)) rmdirSync(path);
    }
  });

  it("共通スクリプトは Windows PowerShell 用の UTF-8 BOM 付き", () => {
    expect([...readFileSync(new URL("./sandbox-agent-env.ps1", import.meta.url)).subarray(0, 3)]).toEqual([239, 187, 191]);
  });
});
