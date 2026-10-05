import {
  COORDINATOR_MCP_SERVER, summarizeToolInput,
  type AgentStartOptions, type RateLimitWindow, type TurnResult,
} from "./agent-adapter.js";
import { agentEnv, spawnAgentProcess, type SpawnAgentProcess } from "./agent-process.js";
import { BaseAgentAdapter } from "./base-agent-adapter.js";

// codex app-server の JSON-RPC プロトコル（docs/spikes/codex-lifecycle.md）
const CODEX_COMMAND = "codex";
const SUBSCRIPTION_ACCOUNT_TYPE = "chatgpt";
const CLIENT_INFO = { name: "clodex", title: "Clodex", version: "0.0.0" };
// v0.1 は承認要求を扱わない。承認なしで動く範囲に sandbox で制限する（DESIGN.md §9）
const THREAD_POLICY = { approvalPolicy: "never", sandbox: "workspace-write" } as const;
const METHOD_NOT_FOUND = -32601;

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

interface CodexItem {
  type?: string;
  text?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  command?: string;
}

interface CodexRateLimitWindow {
  usedPercent?: number;
  resetsAt?: number;
}

interface CodexNotificationParams {
  item?: CodexItem;
  turn?: { id?: string; status?: string; error?: { message?: string } | null };
  rateLimits?: { primary?: CodexRateLimitWindow | null; secondary?: CodexRateLimitWindow | null };
  message?: string;
  error?: { message?: string };
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

const toRateLimitWindow = (w: CodexRateLimitWindow | null | undefined): RateLimitWindow | undefined =>
  w?.usedPercent === undefined || w.resetsAt === undefined ? undefined : { usedPercent: w.usedPercent, resetsAt: w.resetsAt };

const TURN_STATUS: Record<string, TurnResult["status"]> = { completed: "completed", interrupted: "interrupted" };

export class CodexAdapter extends BaseAgentAdapter {
  readonly id = "codex";
  private nextRequestId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private turnId: string | undefined;
  private interruptPending = false;
  private lastAgentText = "";

  constructor(private readonly spawnProcess: SpawnAgentProcess = spawnAgentProcess) {
    super();
  }

  async start({ cwd, resumeSessionId, mcpUrl, model, instructions }: AgentStartOptions): Promise<void> {
    if (this.status !== "stopped") throw new Error(`codex is ${this.status}`);
    this.status = "starting";
    const args = ["app-server", ...(mcpUrl ? mcpArgs(mcpUrl) : [])];
    this.attach(this.spawnProcess(CODEX_COMMAND, args, { cwd, env: agentEnv(process.env, this.id) }));
    try {
      await this.handshake(cwd, resumeSessionId, model, instructions);
    } catch (error) {
      // 起動途中で失敗したら常駐プロセスを残さない
      this.proc?.kill();
      throw error;
    }
  }

  private async handshake(
    cwd: string, resumeSessionId: string | undefined, model: string | undefined, instructions: string | undefined,
  ): Promise<void> {
    await this.request("initialize", { clientInfo: CLIENT_INFO, capabilities: null });
    this.notify("initialized");
    await this.verifySubscription();

    const threadParams = {
      cwd, ...THREAD_POLICY, ...(model ? { model } : {}), ...(instructions ? { developerInstructions: instructions } : {}),
    };
    const response = (resumeSessionId
      ? await this.request("thread/resume", { threadId: resumeSessionId, ...threadParams })
      : await this.request("thread/start", threadParams)) as { thread: { id: string } };
    this.sessionId = response.thread.id;
    this.status = "idle";
    this.emit({ type: "session", sessionId: this.sessionId });
  }

  async interrupt(): Promise<void> {
    if (this.status !== "busy") return;
    // turn ID が未確定（turn/start の応答前）なら、確定した時点で送る
    if (!this.turnId) {
      this.interruptPending = true;
      return;
    }
    await this.request("turn/interrupt", { threadId: this.sessionId, turnId: this.turnId });
  }

  private setTurnId(turnId: string | undefined): void {
    if (this.turnId || !turnId) return;
    this.turnId = turnId;
    if (!this.interruptPending) return;
    this.interruptPending = false;
    this.interrupt().catch((error: Error) => this.emit({ type: "error", message: `codex: interrupt failed: ${error.message}` }));
  }

