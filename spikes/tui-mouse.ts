// Spike: 実際の TUI を ConPTY で動かし、ホイール・PageUp で表示が変わるかを見る
import pty from "node-pty";

const child = pty.spawn(process.execPath, ["--import", "tsx", "spikes/tui-mouse-child.ts"], { cols: 80, rows: 24, cwd: process.cwd() });
let out = "";
child.onData((d) => { out += d; });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const turns = (s: string) => [...new Set([...s.matchAll(/TURN-(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
const step = async (name: string, seq: string) => {
  out = ""; child.write(seq); await sleep(1500);
  console.log(name, JSON.stringify(seq), "→ 描き直した TURN:", turns(out).join(","), "| 出力", out.length, "bytes");
  console.log("  画面に出たマウスのシーケンスの断片:", JSON.stringify(out.match(/.{0,8}64;10;5M?.{0,8}/g)));
  console.log("  出したモード:", [...new Set(out.match(/\x1b\[\?[0-9;]+[hl]/g) ?? [])].join(" "));
};
await sleep(8000);
console.log("起動直後の TURN:", turns(out).join(","));
console.log("起動直後に TUI が出したモード:", [...new Set(out.match(/\x1b\[\?[0-9;]+[hl]/g) ?? [])].join(" "));
await step("ホイール上 x1", "\x1b[<64;10;5M");
await step("ホイール上 x5", "\x1b[<64;10;5M".repeat(5));
await step("PageUp", "\x1b[5~");
await step("Ctrl+End", "\x1b[1;5F");
child.write("\x04"); await sleep(1000);
child.kill();
process.exit(0);
