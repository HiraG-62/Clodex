// Spike C: node-pty + ConPTY の基本挙動を確認する
import * as pty from "node-pty";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (label: string, data: string) =>
  console.log(`--- ${label} ---\n${JSON.stringify(data).slice(0, 600)}`);

const p = pty.spawn("powershell.exe", ["-NoLogo", "-NoProfile"], {
  name: "xterm-256color",
  cols: 100,
  rows: 30,
  cwd: process.cwd(),
  env: process.env as Record<string, string>,
  useConpty: true,
});

let buf = "";
p.onData((d) => (buf += d));
const take = () => { const b = buf; buf = ""; return b; };
let exitInfo: unknown;
p.onExit((e) => (exitInfo = e));

await sleep(1500);
log("startup", take());

p.write("[Console]::OutputEncoding=[Text.Encoding]::UTF8; echo 'こんにちは 日本語'\r");
await sleep(1000);
log("japanese echo", take());

p.resize(60, 20);
p.write("$Host.UI.RawUI.WindowSize.Width\r");
await sleep(800);
log("after resize (expect 60)", take());

p.write("ping -n 30 127.0.0.1\r");
await sleep(1500);
take();
p.write("\x03");
await sleep(1000);
log("after Ctrl+C", take());
p.write("echo alive\r");
await sleep(800);
log("still alive?", take());

p.kill();
await sleep(1000);
console.log("exit:", exitInfo, "pid:", p.pid);
process.exit(0);