  protected writeTurn(text: string): void {
    this.lastAgentText = "";
    this.turnId = undefined;
    this.interruptPending = false;
    this.request("turn/start", { threadId: this.sessionId, input: [{ type: "text", text, text_elements: [] }] })
      .then((response) => this.setTurnId((response as { turn?: { id?: string } }).turn?.id))
      .catch((error: Error) => this.finishTurn({ status: "failed", text: error.message }));
  }

  protected handleMessage(message: unknown): void {
    const rpc = message as RpcMessage;
    if (rpc.id !== undefined && rpc.method !== undefined) return this.rejectServerRequest(rpc);
    if (rpc.id !== undefined) return this.settleRequest(rpc);
    if (rpc.method) this.handleNotification(rpc.method, (rpc.params ?? {}) as CodexNotificationParams);
  }

  protected handleExit(code: number | null): void {
    for (const { reject } of this.pending.values()) reject(new Error(`codex process exited (code ${code})`));
    this.pending.clear();
    super.handleExit(code);
  }

  private async verifySubscription(): Promise<void> {
    const { account } = (await this.request("account/read", {})) as { account?: { type?: string } | null };
    if (account?.type === SUBSCRIPTION_ACCOUNT_TYPE) return;
    const message = `codex is not using subscription auth (account type: ${account?.type ?? "none"})`;
    this.abort(message);
    throw new Error(message);
  }

  private handleNotification(method: string, params: CodexNotificationParams): void {
    switch (method) {
      case "turn/started":
        return this.setTurnId(params.turn?.id);
      case "item/completed":
        return this.handleItem(params.item ?? {});
      case "account/rateLimits/updated": {
        const fiveHour = toRateLimitWindow(params.rateLimits?.primary);
        const weekly = toRateLimitWindow(params.rateLimits?.secondary);
        this.emit({ type: "rate_limit", ...(fiveHour && { fiveHour }), ...(weekly && { weekly }) });
        return;
      }
      case "turn/completed": {
        const status = TURN_STATUS[params.turn?.status ?? ""] ?? "failed";
        const text = this.lastAgentText || (params.turn?.error?.message ?? "");
        return this.finishTurn({ status, text });
      }
      case "error":
        this.emit({ type: "error", message: `codex: ${params.error?.message ?? params.message ?? "unknown error"}` });
    }
  }

  private handleItem(item: CodexItem): void {
    if (item.type === "agentMessage" && item.text) {
      this.lastAgentText = item.text;
      this.emit({ type: "text", text: item.text });
    }
    if (item.type === "mcpToolCall") {
      this.emit({ type: "tool", name: `${item.server}.${item.tool}`, input: summarizeToolInput(item.arguments) });
    }
    if (item.type === "commandExecution") {
      this.emit({ type: "tool", name: "command", input: summarizeToolInput(item.command ?? "") });
    }
  }

  // v0.1 は承認要求等の server request を扱わない（DESIGN.md §9）
  private rejectServerRequest(rpc: RpcMessage): void {
    this.proc?.write(JSON.stringify({
      id: rpc.id, error: { code: METHOD_NOT_FOUND, message: `Clodex does not handle ${rpc.method}` },
    }));
    this.emit({ type: "error", message: `codex: unhandled server request ${rpc.method}` });
  }

  private settleRequest(rpc: RpcMessage): void {
    const request = this.pending.get(rpc.id!);
    if (!request) return;
    this.pending.delete(rpc.id!);
    if (rpc.error) request.reject(new Error(rpc.error.message ?? "codex request failed"));
    else request.resolve(rpc.result);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error("codex process is not running"));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      proc.write(JSON.stringify({ id, method, params }));
    });
  }

  private notify(method: string): void {
    this.proc?.write(JSON.stringify({ method }));
  }
}

const mcpArgs = (url: string): string[] => [
  "-c", `mcp_servers.${COORDINATOR_MCP_SERVER}.url="${url}"`,
  "-c", `mcp_servers.${COORDINATOR_MCP_SERVER}.default_tools_approval_mode="approve"`,
];
