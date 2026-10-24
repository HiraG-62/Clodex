import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IDS, type AgentId } from "../agents/agent-adapter.js";
import { type ConfigPaths, type ConfigSource, loadMcpServers, type McpServerConfig } from "../config/config.js";
import { writeFileAtomic } from "../project/atomic-write.js";

export type McpStatus = "synced" | "missing" | "mismatch" | "unsupported" | "external";
export type McpActionKind = "add" | "update" | "remove";
export interface McpEntry {
  name: string;
  agent: AgentId;
  scope: ConfigSource;
  status: McpStatus;
  reason?: string;
}
export interface McpAction {
  name: string;
  agent: AgentId;
  scope: ConfigSource;
  kind: McpActionKind;
  server?: McpServerConfig;
  skipWrite?: boolean;
}
export interface McpPlan {
  entries: McpEntry[];
  actions: McpAction[];
  snapshots: Record<string, string | null>;
  errors: string[];
}
export interface McpApplyResult {
  errors: string[];
  applied: McpAction[];
}
export interface CliServer {
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}
type Current = Record<string, CliServer>;
export type McpDesired = Record<string, { scope: ConfigSource; server: McpServerConfig }>;
export interface McpCliAdapter {
  readonly agent: AgentId;
  read(): { user: Current; project: Current; error?: string };
  plan(desired: McpDesired): McpPlan;
  apply(plan: McpPlan): McpApplyResult;
}
type Applied = Record<AgentId, Record<string, ConfigSource>>;
type Runner = (command: string, args: string[], env: NodeJS.ProcessEnv) => { status: number | null; stdout: string; stderr: string };
export interface McpManagerOptions {
  claudeConfigDir?: string;
  codexHome?: string;
  agyHome?: string;
  codexCommand?: string;
  run?: Runner;
}

