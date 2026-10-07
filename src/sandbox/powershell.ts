import { spawn } from "node:child_process";
import { join } from "node:path";
import { subscriptionEnv } from "../agents/agent-process.js";

export const POWERSHELL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
export const CMD = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
export const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
export const psArgs = (script: string): string[] => ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $env:PSModulePath="$env:ProgramFiles\\WindowsPowerShell\\Modules;$PSHOME\\Modules"; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${script}`, "utf16le").toString("base64")];

export async function runHost(script: string, input?: string): Promise<string> {
  const child = spawn(POWERSHELL, psArgs(script), { windowsHide: true, env: subscriptionEnv(process.env), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
  child.stderr.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  return await new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => { if (code === 0) resolve(stdout.trim()); else reject(new Error(`PowerShell (${code}): ${stderr.trim()}`)); });
  });
}
