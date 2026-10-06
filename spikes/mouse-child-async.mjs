// ConPTY の中で動く子: 実装と同じく spawn（非同期）で PowerShell を起動して VT 入力モードを足す。引数 hide で windowsHide: true
import { spawn } from "node:child_process";
const hide = process.argv[2] === "hide";
process.stdout.write("\x1b[?1000h\x1b[?1006h");
process.stdin.setRawMode(true);
const ps = `
Add-Type -Namespace W -Name K -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(System.IntPtr h, out uint m);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(System.IntPtr h, uint m);
'@
$h = [W.K]::GetStdHandle(-10)
$m = 0
if (-not [W.K]::GetConsoleMode($h, [ref]$m)) { exit 1 }
if (-not [W.K]::SetConsoleMode($h, $m -bor 0x200)) { exit 2 }
`;
const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: ["inherit", "ignore", "ignore"], windowsHide: hide });
child.once("close", (code) => process.stdout.write(`PS exit=${code} hide=${hide}\r\n`));
process.stdin.on("data", (d) => {
  process.stdout.write(`GOT ${JSON.stringify(String(d))}\r\n`);
  if (String(d).includes("q")) { process.stdout.write("\x1b[?1006l\x1b[?1000l"); process.exit(0); }
});
