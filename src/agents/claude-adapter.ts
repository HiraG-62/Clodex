import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import {
  type AgentStartOptions,
  ASK_USER_TOOL,
  COORDINATOR_MCP_SERVER,
  type PermissionLevel,
  type RateLimitWindow,
  READ_CONVERSATION_TOOL,
  SEND_MESSAGE_TOOL,
  type SubagentState,
  summarizeToolInput,
  type TurnResult,
} from "./agent-adapter.js";
import { agentEnv, agentStartError, type SpawnAgentProcess, spawnAgentProcess } from "./agent-process.js";
import { BaseAgentAdapter } from "./base-agent-adapter.js";

// claude -p の stream-json プロトコル（docs/spikes/claude-lifecycle.md）
const CLAUDE_COMMAND = "claude";
// --replay-user-messages: 割り込みを取り込んだ時点を replay で知る（docs/spikes/steer-ack.md）
const STREAM_ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages"];
const SUBSCRIPTION_API_KEY_SOURCE = "none";
const HTTP_UNAUTHORIZED = 401;
const RATIO_TO_PERCENT = 100;
const COMPACT_COMMAND = "/compact";
// ファイルを変更する tool と、変更先のパスが入る入力のキー（DESIGN.md §28 v0.3 B）
const EDIT_TOOL_PATH_KEYS: Record<string, string> = {
  Edit: "file_path",
  Write: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

// 画像は user message の image block（base64）で渡す（docs/spikes/steer-image-subagent.md）
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const imageBlock = (path: string) => ({
  type: "image",
  source: { type: "base64", media_type: IMAGE_MEDIA_TYPES[extname(path).toLowerCase()] ?? "image/png", data: readFileSync(path).toString("base64") },
});

const editedFiles = (name: string, input: unknown): string[] | undefined => {
  const key = EDIT_TOOL_PATH_KEYS[name];
  if (!key || typeof input !== "object" || input === null) return undefined;
  const path = (input as Record<string, unknown>)[key];
  return typeof path === "string" && path ? [path] : undefined;
};
const MODEL_COMMAND = "/model";
const EFFORT_COMMAND = "/effort";
const MODEL_SUCCESS = "Set model to ";
const EFFORT_SUCCESS = "Set effort level to ";
type SettingKind = "model" | "effort";

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
  model?: string;
  parent_tool_use_id?: string | null;
  apiKeySource?: string;
  error_status?: number;
  message?: { content?: ContentBlock[]; usage?: MessageUsage };
  modelUsage?: Record<string, { contextWindow?: number }>;
  result?: string;
  is_error?: boolean;
  rate_limit_info?: { unifiedWindows?: { five_hour?: UtilizationWindow; seven_day?: UtilizationWindow } };
  isReplay?: boolean;
  uuid?: string;
  tasks?: Array<{ task_id?: string; task_type?: string; description?: string }>;
}

const toRateLimitWindow = (w: UtilizationWindow | undefined): RateLimitWindow | undefined =>
  w?.utilization === undefined || w.resetsAt === undefined ? undefined : { usedPercent: Math.round(w.utilization * RATIO_TO_PERCENT), resetsAt: w.resetsAt };

export class ClaudeAdapter extends BaseAgentAdapter {
  readonly id = "claude";
  private interruptRequested = false;
  // 割り込みの行の uuid → steerId
  private readonly undeliveredSteers = new Map<string, string>();
  // 最後の API 呼び出しの usage。今のコンテキストの大きさとして使う（DESIGN.md §9）
  private lastUsage: MessageUsage | undefined;
  private settingTurn: SettingKind | undefined;
  private subagents: SubagentState[] = [];

  constructor(
    private readonly spawnProcess: SpawnAgentProcess = spawnAgentProcess,
    private readonly createId: () => string = randomUUID,
  ) {
    super();
  }

