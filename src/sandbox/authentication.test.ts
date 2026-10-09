import { expect, it, vi } from "vitest";
import { createFakeSpawner } from "../agents/fake-agent-process.js";
import { inspectSandboxAuthentication } from "./authentication.js";

it.each([
  [true, "claude.ai", "chatgpt", true, true],
  [false, "none", undefined, false, false],
  [true, "api_key", "apiKey", false, false],
  [true, "unknown", "chatgpt", false, true],
])("サブスクリプション認証のみ合格にする: %s / %s / %s", async (loggedIn, authMethod, type, claude, codex) => {
  const spawner = createFakeSpawner(message => (message.method === "initialize" ? {} : { account: type ? { type } : null }));
  const run = vi.fn(async () => JSON.stringify({ loggedIn, authMethod }));
  expect(await inspectSandboxAuthentication({ run, spawn: spawner.spawn }, "profile")).toEqual({ claude, codex });
  expect(run).toHaveBeenCalledWith("claude", ["auth", "status", "--json"], "profile");
  expect(spawner.calls[0]?.args).toEqual(["app-server"]);
  expect(spawner.last.written.map(message => message.method)).toEqual(["initialize", "initialized", "account/read"]);
  expect(spawner.last.killed).toBe(true);
});

it("CLI の失敗・不正な応答・タイムアウトでは合格にしない", async () => {
  for (const run of [
    vi.fn(async () => {
      throw new Error("exit 1");
    }),
    vi.fn(async () => "invalid"),
  ]) {
    const spawner = createFakeSpawner();
    expect(await inspectSandboxAuthentication({ run, spawn: spawner.spawn }, "profile", 1)).toEqual({ claude: false, codex: false });
    expect(spawner.last.killed).toBe(true);
  }
  const spawner = createFakeSpawner(undefined, { spawnError: new Error("missing") });
  expect(await inspectSandboxAuthentication({ run: async () => "{}", spawn: spawner.spawn }, "profile")).toEqual({ claude: false, codex: false });
});
