// AgentAdapter の境界定義（DESIGN.md §9）

export const AGENT_IDS = ["claude", "codex"] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export type AgentStatus = "stopped" | "starting" | "idle" | "busy";

// Coordinator が両 Agent に提供する MCP server と tool の名前（DESIGN.md §12）
export const COORDINATOR_MCP_SERVER = "clodex";
export const SEND_MESSAGE_TOOL = "send_message";

export interface AgentStartOptions {
  cwd: string;
  resumeSessionId?: string;
  mcpUrl?: string;
  model?: string;
  // system prompt に追加する指示（役割など。DESIGN.md §13 Roles）
  instructions?: string;
}

export interface TurnResult {
  status: "completed" | "interrupted" | "failed";
  text: string;
}

export interface RateLimitWindow {
  usedPercent: number;
  resetsAt: number; // epoch seconds
}

export type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: string }
  | { type: "turn_started" }
  | { type: "turn"; result: TurnResult }
  | { type: "rate_limit"; fiveHour?: RateLimitWindow; weekly?: RateLimitWindow }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };

export type AgentEventHandler = (event: AgentEvent) => void;

export interface AgentAdapter {
  readonly id: AgentId;
  readonly status: AgentStatus;
  readonly sessionId: string | undefined;

  start(options: AgentStartOptions): Promise<void>;
  send(text: string): Promise<TurnResult>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  onEvent(handler: AgentEventHandler): () => void;
}

export const TOOL_INPUT_SUMMARY_LENGTH = 200;

export const summarizeToolInput = (input: unknown): string =>
  (typeof input === "string" ? input : JSON.stringify(input) ?? "").slice(0, TOOL_INPUT_SUMMARY_LENGTH);