  async start(options: AgentStartOptions): Promise<void> {
    const { cwd, resumeSessionId, mcpUrl, instructions } = options;
    if (this.status !== "stopped") throw new Error(`claude is ${this.status}`);
    // session ID を Coordinator 側で決めておくと、最初のターン前から resume 用 ID が確定する
    this.sessionId = resumeSessionId ?? this.createId();
    this.launchPermission = this.permission;
    const args = [
      ...STREAM_ARGS,
      "--permission-mode",
      PERMISSION_MODE[this.permission],
      // 後から full（bypassPermissions）へ切り替えられるようにする。付けるだけでは bypass にならない
      "--allow-dangerously-skip-permissions",
      ...(resumeSessionId ? ["-r", resumeSessionId] : ["--session-id", this.sessionId]),
      ...(this.model ? ["--model", this.model] : []),
      ...(this.effort ? ["--effort", this.effort] : []),
      ...(instructions ? ["--append-system-prompt", instructions] : []),
      ...(mcpUrl ? mcpArgs(mcpUrl) : []),
    ];
    const proc = this.spawnProcess(CLAUDE_COMMAND, args, { cwd, env: agentEnv(process.env, this.id) });
    this.attach(proc);
    this.status = "starting";
    // Claude は最初のターンまで何も出力しないので、プロセスの起動成功をもって start 完了とする
    try {
      await proc.spawned;
    } catch (error) {
      const failure = agentStartError(CLAUDE_COMMAND, error);
      if (failure !== error) this.emit({ type: "error", message: failure.message });
      throw failure;
    }
    this.status = "idle";
    await this.applyPermissionChangedDuringStart();
    if (this.proc !== proc) return;
    this.emit({ type: "session", sessionId: this.sessionId });
  }

  async setModel(model: string): Promise<TurnResult | void> {
    if (this.status === "stopped") {
      this.model = model;
      return;
    }
    return this.runSetting("model", model);
  }

  async setEffort(level: string): Promise<TurnResult | void> {
    if (this.status === "stopped") {
      this.effort = level;
      return;
    }
    return this.runSetting("effort", level);
  }

  private async runSetting(kind: SettingKind, value: string): Promise<TurnResult> {
    if (this.status === "starting") await this.proc?.spawned;
    const spontaneous = this.activeSpontaneousTurn;
    if (spontaneous) await spontaneous;
    const command = `${kind === "model" ? MODEL_COMMAND : EFFORT_COMMAND} ${value}`;
    if (this.status !== "idle") return super.send(command);
    this.settingTurn = kind;
    try {
      const result = await this.sendQuietly(command);
      if (result.status === "completed") this[kind] = value;
      return result;
    } finally {
      this.settingTurn = undefined;
    }
  }

  // 実行中に user message をもう 1 行送ると、そのターンの tool の区切りで取り込まれる（docs/spikes/steer-image-subagent.md）
  async steer(text: string, steerId: string): Promise<boolean> {
    if (this.status !== "busy" || !this.proc) return false;
    const uuid = this.createId();
    this.undeliveredSteers.set(uuid, steerId);
    this.proc.write(JSON.stringify({ type: "user", uuid, message: { role: "user", content: text } }));
    return true;
  }

  async interrupt(): Promise<void> {
    if (this.status !== "busy") return;
    this.startInterruptTimeout();
    this.interruptRequested = true;
    this.proc?.write(
      JSON.stringify({
        type: "control_request",
        request_id: this.createId(),
        request: { subtype: "interrupt" },
      }),
    );
  }

  protected async applyPermission(level: PermissionLevel): Promise<void> {
    this.proc?.write(
      JSON.stringify({
        type: "control_request",
        request_id: this.createId(),
        request: { subtype: "set_permission_mode", mode: PERMISSION_MODE[level] },
      }),
    );
  }

