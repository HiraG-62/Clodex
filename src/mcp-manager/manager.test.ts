import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveMcpServers } from "../config/config.js";
import { McpManager } from "./manager.js";

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "clodex-mcp-manager-"));
  const homeDir = join(root, "home");
  const projectRoot = join(root, "project");
  mkdirSync(join(homeDir, ".clodex"), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  return { homeDir, projectRoot };
};
const server = { transport: "stdio" as const, command: "node", args: ["server.js"], enabled: true, agents: { claude: true, gemini: true } };
const options = { run: () => ({ status: 0, stdout: "[]", stderr: "" }) };

describe("McpManager", () => {
  it("追加と削除で外部管理と clodex proxy を保持し、バックアップを作る", () => {
    const paths = setup();
    saveMcpServers(paths, "user", { mine: server });
    const agyPath = join(paths.homeDir, ".gemini", "config", "mcp_config.json");
    mkdirSync(join(agyPath, ".."), { recursive: true });
    writeFileSync(agyPath, JSON.stringify({ other: 1, mcpServers: { clodex: { command: "proxy" }, external: { command: "echo" } } }));
    const manager = new McpManager(paths, options);
    const plan = manager.plan();
    expect(plan.actions.filter(action => action.name === "mine").map(action => action.agent)).toEqual(["claude", "gemini"]);
    expect(manager.apply(plan).errors).toEqual([]);
    expect(JSON.parse(readFileSync(agyPath, "utf8")).mcpServers).toMatchObject({
      clodex: { command: "proxy" },
      external: { command: "echo" },
      mine: { command: "node" },
    });
    expect(readFileSync(`${agyPath}.clodex-bak`, "utf8")).toContain("external");
    saveMcpServers(paths, "user", {});
    expect(manager.apply(manager.plan()).errors).toEqual([]);
    expect(JSON.parse(readFileSync(agyPath, "utf8")).mcpServers).toEqual({ clodex: { command: "proxy" }, external: { command: "echo" } });
  });

  it("プレビュー後の外部変更を検出して書き込まない", () => {
    const paths = setup();
    saveMcpServers(paths, "user", { mine: server });
    const manager = new McpManager(paths, options);
    const plan = manager.plan();
    const target = join(paths.homeDir, ".claude.json");
    writeFileSync(target, JSON.stringify({ mcpServers: { external: { command: "echo" } } }));
    expect(manager.apply(plan).errors.length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(target, "utf8")).mcpServers).toEqual({ external: { command: "echo" } });
  });

  it("CLI 設定の破損を plan のエラーとして返す", () => {
    const paths = setup();
    writeFileSync(join(paths.homeDir, ".claude.json"), "{ broken");
    const plan = new McpManager(paths, options).plan();
    expect(plan.errors.join(" ")).toMatch(/\.claude\.json: invalid JSON/);
    expect(plan.actions).toEqual([]);
  });

  it("Claude の user から project への移動は旧登録を削除して新規登録する", () => {
    const paths = setup();
    saveMcpServers(paths, "user", { mine: { ...server, agents: { claude: true } } });
    const manager = new McpManager(paths, options);
    expect(manager.apply(manager.plan()).errors).toEqual([]);
    saveMcpServers(paths, "user", {});
    saveMcpServers(paths, "project", { mine: { ...server, agents: { claude: true } } });
    const plan = manager.plan();
    expect(plan.actions.map(action => [action.kind, action.scope])).toEqual([
      ["remove", "user"],
      ["add", "project"],
    ]);
    expect(manager.apply(plan).errors).toEqual([]);
    expect(JSON.parse(readFileSync(join(paths.homeDir, ".claude.json"), "utf8")).mcpServers).toEqual({});
    expect(JSON.parse(readFileSync(join(paths.projectRoot, ".mcp.json"), "utf8")).mcpServers.mine.command).toBe("node");
  });

  it("envRefs と project scope が未対応なら警告を返し、書かない", () => {
    const paths = setup();
    saveMcpServers(paths, "project", { scoped: { ...server, agents: { codex: true, gemini: true } } });
    saveMcpServers(paths, "user", { secret: { ...server, envRefs: { TOKEN: "MY_TOKEN" } } });
    const plan = new McpManager(paths, options).plan();
    expect(plan.entries.filter(entry => entry.status === "unsupported").map(entry => entry.name)).toEqual(["scoped", "scoped", "secret", "secret"]);
    expect(plan.actions).toEqual([]);
  });

  it("Codex の変更を一時コピーで作り、コメントと未知のキーを残す", () => {
    const paths = setup();
    const codexPath = join(paths.homeDir, ".codex", "config.toml");
    mkdirSync(join(codexPath, ".."), { recursive: true });
    const original = '# note\nmodel = "gpt-6"\n[custom]\nkey = "keep"\n';
    writeFileSync(codexPath, original);
    saveMcpServers(paths, "user", { mine: { ...server, agents: { codex: true } } });
    const run = (_command: string, args: string[], env: NodeJS.ProcessEnv) => {
      if (args[1] === "list") return { status: 0, stdout: "[]", stderr: "" };
      const path = join(env.CODEX_HOME!, "config.toml");
      writeFileSync(path, `${readFileSync(path, "utf8")}\n[mcp_servers.mine]\ncommand = "node"\nargs = ["server.js"]\n`);
      return { status: 0, stdout: "", stderr: "" };
    };
    const manager = new McpManager(paths, { run });
    expect(manager.apply(manager.plan()).errors).toEqual([]);
    expect(readFileSync(codexPath, "utf8")).toContain("[mcp_servers.mine]");
    expect(readFileSync(`${codexPath}.clodex-bak`, "utf8")).toBe(original);
  });

  it("CLI アダプターの read / plan / apply は対象 CLI だけを扱う", () => {
    const paths = setup();
    const manager = new McpManager(paths, options);
    const adapter = manager.adapter("claude");
    expect(adapter.read()).toEqual({ user: {}, project: {} });
    const plan = adapter.plan({ mine: { scope: "user", server } });
    expect(plan.actions.map(action => action.agent)).toEqual(["claude"]);
    expect(adapter.apply(plan).errors).toEqual([]);
    expect(adapter.read().user.mine?.command).toBe("node");
  });
});
