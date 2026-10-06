// Spike: VT 入力モードの有無で、ConPTY 経由のキー入力の届き方が変わらないかを比べる
import pty from "node-pty";

// 引数: 子のスクリプトと、入力を送り始めるまでの待ち時間（ms）
const childScript = process.argv[2] ?? "spikes/mouse-child.mjs";
const waitMs = Number(process.argv[3] ?? 1500);
const KEYS: Array<[string, string]> = [["上", "\x1b[A"], ["左", "\x1b[D"], ["Enter", "\r"], ["Backspace", "\x7f"], ["Ctrl+C", "\x03"],
  ["Ctrl+J", "\n"], ["Ctrl+O", "\x0f"], ["Ctrl+D", "\x04"], ["日本語", "あいう"], ["Ctrl+End", "\x1b[1;5F"], ["PageDown", "\x1b[6~"]];
const child = pty.spawn(process.execPath, [childScript], { cols: 80, rows: 24, cwd: process.cwd() });
let out = "";
child.onData((d) => { out += d; });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await sleep(waitMs);
for (const [, seq] of KEYS) { child.write(seq); await sleep(300); }
child.write("q"); await sleep(800);
console.log(KEYS.map(([name]) => name).join(" / "));
console.log(out.split(/\r?\n/).filter((l) => l.includes("GOT") || l.includes("PS ")).map((l) => l.replace(/^.*?(GOT|PS )/, "$1")).join("\n"));
child.kill();
process.exit(0);