  protected writeTurn(text: string, images: readonly string[] = []): void {
    this.interruptRequested = false;
    const content = images.length ? [...images.map(imageBlock), { type: "text", text }] : text;
    this.proc?.write(JSON.stringify({ type: "user", message: { role: "user", content } }));
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
      case "user":
        return this.handleReplay(event);
      case "rate_limit_event": {
        const windows = event.rate_limit_info?.unifiedWindows;
        const fiveHour = toRateLimitWindow(windows?.five_hour);
        const weekly = toRateLimitWindow(windows?.seven_day);
        this.emit({ type: "rate_limit", ...(fiveHour && { fiveHour }), ...(weekly && { weekly }) });
        return;
      }
      case "result": {
        this.emitContext(event);
        const setting = this.settingTurn;
        this.settingTurn = undefined;
        return this.finishTurn({ status: this.resultStatus(event, setting), text: event.result ?? "" });
      }
    }
  }

  private handleReplay(event: ClaudeEvent): void {
    if (!event.isReplay || !event.uuid) return;
    const steerId = this.undeliveredSteers.get(event.uuid);
    if (!steerId) return;
    this.undeliveredSteers.delete(event.uuid);
    this.emit({ type: "steer_delivered", steerId });
  }

  private handleSystem(event: ClaudeEvent): void {
    if (event.subtype === "background_tasks_changed") {
      const running = (event.tasks ?? [])
        .filter(task => task.task_type === "local_agent" && task.task_id)
        .map(task => ({ id: task.task_id!, description: task.description ?? "" }));
      if (JSON.stringify(running) !== JSON.stringify(this.subagents)) {
        this.subagents = running;
        this.emit({ type: "subagents", running: [...running] });
      }
      return;
    }
    if (event.subtype === "init" && event.apiKeySource !== SUBSCRIPTION_API_KEY_SOURCE) {
      this.abort(`claude is not using subscription auth (apiKeySource: ${event.apiKeySource})`);
      return;
    }
    if (event.subtype === "init") {
      this.model ??= event.model;
      this.beginSpontaneousTurn();
    }
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
    const tokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.output_tokens ?? 0);
    const windows = Object.values(event.modelUsage ?? {}).map(m => m.contextWindow ?? 0);
    const window = windows.length ? Math.max(...windows) : 0;
    this.emit({ type: "context", tokens, ...(window ? { window } : {}) });
  }

  private handleAssistant(event: ClaudeEvent): void {
    if (event.parent_tool_use_id) return;
    if (event.message?.usage) this.lastUsage = event.message.usage;
    for (const block of event.message?.content ?? []) {
      if (block.type === "text" && block.text) this.emit({ type: "text", text: block.text });
      if (block.type === "tool_use" && block.name) {
        const files = editedFiles(block.name, block.input);
        this.emit({ type: "tool", name: block.name, input: summarizeToolInput(block.input), ...(files ? { files } : {}) });
      }
    }
  }

  private resultStatus(event: ClaudeEvent, setting?: SettingKind) {
    const acknowledged = !setting || (event.result ?? "").startsWith(setting === "model" ? MODEL_SUCCESS : EFFORT_SUCCESS);
    if (event.subtype === "success" && !event.is_error && acknowledged) return "completed" as const;
    return this.interruptRequested ? ("interrupted" as const) : ("failed" as const);
  }

  protected handleExit(code: number | null): void {
    if (this.subagents.length) {
      this.subagents = [];
      this.emit({ type: "subagents", running: [] });
    }
    super.handleExit(code);
  }
}

const mcpArgs = (url: string): string[] => [
  "--mcp-config",
  JSON.stringify({ mcpServers: { [COORDINATOR_MCP_SERVER]: { type: "http", url } } }),
  "--allowedTools",
  [SEND_MESSAGE_TOOL, ASK_USER_TOOL, READ_CONVERSATION_TOOL].map(tool => `mcp__${COORDINATOR_MCP_SERVER}__${tool}`).join(","),
  "--disallowedTools",
  "AskUserQuestion",
];
