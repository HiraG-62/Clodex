// ConPTY の中で動く子: raw mode の後に別プロセスで 標準入力（コンソール）に ENABLE_VIRTUAL_TERMINAL_INPUT を足し、stdin に届いたものを出す
import { execFileSync } from "node:child_process";
process.stdout.write("\x1b[?1000h\x1b[?1006h");
process.stdin.setRawMode(true);
const ps = `
Add-Type -Namespace W -Name K -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(System.IntPtr h, out uint m);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(System.IntPtr h, uint m);
'@
$h = [W.K]::GetStdHandle(-10)
$m = 0; [void][W.K]::GetConsoleMode($h, [ref]$m)
[void][W.K]::SetConsoleMode($h, $m -bor 0x200)
$n = 0; [void][W.K]::GetConsoleMode($h, [ref]$n)
"before=$m after=$n"`;
const r = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: ["inherit", "pipe", "pipe"] });
process.stdout.write(`PS ${String(r).trim()}\r\n`);
process.stdin.on("data", (d) => {
  process.stdout.write(`GOT ${JSON.stringify(String(d))}\r\n`);
  if (String(d).includes("q")) { process.stdout.write("\x1b[?1006l\x1b[?1000l"); process.exit(0); }
});
process.stdout.write("READY\r\n");