const EMPTY_APPLIED = (): Applied => ({ claude: {}, codex: {}, gemini: {} });
const readText = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const parseObject = (text: string | null, path: string): Record<string, unknown> => {
  if (text === null || text.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    const object = record(value);
    if (object) return object;
  } catch {
    /* エラーは下でファイル名を付ける */
  }
  throw new Error(`${path}: invalid JSON object`);
};
const normalize = (value: unknown): CliServer | undefined => {
  const data = record(value);
  if (!data) return undefined;
  const transport = data.type === "http" || typeof data.serverUrl === "string" || typeof data.url === "string" ? "http" : "stdio";
  const env = record(data.env);
  return {
    transport,
    ...(typeof data.command === "string" ? { command: data.command } : {}),
    ...(Array.isArray(data.args) ? { args: data.args.filter((arg): arg is string => typeof arg === "string") } : {}),
    ...(typeof data.url === "string" ? { url: data.url } : typeof data.serverUrl === "string" ? { url: data.serverUrl } : {}),
    ...(env ? { env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")) } : {}),
  };
};
const sameServer = (actual: CliServer, wanted: McpServerConfig): boolean => {
  if (actual.transport !== wanted.transport) return false;
  if (wanted.transport === "http") return actual.url === wanted.url;
  return (
    actual.command === wanted.command &&
    JSON.stringify(actual.args ?? []) === JSON.stringify(wanted.args ?? []) &&
    JSON.stringify(actual.env ?? {}) === JSON.stringify(wanted.env ?? {})
  );
};
const desiredObject = (server: McpServerConfig, agent: AgentId): Record<string, unknown> => {
  if (server.transport === "http") return agent === "gemini" ? { serverUrl: server.url, disabled: false } : { type: "http", url: server.url };
  return {
    ...(agent === "claude" ? { type: "stdio" } : {}),
    command: server.command,
    args: server.args ?? [],
    ...(server.env ? { env: server.env } : {}),
    ...(agent === "gemini" ? { disabled: false } : {}),
  };
};
const defaultRunner: Runner = (command, args, env) => {
  const result = spawnSync(command, args, { env, encoding: "utf8", windowsHide: true });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
};

export class McpManager {
  private readonly claudeUserPath: string;
  private readonly claudeProjectPath: string;
  private readonly codexPath: string;
  private readonly agyPath: string;
  private readonly appliedPath: string;
  private readonly codexHome: string;
  private readonly codexCommand: string;
  private readonly run: Runner;

  constructor(
    private readonly paths: ConfigPaths,
    options: McpManagerOptions = {},
  ) {
    const claudeDir = options.claudeConfigDir ?? paths.homeDir;
    this.codexHome = options.codexHome ?? join(paths.homeDir, ".codex");
    const agyHome = options.agyHome ?? paths.homeDir;
    this.claudeUserPath = join(claudeDir, ".claude.json");
    this.claudeProjectPath = join(paths.projectRoot, ".mcp.json");
    this.codexPath = join(this.codexHome, "config.toml");
    this.agyPath = join(agyHome, ".gemini", "config", "mcp_config.json");
    this.appliedPath = join(paths.homeDir, ".clodex", "mcp-applied.json");
    this.codexCommand = options.codexCommand ?? (process.platform === "win32" ? "codex.exe" : "codex");
    this.run = options.run ?? defaultRunner;
  }

  private readJsonServers(path: string): Current {
    const root = parseObject(readText(path), path);
    const servers = root.mcpServers === undefined ? {} : record(root.mcpServers);
    if (!servers) throw new Error(`${path}: invalid mcpServers`);
    return Object.fromEntries(
      Object.entries(servers).map(([name, value]) => {
        const parsed = normalize(value);
        if (!parsed) throw new Error(`${path}: invalid mcpServers.${name}`);
        return [name, parsed];
      }),
    );
  }

  private readCodex(): Current {
    const result = this.run(this.codexCommand, ["mcp", "list", "--json"], { ...process.env, CODEX_HOME: this.codexHome });
    if (result.status !== 0) throw new Error(`codex mcp list: ${result.stderr || result.stdout}`);
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) throw new Error("codex mcp list: invalid JSON array");
    const servers: Current = {};
    for (const item of parsed) {
      const row = record(item);
      const transport = record(row?.transport);
      if (typeof row?.name !== "string" || !transport) continue;
      const server = normalize({ ...transport, type: transport.type === "streamable_http" ? "http" : transport.type });
      if (server) servers[row.name] = server;
    }
    return servers;
  }

  private readApplied(): Applied {
    const parsed = parseObject(readText(this.appliedPath), this.appliedPath);
    const applied = EMPTY_APPLIED();
    for (const agent of AGENT_IDS) {
      const rows = record(parsed[agent]);
      if (!rows) continue;
      for (const [name, scope] of Object.entries(rows)) if (scope === "user" || scope === "project") applied[agent][name] = scope;
    }
    return applied;
  }

  adapter(agent: AgentId): McpCliAdapter {
    return {
      agent,
      read: () => {
        try {
          if (agent === "claude") return { user: this.readJsonServers(this.claudeUserPath), project: this.readJsonServers(this.claudeProjectPath) };
          if (agent === "codex") return { user: this.readCodex(), project: {} };
          return { user: this.readJsonServers(this.agyPath), project: {} };
        } catch (error) {
          return { user: {}, project: {}, error: String(error) };
        }
      },
      plan: desired => {
        const plan = this.plan(desired);
        return { ...plan, entries: plan.entries.filter(entry => entry.agent === agent), actions: plan.actions.filter(action => action.agent === agent) };
      },
      apply: plan => this.apply({ ...plan, actions: plan.actions.filter(action => action.agent === agent) }),
    };
  }

  plan(desiredOverride?: McpDesired): McpPlan {
    const snapshots = Object.fromEntries(
      [
        this.claudeUserPath,
        this.claudeProjectPath,
        this.codexPath,
        this.agyPath,
        this.appliedPath,
        join(this.paths.homeDir, ".clodex", "config.json"),
        join(this.paths.projectRoot, ".clodex.json"),
      ].map(path => [path, readText(path)]),
    );
    const plan: McpPlan = { entries: [], actions: [], snapshots, errors: [] };
    const user = desiredOverride
      ? Object.fromEntries(
          Object.entries(desiredOverride)
            .filter(([, value]) => value.scope === "user")
            .map(([name, value]) => [name, value.server]),
        )
      : loadMcpServers(this.paths, "user");
    const project = desiredOverride
      ? Object.fromEntries(
          Object.entries(desiredOverride)
            .filter(([, value]) => value.scope === "project")
            .map(([name, value]) => [name, value.server]),
        )
      : loadMcpServers(this.paths, "project");
    const desired = { ...user, ...project };
    let applied: Applied;
    try {
      applied = this.readApplied();
    } catch (error) {
      plan.errors.push(String(error));
      return plan;
    }
    const current: Record<AgentId, Record<ConfigSource, Current>> = {
      claude: { user: {}, project: {} },
      codex: { user: {}, project: {} },
      gemini: { user: {}, project: {} },
    };
    for (const [agent, scope, path] of [
      ["claude", "user", this.claudeUserPath],
      ["claude", "project", this.claudeProjectPath],
      ["gemini", "user", this.agyPath],
    ] as const) {
      try {
        current[agent][scope] = this.readJsonServers(path);
      } catch (error) {
        plan.errors.push(String(error));
      }
    }
    try {
      current.codex.user = this.readCodex();
    } catch (error) {
      plan.errors.push(String(error));
    }
    if (plan.errors.length) return plan;

    const names = new Set([
      ...Object.keys(desired),
      ...AGENT_IDS.flatMap(agent => [...Object.keys(applied[agent]), ...Object.keys(current[agent].user), ...Object.keys(current[agent].project)]),
    ]);
    names.delete("clodex");
    for (const name of [...names].sort())
      for (const agent of AGENT_IDS) {
        const server = desired[name];
        const scope: ConfigSource = name in project ? "project" : "user";
        const managedScope = applied[agent][name];
        const effectiveScope = managedScope ?? scope;
        const actual = current[agent][effectiveScope][name];
        const other = current[agent][effectiveScope === "user" ? "project" : "user"][name];
        const selected = server?.enabled && server.agents[agent];
        if (selected && scope === "project" && agent !== "claude") {
          plan.entries.push({ name, agent, scope, status: "unsupported", reason: "project scope" });
          continue;
        }
        if (selected && server.envRefs && Object.keys(server.envRefs).length) {
          plan.entries.push({ name, agent, scope, status: "unsupported", reason: "envRefs" });
          continue;
        }
        if (selected && managedScope && managedScope !== scope) {
          if (current[agent][scope][name]) {
            plan.entries.push({ name, agent, scope, status: "external" });
            continue;
          }
          plan.entries.push({ name, agent, scope, status: "mismatch" });
          plan.actions.push({ name, agent, scope: managedScope, kind: "remove" }, { name, agent, scope, kind: "add", server });
          continue;
        }
        if (selected && (other || (actual && !managedScope))) {
          plan.entries.push({ name, agent, scope, status: "external" });
          continue;
        }
        if (selected) {
          const status: McpStatus = !actual ? "missing" : sameServer(actual, server) ? "synced" : "mismatch";
          plan.entries.push({ name, agent, scope, status });
          if (status !== "synced") plan.actions.push({ name, agent, scope, kind: actual ? "update" : "add", server });
        } else if (managedScope) {
          plan.entries.push({ name, agent, scope: managedScope, status: actual ? "mismatch" : "missing" });
          plan.actions.push({ name, agent, scope: managedScope, kind: "remove", skipWrite: !actual });
        } else if (actual || other) {
          plan.entries.push({ name, agent, scope: actual ? effectiveScope : effectiveScope === "user" ? "project" : "user", status: "external" });
        }
      }
    return plan;
  }

  private writeJsonActions(path: string, actions: McpAction[], agent: AgentId): void {
    const value = parseObject(readText(path), path);
    const servers = { ...(record(value.mcpServers) ?? {}) };
    for (const action of actions) {
      if (action.kind === "remove") delete servers[action.name];
      else if (action.server) servers[action.name] = desiredObject(action.server, agent);
    }
    this.writeWithBackup(path, `${JSON.stringify({ ...value, mcpServers: servers }, null, 2)}\n`);
  }

  private writeWithBackup(path: string, next: string): void {
    const previous = readText(path);
    if (previous !== null) writeFileAtomic(`${path}.clodex-bak`, previous);
    writeFileAtomic(path, next);
  }

  private writeCodexActions(actions: McpAction[]): void {
    const stage = mkdtempSync(join(tmpdir(), "clodex-codex-mcp-"));
    try {
      const stagedPath = join(stage, "config.toml");
      const existing = readText(this.codexPath);
      if (existing !== null) writeFileSync(stagedPath, existing);
      for (const action of actions) {
        const server = action.server;
        const args =
          action.kind === "remove"
            ? ["mcp", "remove", action.name]
            : server?.transport === "http"
              ? ["mcp", "add", action.name, "--url", server.url ?? ""]
              : [
                  "mcp",
                  "add",
                  action.name,
                  ...Object.entries(server?.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
                  "--",
                  server?.command ?? "",
                  ...(server?.args ?? []),
                ];
        const result = this.run(this.codexCommand, args, { ...process.env, CODEX_HOME: stage });
        if (result.status !== 0) throw new Error(`codex ${args.slice(0, 2).join(" ")}: ${result.stderr || result.stdout}`);
      }
      this.writeWithBackup(this.codexPath, readText(stagedPath) ?? "");
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }

  apply(plan: McpPlan): McpApplyResult {
    const result: McpApplyResult = { errors: [...plan.errors], applied: [] };
    if (result.errors.length) return result;
    for (const [path, before] of Object.entries(plan.snapshots)) if (readText(path) !== before) result.errors.push(`${path}: changed since preview`);
    if (result.errors.length) return result;
    let applied: Applied;
    try {
      applied = this.readApplied();
    } catch (error) {
      result.errors.push(String(error));
      return result;
    }
    for (const agent of AGENT_IDS)
      for (const scope of ["user", "project"] as const) {
        const actions = plan.actions.filter(action => action.agent === agent && action.scope === scope);
        if (!actions.length) continue;
        try {
          const writes = actions.filter(action => !action.skipWrite);
          if (writes.length && agent === "claude") this.writeJsonActions(scope === "user" ? this.claudeUserPath : this.claudeProjectPath, writes, agent);
          else if (writes.length && agent === "gemini") this.writeJsonActions(this.agyPath, writes, agent);
          else if (writes.length) this.writeCodexActions(writes);
          for (const action of actions) {
            if (action.kind === "remove") delete applied[agent][action.name];
            else applied[agent][action.name] = scope;
            result.applied.push(action);
          }
          writeFileAtomic(this.appliedPath, `${JSON.stringify(applied, null, 2)}\n`);
        } catch (error) {
          result.errors.push(`${agent}: ${String(error)}`);
        }
      }
    return result;
  }
}
