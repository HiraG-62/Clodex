import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { startMcpServer } from "../mcp/server.js";
import { ensureAgyMcpConfig } from "./agy-mcp-config.js";

it("空の設定ファイルは欠損と同じに扱い、壊れた JSON は path 入りで失敗する", () => {
  const home = mkdtempSync(join(tmpdir(), "clodex-agy-mcp-"));
  const mcpPath = join(home, ".gemini", "config", "mcp_config.json");
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  writeFileSync(mcpPath, "");
  ensureAgyMcpConfig(home);
  expect(JSON.parse(readFileSync(mcpPath, "utf8"))).toHaveProperty("mcpServers.clodex");
  writeFileSync(mcpPath, "{broken");
  expect(() => ensureAgyMcpConfig(home)).toThrowError(mcpPath);
});

it("設定を保ちながら proxy を書き、実 MCP server と往復する", async () => {
  const home = mkdtempSync(join(tmpdir(), "clodex-agy-mcp-"));
  const settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
  const proxyPath = ensureAgyMcpConfig(home);
  writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["command(git)"] }, other: true }));
  ensureAgyMcpConfig(home);
  expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ permissions: { allow: ["command(git)", "mcp(clodex/*)"] }, other: true });
  const server = await startMcpServer({
    sendMessage: () => ({ ok: false, error: "テスト拒否" }),
    askUser: () => ({ ok: false, error: "テスト拒否" }),
    readConversation: () => ({ entries: [] }),
  });
  const child = spawn(process.execPath, [proxyPath], { env: { ...process.env, CLODEX_MCP_URL: server.urlFor("gemini") }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const waiting = new Map<number, (value: Record<string, unknown>) => void>();
  lines.on("line", line => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const id = message.id;
    if (typeof id === "number") waiting.get(id)?.(message);
  });
  const call = (id: number, method: string, params: unknown) =>
    new Promise<Record<string, unknown>>(resolve => {
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    expect((await call(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } })).result).toBeDefined();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const listed = await call(2, "tools/list", {});
    expect(JSON.stringify(listed.result)).toContain("send_message");
    const rejected = await call(3, "tools/call", { name: "send_message", arguments: { to: "claude", type: "QUESTION", taskId: "T", body: "test" } });
    expect(JSON.stringify(rejected.result)).toContain("テスト拒否");
  } finally {
    child.kill();
    await server.close();
  }
});
