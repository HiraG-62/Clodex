// sandbox の中で codex app-server の initialize → account/read を送り、返った行をそのまま表示する
import { homedir } from "node:os";
import { agentEnv } from "../src/agents/agent-process.js";
import { WindowsSandboxPlatform } from "../src/sandbox/windows-platform.js";

const WAIT_MS = 15_000;
const project = process.argv[2] ?? "E:\\dev\\clodex-hybrid-test";
const platform = new WindowsSandboxPlatform(homedir(), project);
try {
  if (!await platform.inspect()) throw new Error("セットアップ未完了");
  await platform.connect(false);
  const broker = platform["broker"];
  const profile = platform["identity"]?.profile;
  if (!broker || !profile) throw new Error("broker 未接続");
  const proc = broker.spawn("codex", ["app-server"], { cwd: profile, env: agentEnv({}, "codex") });
  proc.onLine((line) => {
    console.log("LINE:", line.slice(0, 600));
    if (line.includes("\"id\":1")) {
      proc.write(JSON.stringify({ method: "initialized" }));
      proc.write(JSON.stringify({ id: 2, method: "account/read", params: {} }));
    }
  });
  proc.onExit((code) => console.log("EXIT:", code));
  await proc.spawned;
  proc.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "clodex", title: "Clodex", version: "0.0.0" }, capabilities: null } }));
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  proc.kill();
} catch (error) {
  process.exitCode = 1;
  console.log(error instanceof Error ? error.message : error);
} finally {
  await platform.close();
}
