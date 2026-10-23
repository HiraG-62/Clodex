import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROXY_NAME = "agy-mcp-proxy.cjs";
const ALLOW_RULE = "mcp(clodex/*)";

export const proxySource = `const { createInterface } = require("node:readline");
const input = createInterface({ input: process.stdin });
let session;
async function forward(line) {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  try {
    const response = await fetch(process.env.CLODEX_MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify(request),
    });
    if (response.headers.has("mcp-session-id")) session = response.headers.get("mcp-session-id");
    if (!response.ok) throw new Error("MCP HTTP " + response.status);
    if (response.status === 202 || request.id === undefined) return;
    const body = await response.text();
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      for (const chunk of body.split(/\\r?\\n\\r?\\n/)) {
        const data = chunk.split(/\\r?\\n/).filter(row => row.startsWith("data:")).map(row => row.slice(5).trim()).join("\\n");
        if (data) process.stdout.write(JSON.stringify(JSON.parse(data)) + "\\n");
      }
    } else process.stdout.write(JSON.stringify(JSON.parse(body)) + "\\n");
  } catch (error) {
    if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: String(error) } }) + "\\n");
  }
}
let queue = Promise.resolve();
input.on("line", line => { queue = queue.then(() => forward(line)); });
`;

const readObject = (path: string): Record<string, unknown> => {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`Invalid JSON object: ${path}`);
  return parsed as Record<string, unknown>;
};
const objectAt = (parent: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = parent[key];
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
};
const save = (path: string, value: Record<string, unknown>): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

export const ensureAgyMcpConfig = (homeDir: string): string => {
  const proxyPath = join(homeDir, ".clodex", PROXY_NAME);
  mkdirSync(join(homeDir, ".clodex"), { recursive: true });
  writeFileSync(proxyPath, proxySource);

  const mcpPath = join(homeDir, ".gemini", "config", "mcp_config.json");
  const mcp = readObject(mcpPath);
  const servers = objectAt(mcp, "mcpServers");
  if (servers.clodex === undefined) {
    servers.clodex = { command: "node", args: [proxyPath] };
    save(mcpPath, mcp);
  }

  const settingsPath = join(homeDir, ".gemini", "antigravity-cli", "settings.json");
  const settings = readObject(settingsPath);
  const permissions = objectAt(settings, "permissions");
  const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
  if (!allow.includes(ALLOW_RULE)) {
    permissions.allow = [...allow, ALLOW_RULE];
    save(settingsPath, settings);
  }
  return proxyPath;
};
