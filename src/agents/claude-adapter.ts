import { randomUUID } from "node:crypto";
import {
  COORDINATOR_MCP_SERVER, SEND_MESSAGE_TOOL, summarizeToolInput,
  type AgentStartOptions, type RateLimitWindow,
} from "./agent-adapter.js";
import { agentEnv, spawnAgentProcess, type SpawnAgentProcess } from "./agent-process.js";
import { BaseAgentAdapter } from "./base-agent-adapter.js";

// claude -p の stream-json プロトコル（docs/spikes/claude-lifecycle.md）
const CLAUDE_COMMAND = "claude";
const STREAM_ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
const SUBSCRIPTION_API_KEY_SOURCE = "none";
const HTTP_UNAUTHORIZED = 401;
const RATIO_TO_PERCENT = 100;

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

interface ClaudeEvent {
  type?: string;
  subtype?: string;
  apiKeySource?: string;
  error_status?: number;
  message?: { content?: ContentBlock[] };
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
    const args = [
      ...STREAM_ARGS,
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
    this.emit({ type: "session", sessionId: this.sessionId });
  }

  async interrupt(): Promise<void> {
    if (this.status !== "busy") return;
    this.interruptRequested = true;
    this.proc?.write(JSON.stringify({
      type: "control_request", request_id: this.createId(), request: { subtype: "interrupt" },
    }));
  }

  protected writeTurn(text: string): void {
    this.interruptRequested = false;
    this.proc?.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }));
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
        return this.finishTurn({ status: this.resultStatus(event), text: event.result ?? "" });
    }
  }

  private handleSystem(event: ClaudeEvent): void {
    if (event.subtype === "init" && event.apiKeySource !== SUBSCRIPTION_API_KEY_SOURCE) {
      this.abort(`claude is not using subscription auth (apiKeySource: ${event.apiKeySource})`);
      return;
    }
    if (event.subtype === "api_retry" && event.error_status === HTTP_UNAUTHORIZED) {
      this.abort("claude authentication failed (401)");
    }
  }

  private handleAssistant(event: ClaudeEvent): void {
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
