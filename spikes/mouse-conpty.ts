// Spike: ConPTY 経由で Windows の Node の stdin にマウスのホイールが届くかを確かめる
import pty from "node-pty";

// 引数: 子のスクリプト（既定は spikes/mouse-child.mjs）と、入力を送り始めるまでの待ち時間（ms）
const childScript = process.argv[2] ?? "spikes/mouse-child.mjs";
const waitMs = Number(process.argv[3] ?? 1500);
const child = pty.spawn(process.execPath, [childScript], { cols: 80, rows: 24, cwd: process.cwd() });
let out = "";
child.onData((d) => { out += d; });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await sleep(waitMs);
child.write("\x1b[<64;10;5M"); await sleep(400);  // ホイール上
child.write("\x1b[<65;10;5M"); await sleep(400);  // ホイール下
child.write("\x1b[5~"); await sleep(400);          // PageUp
child.write("q"); await sleep(800);
console.log(JSON.stringify(out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")).slice(0, 1500));
child.kill();
process.exit(0);
