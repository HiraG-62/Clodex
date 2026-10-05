// Spike E: API key 環境変数があるとき Codex app-server の認証方式がどうなるか確認する
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const c = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });
createInterface({ input: c.stdout }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.id !== 2) return;
  console.log("codex account:", JSON.stringify(m.result.account), "requiresOpenaiAuth:", m.result.requiresOpenaiAuth);
  c.kill();
  process.exit(0);
});
const w = (o: unknown) => c.stdin.write(JSON.stringify(o) + "\n");
w({ id: 1, method: "initialize", params: { clientInfo: { name: "x", title: null, version: "0" }, capabilities: null } });
w({ method: "initialized" });
w({ id: 2, method: "account/read", params: {} });
