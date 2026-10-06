// Spike: Ink 8 の useInput に SGR マウスのシーケンスが届くかを見る（届かない: App.js が名前の無い制御シーケンスを捨てる）
import React from "react";
import { useInput, Text } from "ink";
import { render } from "ink-testing-library";
import { parseSgrMouse } from "../src/tui/terminal-layout.js";
const Probe = () => { useInput((k, key) => console.log(JSON.stringify(k), parseSgrMouse(k), JSON.stringify(Object.fromEntries(Object.entries(key).filter(([, v]) => v))))); return React.createElement(Text, null, "x"); };
const app = render(React.createElement(Probe));
await new Promise((r) => setTimeout(r, 50));
app.stdin.write("\x1b[<64;10;5M");
await new Promise((r) => setTimeout(r, 50));
process.exit(0);
