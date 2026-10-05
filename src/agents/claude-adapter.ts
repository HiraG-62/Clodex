import { randomUUID } from "node:crypto";
import {
  COORDINATOR_MCP_SERVER, SEND_MESSAGE_TOOL, summarizeToolInput,
  type AgentStartOptions, type PermissionLevel, type RateLimitWindow,
} from "./agent-adapter.js";
import { agentEnv, spawnAgentProcess, type SpawnAgentProcess } from "./agent-process.js";
import { BaseAgentAdapter } from "./base-agent-adapter.js";

// claude -p の stream-json プロトコル（docs/spikes/claude-lifecycle.md）
const CLAUDE_COMMAND = "claude";
const STREAM_ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
const SUBSCRIPTION_API_KEY_SOURCE = "none";
const HTTP_UNAUTHORIZED = 401;
const RATIO_TO_PERCENT = 100;
const COMPACT_COMMAND = "/compact";

// 権限レベル → Claude の permission mode（DESIGN.md §9 Permission）
// read-only は plan: default はユーザー設定の許可リストで書き込めてしまうため（docs/spikes/permission.md）
const PERMISSION_MODE: Record<PermissionLevel, string> = {
  "read-only": "plan",
  edit: "acceptEdits",
  full: "bypassPermissions",
};

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface UtilizationWindow {
  utilization?: number;
  resetsAt?: number;
}

interface MessageUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

interface ClaudeEvent {
  type?: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  apiKeySource?: string;
  error_status?: number;
  message?: { content?: ContentBlock[]; usage?: MessageUsage };
  modelUsage?: Record<string, { contextWindow?: number }>;
  result?: string;
  is_error?: boolean;
  rate_limit_info?: { unifiedWindows?: { five_hour?: UtilizationWindow; seven_day?: UtilizationWindow } };
}

const toRateLimitWindow = (w: UtilizationWindow | undefined): RateLimitWindow | undefined =>
  w?.utilization === undefined || w.resetsAt === undefined
    ? undefined
    : { usedPercent: Math.round(w.utilization * RATIO_TO_PERCENT), resetsAt: w.resetsAt };

export class ClaudeAdapter extends BaseAgentAdapter {
  readonly id = "claude";
  private interruptRequested = false;
  // 最後の API 呼び出しの usage。今のコンテキストの大きさとして使う（DESIGN.md §9）
  private lastUsage: MessageUsage | undefined;

  constructor(
    private readonly spawnProcess: SpawnAgentProcess = spawnAgentProcess,
    private readonly createId: () => string = randomUUID,
  ) {
    super();
  }

  async start({ cwd, resumeSessionId, mcpUrl, model, instructions }: AgentStartOptions): Promise<void> {
    if (this.status !== "stopped") throw new Error(`claude is ${this.status}`);
    // session ID を Coordinator 側で決めておくと、最初のターン前から resume 用 ID が確定する
    this.sessionId = resumeSessionId ?? this.createId();
    this.launchPermission = this.permission;
    const args = [
      ...STREAM_ARGS,
      "--permission-mode", PERMISSION_MODE[this.permission],
      // 後から full（bypassPermissions）へ切り替えられるようにする。付けるだけでは bypass にならない
      "--allow-dangerously-skip-permissions",
      ...(resumeSessionId ? ["-r", resumeSessionId] : ["--session-id", this.sessionId]),
      ...(model ? ["--model", model] : []),
      ...(instructions ? ["--append-system-prompt", instructions] : []),
      ...(mcpUrl ? mcpArgs(mcpUrl) : []),
    ];
    const proc = this.spawnProcess(CLAUDE_COMMAND, args, { cwd, env: agentEnv(process.env, this.id) });
    this.attach(proc);
    this.status = "starting";
    // Claude は最初のターンまで何も出力しないので、プロセスの起動成功をもって start 完了とする
    await proc.spawned;
    this.status = "idle";
    await this.applyPermissionChangedDuringStart();
    this.emit({ type: "session", sessionId: this.sessionId });
  }

