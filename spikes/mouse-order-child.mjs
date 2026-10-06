// ConPTY の中で動く子: VT 入力モードを足してからマウスの設定を出す（順序を逆にすると ConPTY は設定を端末へ渡さない）
import { execFileSync } from "node:child_process";
process.stdin.setRawMode(true);
const ps = `Add-Type -Namespace W -Name K -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(System.IntPtr h, out uint m);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(System.IntPtr h, uint m);
'@
$h = [W.K]::GetStdHandle(-10); $m = 0; [void][W.K]::GetConsoleMode($h, [ref]$m); [void][W.K]::SetConsoleMode($h, $m -bor 0x200)`;
execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: ["inherit", "ignore", "ignore"] });
process.stdout.write("AFTER-VT\r\n");
process.stdout.write("\x1b[?1000h\x1b[?1006h");
process.stdout.write("MOUSE-ON\r\n");
process.stdin.on("data", (d) => { if (String(d).includes("q")) process.exit(0); });
