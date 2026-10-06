// Spike: ConPTY の出力に、子が出したマウスの設定（?1000h / ?1006h）が端末向けに出てくるかを見る。引数は子のスクリプト
import pty from "node-pty";
const child = pty.spawn(process.execPath, [process.argv[2] ?? "spikes/mouse-child.mjs"], { cols: 80, rows: 24, cwd: process.cwd() });
let out = "";
child.onData((d) => { out += d; });
await new Promise((r) => setTimeout(r, 8000));
console.log("単純な子が出したモード:", [...new Set(out.match(/\x1b\[\?[0-9;]+[hl]/g) ?? [])].join(" "));
child.write("q"); await new Promise((r) => setTimeout(r, 500)); child.kill(); process.exit(0);
