// AgentAdapter の境界定義（DESIGN.md §9）

export const AGENT_IDS = ["claude", "codex"] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export const isAgentId = (value: string): value is AgentId => (AGENT_IDS as readonly string[]).includes(value);
export type AgentStatus = "stopped" | "starting" | "idle" | "busy";

// 両 Agent 共通の権限レベル（DESIGN.md §9 Permission）
export const PERMISSION_LEVELS = ["read-only", "edit", "full"] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];
export const DEFAULT_PERMISSION: PermissionLevel = "edit";
export const COMMON_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export const CLAUDE_EFFORT_LEVELS = [...COMMON_EFFORT_LEVELS, "max"] as const;

// Coordinator が両 Agent に提供する MCP server と tool の名前（DESIGN.md §12）
export const COORDINATOR_MCP_SERVER = "clodex";
export const SEND_MESSAGE_TOOL = "send_message";

export interface AgentStartOptions {
  cwd: string;
  resumeSessionId?: string;
  mcpUrl?: string;
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
  | { type: "tool"; name: string; input: string; files?: string[] } // files: 変更したファイル（成果物の一覧に使う）
  | { type: "turn_started" }
  | { type: "turn"; result: TurnResult }
  | { type: "rate_limit"; fiveHour?: RateLimitWindow; weekly?: RateLimitWindow }
  | { type: "context"; tokens: number; window?: number }
  | { type: "compacted" }
  | { type: "models" }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };

export type AgentEventHandler = (event: AgentEvent) => void;

export interface AgentAdapter {
  readonly id: AgentId;
  readonly status: AgentStatus;
  readonly sessionId: string | undefined;
  readonly permission: PermissionLevel;
  readonly model: string | undefined;
  readonly effort: string | undefined;
  listModels(): readonly string[];

  start(options: AgentStartOptions): Promise<void>;
  // images: 画像のファイル（実パス）。Agent に画像として渡す（DESIGN.md §28 v0.3 C）
  send(text: string, images?: readonly string[]): Promise<TurnResult>;
  // 手動 compact。1 ターンとして扱う（docs/spikes/compact.md）
  compact(): Promise<TurnResult>;
  // 実行中のターンに指示を足す。足せなければ false（DESIGN.md §28 v0.3 C）
  steer(text: string): Promise<boolean>;
  // 停止中なら次の起動時に使う
  setPermission(level: PermissionLevel): Promise<void>;
  setModel(model: string): Promise<TurnResult | void>;
  setEffort(level: string): Promise<TurnResult | void>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  onEvent(handler: AgentEventHandler): () => void;
}

export const TOOL_INPUT_SUMMARY_LENGTH = 200;

export const summarizeToolInput = (input: unknown): string =>
  (typeof input === "string" ? input : JSON.stringify(input) ?? "").slice(0, TOOL_INPUT_SUMMARY_LENGTH);
