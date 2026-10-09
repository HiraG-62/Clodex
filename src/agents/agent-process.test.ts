import { describe, expect, it } from "vitest";
import { agentEnv, spawnAgentProcess, subscriptionEnv } from "./agent-process.js";

describe("subscriptionEnv", () => {
  it("API key 系の環境変数を大文字小文字を問わず取り除き、他は残す", () => {
    const env = subscriptionEnv({
      ANTHROPIC_API_KEY: "a",
      anthropic_auth_token: "b",
      OPENAI_API_KEY: "c",
      Codex_Api_Key: "d",
      PATH: "p",
      USERPROFILE: "u",
    });
    expect(env).toEqual({ PATH: "p", USERPROFILE: "u" });
  });
});

describe("agentEnv", () => {
  it("API key を除き、CLODEX_AGENT を設定する", () => {
    expect(agentEnv({ ANTHROPIC_API_KEY: "a", PATH: "p", CLODEX_AGENT: "stale" }, "codex")).toEqual({ PATH: "p", CLODEX_AGENT: "codex" });
  });
});

describe("spawnAgentProcess", () => {
  it("stdout の最後の行を読んでから onExit を呼ぶ", async () => {
    // 改行のない最後の行は stdout の close 時に届く
    const proc = spawnAgentProcess(process.execPath, ["-e", 'process.stdout.write("last line")'], { cwd: process.cwd(), env: process.env });
    const order: string[] = [];
    proc.onLine(line => order.push(line));
    const exited = new Promise<void>(resolve =>
      proc.onExit(() => {
        order.push("exit");
        resolve();
      }),
    );
    await proc.spawned;
    await exited;
    expect(order).toEqual(["last line", "exit"]);
  });

  it("spawn 失敗時に onExit を 1 回だけ呼ぶ", async () => {
    const proc = spawnAgentProcess("clodex-command-that-does-not-exist", [], { cwd: process.cwd(), env: process.env });
    const codes: Array<number | null> = [];
    const exited = new Promise<void>(resolve =>
      proc.onExit(code => {
        codes.push(code);
        resolve();
      }),
    );
    await expect(proc.spawned).rejects.toThrow();
    await exited;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(codes).toEqual([null]);
  });
});
