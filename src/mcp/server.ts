// Agent → Coordinator の formal action interface（DESIGN.md §12）
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AGENT_IDS, COORDINATOR_MCP_SERVER, SEND_MESSAGE_TOOL, ASK_USER_TOOL, type AgentId } from "../agents/agent-adapter.js";
import { askUserShape, type AskUserResult } from "../protocol/questions.js";
import { sendMessageShape, type CreateMessageResult } from "../protocol/messages.js";

const HOST = "127.0.0.1";
const TOKEN_BYTES = 16;
const HTTP_NOT_FOUND = 404;
const SERVER_VERSION = "0.0.0";
const TOKEN_PATH = /^\/mcp\/([0-9a-f]+)$/;

const TOOL_DESCRIPTION =
  "Send a formal message to the other agent through the Clodex coordinator. " +
  "The reply, if any, arrives as a new message after your current turn ends. " +
  "Set interrupt only to correct work the recipient is doing for you.";

export type SendMessageHandler = (from: AgentId, input: unknown) => CreateMessageResult;

export interface McpHandlers {
  sendMessage: SendMessageHandler;
  askUser(from: AgentId, input: unknown): AskUserResult;
}

export interface McpServerHandle {
  urlFor(agent: AgentId): string;
  close(): Promise<void>;
}

const acceptedText = ({ id, to }: { id: string; to: AgentId }) =>
  `Message ${id} accepted for ${to}. Do not wait or poll; the reply, if any, will arrive as a new message after your current turn ends.`;

const buildMcpServer = (from: AgentId, handler: McpHandlers): McpServer => {
  const server = new McpServer({ name: COORDINATOR_MCP_SERVER, version: SERVER_VERSION });
  server.registerTool(
    SEND_MESSAGE_TOOL,
    { description: TOOL_DESCRIPTION, inputSchema: sendMessageShape },
    async (args) => {
      const result = handler.sendMessage(from, args);
      return result.ok
        ? { content: [{ type: "text", text: acceptedText(result.message) }] }
        : { content: [{ type: "text", text: `Rejected: ${result.error}` }], isError: true };
    },
  );
  server.registerTool(ASK_USER_TOOL, {
    description: "Ask the human for a decision. The question is shown immediately. End your turn after calling this tool; the answer will arrive as a new message. Do not wait or poll.",
    inputSchema: askUserShape,
  }, async (args) => {
    const result = handler.askUser(from, args);
    return result.ok
      ? { content: [{ type: "text", text: `Question ${result.id} is shown to the human. End your turn now; the answer will arrive as a new message.` }] }
      : { content: [{ type: "text", text: `Rejected: ${result.error}` }], isError: true };
  });
  return server;
};

export const startMcpServer = async (handler: McpHandlers): Promise<McpServerHandle> => {
  // 送信元を偽れないよう、起動ごと・Agent ごとのランダム token で送信元を決める（DESIGN.md §12）
  const tokenOf = Object.fromEntries(AGENT_IDS.map((id) => [id, randomBytes(TOKEN_BYTES).toString("hex")])) as Record<AgentId, string>;
  const agentOf = new Map(AGENT_IDS.map((id) => [tokenOf[id], id]));

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const token = new URL(req.url ?? "/", `http://${HOST}`).pathname.match(TOKEN_PATH)?.[1];
    const from = token === undefined ? undefined : agentOf.get(token);
    if (!from) {
      res.writeHead(HTTP_NOT_FOUND).end();
      return;
    }
    // stateless: リクエストごとに server と transport を作る
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void transport.close());
    await buildMcpServer(from, handler).connect(transport);
    await transport.handleRequest(req, res);
  };

  const http = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => http.listen(0, HOST, resolve));
  const origin = `http://${HOST}:${(http.address() as AddressInfo).port}`;

  return {
    urlFor: (agent) => `${origin}/mcp/${tokenOf[agent]}`,
    close: () => new Promise<void>((resolve) => {
      http.closeAllConnections();
      http.close(() => resolve());
    }),
  };
};