  async interrupt(): Promise<void> {
    if (this.status !== "busy") return;
    this.interruptRequested = true;
    this.proc?.write(JSON.stringify({
      type: "control_request", request_id: this.createId(), request: { subtype: "interrupt" },
    }));
  }

  protected async applyPermission(level: PermissionLevel): Promise<void> {
    this.proc?.write(JSON.stringify({
      type: "control_request", request_id: this.createId(),
      request: { subtype: "set_permission_mode", mode: PERMISSION_MODE[level] },
    }));
  }

  protected writeTurn(text: string): void {
    this.interruptRequested = false;
    this.proc?.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }));
  }

  // stream-json に /compact を送ると 1 ターンとして compact される（docs/spikes/compact.md）
  protected writeCompact(): void {
    this.writeTurn(COMPACT_COMMAND);
  }

  protected handleMessage(message: unknown): void {
    const event = message as ClaudeEvent;
    switch (event.type) {
      case "system":
        return this.handleSystem(event);
      case "assistant":
        return this.handleAssistant(event);
      case "rate_limit_event": {
        const windows = event.rate_limit_info?.unifiedWindows;
        const fiveHour = toRateLimitWindow(windows?.five_hour);
        const weekly = toRateLimitWindow(windows?.seven_day);
        this.emit({ type: "rate_limit", ...(fiveHour && { fiveHour }), ...(weekly && { weekly }) });
        return;
      }
      case "result":
        this.emitContext(event);
        return this.finishTurn({ status: this.resultStatus(event), text: event.result ?? "" });
    }
  }

  private handleSystem(event: ClaudeEvent): void {
    if (event.subtype === "init" && event.apiKeySource !== SUBSCRIPTION_API_KEY_SOURCE) {
      this.abort(`claude is not using subscription auth (apiKeySource: ${event.apiKeySource})`);
      return;
    }
    if (event.subtype === "init") this.beginSpontaneousTurn();
    // compact 後の正確な大きさは次のターンまで分からない（post_tokens は system prompt を含まない）
    if (event.subtype === "compact_boundary") {
      this.lastUsage = undefined;
      this.emit({ type: "compacted" });
      return;
    }
    if (event.subtype === "api_retry" && event.error_status === HTTP_UNAUTHORIZED) {
      this.abort("claude authentication failed (401)");
    }
  }

  private emitContext(event: ClaudeEvent): void {
    const usage = this.lastUsage;
    this.lastUsage = undefined;
    if (!usage) return;
    const tokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
      + (usage.cache_read_input_tokens ?? 0) + (usage.output_tokens ?? 0);
    const windows = Object.values(event.modelUsage ?? {}).map((m) => m.contextWindow ?? 0);
    const window = windows.length ? Math.max(...windows) : 0;
    this.emit({ type: "context", tokens, ...(window ? { window } : {}) });
  }

  private handleAssistant(event: ClaudeEvent): void {
    if (event.parent_tool_use_id) return;
    if (event.message?.usage) this.lastUsage = event.message.usage;
    for (const block of event.message?.content ?? []) {
      if (block.type === "text" && block.text) this.emit({ type: "text", text: block.text });
      if (block.type === "tool_use" && block.name) {
        this.emit({ type: "tool", name: block.name, input: summarizeToolInput(block.input) });
      }
    }
  }

  private resultStatus(event: ClaudeEvent) {
    if (event.subtype === "success" && !event.is_error) return "completed" as const;
    return this.interruptRequested ? "interrupted" as const : "failed" as const;
  }
}

const mcpArgs = (url: string): string[] => [
  "--mcp-config", JSON.stringify({ mcpServers: { [COORDINATOR_MCP_SERVER]: { type: "http", url } } }),
  "--allowedTools", `mcp__${COORDINATOR_MCP_SERVER}__${SEND_MESSAGE_TOOL}`,
];
