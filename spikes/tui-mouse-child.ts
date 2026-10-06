// ConPTY の中で動く子: 実際の startTui を、番号付きのターンを 30 件流す fake の feed で起動する
import { startTui } from "../src/tui/tui.js";
import type { FeedClient } from "../src/tui/feed-client.js";

const TURNS = 30;
const client: FeedClient = {
  connect: async (onItem) => {
    let seq = 0;
    for (let i = 1; i <= TURNS; i++) {
      const at = new Date().toISOString();
      onItem({ type: "event", seq: ++seq, event: { kind: "agent", agent: "claude", at, event: { type: "turn_started" } } });
      onItem({ type: "event", seq: ++seq, event: { kind: "agent", agent: "claude", at, event: { type: "turn", result: { status: "completed", text: `TURN-${i}` } } } });
    }
    return () => {};
  },
  send: async () => {}, files: async () => [],
};
// TUI_DEBUG があれば、Ink が stdin から読んだ内容をそのファイルへ書く
import { appendFileSync } from "node:fs";
const debugFile = process.env.TUI_DEBUG;
if (debugFile) {
  const read = process.stdin.read.bind(process.stdin);
  process.stdin.read = ((size?: number) => { const chunk = read(size); if (chunk !== null) appendFileSync(debugFile, `${JSON.stringify(String(chunk))}
`); return chunk; }) as typeof process.stdin.read;
}
await startTui(client);
process.exit(0);
