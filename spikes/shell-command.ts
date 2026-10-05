// Spike H: !command をどのシェルで実行し、出力をどう decode すればよいか確認する
// - 日本語を含む PowerShell の文字列出力・native command（git）の出力・エラー出力
// - 終了コードと kill
import { spawn } from "node:child_process";

const JA = "日本語の出力";
const SCRIPT = `Write-Output '${JA}'; git log -1 --format=%s; Write-Error 'エラー出力'; exit 3`;
const UTF8_PREFIX = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; ";

const run = (label: string, file: string, args: string[], cwd: string) =>
  new Promise<void>((resolve) => {
    const started = Date.now();
    const child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("close", (code) => {
      console.log(`--- ${label} (${Date.now() - started}ms) exit=${code}`);
      console.log("stdout:", JSON.stringify(Buffer.concat(out).toString("utf8")));
      console.log("stderr:", JSON.stringify(Buffer.concat(err).toString("utf8").slice(0, 200)));
      resolve();
    });
  });

// kill: 長いコマンドを止めて子プロセスが残らないか（tree kill が要るか）
const killTest = (file: string, args: string[], cwd: string) =>
  new Promise<void>((resolve) => {
    const child = spawn(file, [...args, "ping -n 30 127.0.0.1 | Out-Null; 'done'"], { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    setTimeout(() => {
      const pid = child.pid!;
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "inherit" }).on("close", () => {
        child.on("close", (code, signal) => {
          console.log(`--- kill ${file}: exit=${code} signal=${signal}`);
          // ping が残っていないか
          spawn("powershell", ["-NoProfile", "-Command", "(Get-Process ping -ErrorAction SilentlyContinue | Measure-Object).Count"], { stdio: "inherit" })
            .on("close", () => resolve());
        });
      });
    }, 1500);
  });

const main = async () => {
  const cwd = process.argv[2] ?? process.cwd();
  const base = ["-NoProfile", "-NonInteractive", "-Command"];
  for (const shell of ["pwsh", "powershell"]) {
    await run(`${shell} default`, shell, [...base, SCRIPT], cwd);
    await run(`${shell} utf8`, shell, [...base, UTF8_PREFIX + SCRIPT], cwd);
  }
  await killTest("pwsh", base, cwd);
};

void main();
