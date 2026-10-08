import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../coordinator/coordinator.js";
import { EventBus } from "../coordinator/event-bus.js";
import { FakeAgentAdapter } from "../agents/fake-agent-adapter.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentId } from "../agents/agent-adapter.js";
import type { CreateMessageResult } from "../protocol/messages.js";
import { startMcpServer, type McpServerHandle } from "./server.js";

let server: McpServerHandle | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const connect = async (url: string) => {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
};

const accepted: CreateMessageResult = {
  ok: true,
  message: {
    id: "msg_00000001", from: "claude", to: "codex", type: "QUESTION", taskId: "T-1", body: "?",
    repository: "C:\\dev\\app", createdAt: "2026-10-05T07:00:00.000Z",
  },
};
const readConversation = () => ({ entries: [] });

describe("startMcpServer", () => {
  it("send_message を公開し、URL の agentId を送信元として handler に渡す", async () => {
    const calls: Array<{ from: AgentId; input: unknown }> = [];
    server = await startMcpServer({ readConversation, askUser: () => ({ ok: true, id: "q1" }), sendMessage: (from, input) => {
      calls.push({ from, input });
      return accepted;
    } });
    expect(server.urlFor("claude")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{32}$/);
    expect(server.urlFor("claude")).not.toBe(server.urlFor("codex"));

    const client = await connect(server.urlFor("claude"));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["send_message", "ask_user", "read_conversation"]);

    const result = await client.callTool({
      name: "send_message", arguments: { to: "codex", type: "QUESTION", taskId: "T-1", body: "?" },
    });
    expect(calls).toEqual([{ from: "claude", input: { to: "codex", type: "QUESTION", taskId: "T-1", body: "?" } }]);
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("msg_00000001");
    await client.close();
  });

  it("handler が拒否したらエラー文を tool エラーとして返す", async () => {
    server = await startMcpServer({ readConversation, askUser: () => ({ ok: true, id: "q1" }), sendMessage: () => ({ ok: false, error: "replyTo: required for RESULT" }) });
    const client = await connect(server.urlFor("codex"));
    const result = await client.callTool({
      name: "send_message", arguments: { to: "claude", type: "RESULT", taskId: "T-1", body: "x" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("replyTo: required for RESULT");
    await client.close();
  });

  it("Codex の URL からの送信は codex として扱う（URL で送信元が決まる）", async () => {
    const froms: AgentId[] = [];
    server = await startMcpServer({ readConversation, askUser: () => ({ ok: true, id: "q1" }), sendMessage: (from) => {
      froms.push(from);
      return accepted;
    } });
    const client = await connect(server.urlFor("codex"));
    await client.callTool({ name: "send_message", arguments: { to: "claude", type: "QUESTION", taskId: "T-1", body: "?" } });
    expect(froms).toEqual(["codex"]);
    await client.close();
  });

  it("token が違う、または token の後ろに path を足した URL は 404", async () => {
    server = await startMcpServer({ readConversation, sendMessage: () => accepted, askUser: () => ({ ok: true, id: "q1" }) });
    const port = new URL(server.urlFor("claude")).port;
    const post = (path: string) => fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect((await post("/mcp/wrong-token/claude")).status).toBe(404);
    expect((await post(`${new URL(server.urlFor("codex")).pathname}/claude`)).status).toBe(404);
  });
});

it("spec を公開・配送し、存在しない設計書は tool エラーにする", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "clodex-mcp-spec-"));
  writeFileSync(join(projectRoot, "design.md"), "設計");
  const coordinator = new Coordinator({
    projectRoot, bus: new EventBus(), mcpUrlFor: () => "http://localhost/mcp",
    agents: { claude: new FakeAgentAdapter("claude"), codex: new FakeAgentAdapter("codex") },
  });
  server = await startMcpServer({ readConversation, sendMessage: (from, input) => coordinator.receiveMessage(from, input), askUser: (from, input) => coordinator.askUser(from, input) });
  const client = await connect(server.urlFor("claude"));
  try {
    const listed = await client.listTools();
    expect(listed.tools[0]?.inputSchema.properties).toHaveProperty("spec");
    for (const [spec, rejected] of [["design.md", false], ["missing.md", true]] as const) {
      const result = await client.callTool({
        name: "send_message", arguments: { to: "codex", type: "DELEGATE", taskId: "T", body: "実装", spec },
      });
      expect(Boolean(result.isError)).toBe(rejected);
      if (rejected) expect(JSON.stringify(result.content)).toContain("spec:");
    }
  } finally {
    await client.close();
  }
});

it("ask_user は URL の Agent を使い、回答を待たずに ID を返す", async () => {
  const askUser = vi.fn(() => ({ ok: true as const, id: "q1" }));
  server = await startMcpServer({ readConversation, sendMessage: () => accepted, askUser });
  for (const agent of ["claude", "codex"] as const) {
    const client = await connect(server.urlFor(agent));
    const questions = [{ question: "方針は", options: [{ label: "A" }, { label: "B" }] }];
    try {
      const result = await client.callTool({ name: "ask_user", arguments: { questions, from: "偽装" } });
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result.content)).toContain("Question q1 is shown to the human. End your turn now; the answer will arrive as a new message.");
      expect(askUser).toHaveBeenLastCalledWith(agent, { questions });
      for (const invalid of [[], Array(5).fill(questions[0]), [{ question: "", options: questions[0]!.options }], [{ question: "方針", options: [{ label: "A" }] }], [{ question: "方針", options: Array(7).fill({ label: "A" }) }]]) {
        expect((await client.callTool({ name: "ask_user", arguments: { questions: invalid } })).isError).toBe(true);
      }
    } finally { await client.close(); }
  }
  expect(askUser).toHaveBeenCalledTimes(2);
});

it("ask_user handler の拒否を tool エラーにする", async () => {
  server = await startMcpServer({ readConversation, sendMessage: () => accepted, askUser: () => ({ ok: false, error: "invalid question" }) });
  const client = await connect(server.urlFor("claude"));
  try {
    const result = await client.callTool({ name: "ask_user", arguments: { questions: [{ question: "方針", options: [{ label: "A" }, { label: "B" }] }] } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("invalid question");
  } finally { await client.close(); }
});

it("read_conversation は同じ会話の本文を Agent ごとの URL から取得できる", async () => {
  const calls: Array<{ from: AgentId; before?: number; limit?: number }> = [];
  server = await startMcpServer({
    sendMessage: () => accepted,
    askUser: () => ({ ok: true, id: "q1" }),
    readConversation: (from, options) => {
      calls.push({ from, ...options });
      return { entries: [{ at: "2026-10-08T00:00:00.000Z", kind: "input", from: "human", to: "claude", body: "依頼本文" }] };
    },
  });
  const client = await connect(server.urlFor("codex"));
  try {
    const result = await client.callTool({ name: "read_conversation", arguments: { before: 3, limit: 2 } });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("依頼本文");
    expect(calls).toEqual([{ from: "codex", before: 3, limit: 2 }]);
    expect((await client.callTool({ name: "read_conversation", arguments: { limit: 101 } })).isError).toBe(true);
    expect(calls).toHaveLength(1);
  } finally { await client.close(); }
});
