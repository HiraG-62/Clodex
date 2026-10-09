import {
  COORDINATOR_MCP_SERVER, summarizeToolInput,
  type AgentStartOptions, type PermissionLevel, type SubagentState, type TurnResult,
} from "./agent-adapter.js";
import { z } from "zod";
import { agentEnv, agentStartError, spawnAgentProcess, type SpawnAgentProcess } from "./agent-process.js";
import { BaseAgentAdapter } from "./base-agent-adapter.js";
import { codexRateLimitEvent, type CodexRateLimits } from "./rate-limits.js";

// codex app-server の JSON-RPC プロトコル（docs/spikes/codex-lifecycle.md）
const CODEX_COMMAND = "codex";
const SUBSCRIPTION_ACCOUNT_TYPE = "chatgpt";
const CLIENT_INFO = { name: "clodex", title: "Clodex", version: "0.0.0" };
// 承認要求は扱わない。権限は sandbox で制限する（DESIGN.md §9 Permission）
const APPROVAL_POLICY = "never";

const SANDBOX_MODE: Record<PermissionLevel, string> = {
  "read-only": "read-only",
  edit: "workspace-write",
  full: "danger-full-access",
};

const SANDBOX_POLICY: Record<PermissionLevel, unknown> = {
  "read-only": { type: "readOnly", networkAccess: false },
  edit: { type: "workspaceWrite", writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  full: { type: "dangerFullAccess" },
};
// AGENTS.md が無い project でも CLAUDE.md のルールを読ませる。edit でも依存関係の取得などに要るのでネットワークを許す（docs/spikes/codex-project-config.md）
const PROJECT_CONFIG_ARGS = [
  "-c", 'project_doc_fallback_filenames=["CLAUDE.md"]',
  "-c", "sandbox_workspace_write.network_access=true",
];
const METHOD_NOT_FOUND = -32601;
const CODEX_REQUEST_TIMEOUT_MS = 120_000;
const UNEXPECTED_RESPONSE_PREVIEW_LENGTH = 200;
const threadResponse = z.object({
  thread: z.object({ id: z.string() }), model: z.string().optional(), reasoningEffort: z.string().nullable().optional(),
});
const turnResponse = z.object({ turn: z.object({ id: z.string() }) });
const accountResponse = z.object({ account: z.object({ type: z.string().optional() }).nullish() });
const parseResponse = <T extends z.ZodType>(method: string, schema: T, value: unknown): z.infer<T> => {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new Error(`codex: unexpected response to ${method}: ${JSON.stringify(value)?.slice(0, UNEXPECTED_RESPONSE_PREVIEW_LENGTH)}`);
};

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
  changes?: Array<{ path: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  command?: string;
  kind?: string;
  agentPath?: string;
  agentThreadId?: string;
}

interface CodexNotificationParams {
  threadId?: string;
  item?: CodexItem;
  tokenUsage?: { last?: { totalTokens?: number }; modelContextWindow?: number | null };
  turn?: { id?: string; status?: string; error?: { message?: string } | null };
  rateLimits?: CodexRateLimits;
  message?: string;
  error?: { message?: string };
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const TURN_STATUS: Record<string, TurnResult["status"]> = { completed: "completed", interrupted: "interrupted" };

export class CodexAdapter extends BaseAgentAdapter {
  readonly id = "codex";
  private nextRequestId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private turnId: string | undefined;
  private interruptPending = false;
  // 次の turn/start で sandbox を変える。以降のターンにも引き継がれるので 1 回だけ送る
  private pendingSandbox: PermissionLevel | undefined;
  private lastAgentText = "";
  // ターンの最初の userMessage は入力そのもの。2 つ目以降が割り込みで、送った順に取り込まれる（docs/spikes/steer-ack.md）
  private turnInputSeen = false;
  private undeliveredSteers: string[] = [];
  private readonly subagents = new Map<string, SubagentState>();

  constructor(private readonly spawnProcess: SpawnAgentProcess = spawnAgentProcess) {
    super();
  }

  async start({ cwd, resumeSessionId, mcpUrl, instructions }: AgentStartOptions): Promise<void> {
    if (this.status !== "stopped") throw new Error(`codex is ${this.status}`);
    this.status = "starting";
    const args = ["app-server", ...PROJECT_CONFIG_ARGS, ...(mcpUrl ? mcpArgs(mcpUrl) : [])];
    const proc = this.spawnProcess(CODEX_COMMAND, args, { cwd, env: agentEnv(process.env, this.id) });
    this.attach(proc);
    try {
      await proc.spawned;
      await this.handshake(cwd, resumeSessionId, instructions);
    } catch (error) {
      // 起動途中で失敗したら常駐プロセスを残さない
      this.proc?.kill();
      const failure = agentStartError(CODEX_COMMAND, error);
      if (failure !== error) this.emit({ type: "error", message: failure.message });
      throw failure;
    }
  }

  private async handshake(
    cwd: string, resumeSessionId: string | undefined, instructions: string | undefined,
  ): Promise<void> {
    await this.request("initialize", { clientInfo: CLIENT_INFO, capabilities: null });
    this.notify("initialized");
    await this.verifySubscription();

    this.launchPermission = this.permission;
    const threadParams = {
      cwd, approvalPolicy: APPROVAL_POLICY, sandbox: SANDBOX_MODE[this.launchPermission], ...(this.model ? { model: this.model } : {}), ...(instructions ? { developerInstructions: instructions } : {}),
    };
    const threadMethod = resumeSessionId ? "thread/resume" : "thread/start";
    const response = parseResponse(threadMethod, threadResponse, await this.request(threadMethod,
      resumeSessionId ? { threadId: resumeSessionId, ...threadParams } : threadParams));
    this.sessionId = response.thread.id;
    this.model ??= response.model;
    this.effort ??= response.reasoningEffort ?? undefined;
    this.status = "idle";
    await this.applyPermissionChangedDuringStart();
    this.emit({ type: "session", sessionId: this.sessionId });
    this.readRateLimits();
  }

  // turn/steer は実行中の turn ID を前提にする（docs/spikes/steer-image-subagent.md）
  async steer(text: string, steerId: string): Promise<boolean> {
    if (this.status !== "busy" || !this.turnId) return false;
    try {
      await this.request("turn/steer", {
        threadId: this.sessionId, expectedTurnId: this.turnId, input: [{ type: "text", text, text_elements: [] }],
      });
      this.undeliveredSteers.push(steerId);
      return true;
    } catch {
      return false;
    }
  }

  async interrupt(): Promise<void> {
    if (this.status !== "busy") return;
    this.startInterruptTimeout();
    // turn ID が未確定（turn/start の応答前）なら、確定した時点で送る
    if (!this.turnId) {
      this.interruptPending = true;
      return;
    }
    try {
      await this.request("turn/interrupt", { threadId: this.sessionId, turnId: this.turnId });
    } catch (error) {
      this.emit({ type: "error", message: `codex: interrupt failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private setTurnId(turnId: string | undefined): void {
    if (this.turnId || !turnId) return;
    this.turnId = turnId;
    if (!this.interruptPending) return;
    this.interruptPending = false;
    void this.interrupt();
  }

  protected async applyPermission(level: PermissionLevel): Promise<void> {
    this.pendingSandbox = level;
  }

  // thread/compact/start は 1 ターンとして動く。turn ID は turn/started から得る（docs/spikes/compact.md）
  protected writeCompact(): void {
    this.resetTurnState();
    this.request("thread/compact/start", { threadId: this.sessionId })
      .catch((error: Error) => this.finishTurn({ status: "failed", text: error.message }));
  }

  private resetTurnState(): void {
    this.lastAgentText = "";
    this.turnId = undefined;
    this.interruptPending = false;
    this.turnInputSeen = false;
    this.undeliveredSteers = [];
  }

  protected writeTurn(text: string, images: readonly string[] = []): void {
    this.resetTurnState();
    const sandbox = this.pendingSandbox;
    this.pendingSandbox = undefined;
    this.request("turn/start", {
      threadId: this.sessionId,
      // 画像は localImage で渡す（docs/spikes/steer-image-subagent.md）
      input: [{ type: "text", text, text_elements: [] }, ...images.map((path) => ({ type: "localImage", path }))],
      ...(sandbox ? { sandboxPolicy: SANDBOX_POLICY[sandbox] } : {}),
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
    })
      .then((response) => this.setTurnId(parseResponse("turn/start", turnResponse, response).turn.id))
      .catch((error: Error) => this.finishTurn({ status: "failed", text: error.message }));
  }

  protected handleMessage(message: unknown): void {
    const rpc = message as RpcMessage;
    if (rpc.id !== undefined && rpc.method !== undefined) return this.rejectServerRequest(rpc);
    if (rpc.id !== undefined) return this.settleRequest(rpc);
    if (rpc.method) this.handleNotification(rpc.method, (rpc.params ?? {}) as CodexNotificationParams);
  }

  protected handleExit(code: number | null): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(`codex process exited (code ${code})`));
    }
    this.pending.clear();
    if (this.subagents.size) {
      this.subagents.clear();
      this.emit({ type: "subagents", running: [] });
    }
    super.handleExit(code);
  }

  // 利用状況を起動直後から見えるようにする（通知はターン完了後にしか届かないため。DESIGN.md §14）
  private readRateLimits(): void {
    this.request("account/rateLimits/read", undefined)
      .then((result) => this.emitRateLimits((result as CodexNotificationParams).rateLimits))
      .catch(() => {});
  }

  private emitRateLimits(rateLimits: CodexNotificationParams["rateLimits"]): void {
    this.emit(codexRateLimitEvent(rateLimits));
  }

  private async verifySubscription(): Promise<void> {
    const { account } = parseResponse("account/read", accountResponse, await this.request("account/read", {}));
    if (account?.type === SUBSCRIPTION_ACCOUNT_TYPE) return;
    const message = `codex is not using subscription auth (account type: ${account?.type ?? "none"})`;
    this.abort(message);
    throw new Error(message);
  }

  private handleNotification(method: string, params: CodexNotificationParams): void {
    // subagent は別の thread で動き、同じ stdout に通知が流れる。自分の thread のものだけを扱う（docs/spikes/steer-image-subagent.md）
    if (params.threadId && params.threadId !== this.sessionId) return;
    switch (method) {
      case "turn/started":
        return this.setTurnId(params.turn?.id);
      case "item/completed":
        return this.handleItem(params.item ?? {});
      case "account/rateLimits/updated":
        return this.emitRateLimits(params.rateLimits);
      case "thread/tokenUsage/updated": {
        const tokens = params.tokenUsage?.last?.totalTokens;
        if (tokens === undefined) return;
        const window = params.tokenUsage?.modelContextWindow;
        this.emit({ type: "context", tokens, ...(window ? { window } : {}) });
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
    if (item.type === "userMessage") return this.handleUserMessage();
    if (item.type === "fileChange") {
      const files = item.changes?.map((change) => change.path) ?? [];
      this.emit({ type: "tool", name: "fileChange", input: summarizeToolInput(files.join(", ")), files });
    }
    if (item.type === "agentMessage" && item.text) {
      this.lastAgentText = item.text;
      this.emit({ type: "text", text: item.text });
    }
    if (item.type === "mcpToolCall") {
      this.emit({ type: "tool", name: `${item.server}.${item.tool}`, input: summarizeToolInput(item.arguments) });
    }
    if (item.type === "subAgentActivity") {
      this.emit({ type: "tool", name: "subagent", input: summarizeToolInput(`${item.kind ?? ""} ${item.agentPath ?? ""}`.trim()) });
      if (!item.agentThreadId) return;
      if (item.kind === "started") {
        const description = item.agentPath ?? "";
        if (this.subagents.get(item.agentThreadId)?.description === description) return;
        this.subagents.set(item.agentThreadId, { id: item.agentThreadId, description });
      } else if (item.kind === "completed") {
        if (!this.subagents.delete(item.agentThreadId)) return;
      } else return;
      this.emit({ type: "subagents", running: [...this.subagents.values()] });
    }
    if (item.type === "commandExecution") {
      this.emit({ type: "tool", name: "command", input: summarizeToolInput(item.command ?? "") });
    }
  }

  private handleUserMessage(): void {
    if (!this.turnInputSeen) {
      this.turnInputSeen = true;
      return;
    }
    const steerId = this.undeliveredSteers.shift();
    if (steerId) this.emit({ type: "steer_delivered", steerId });
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
    clearTimeout(request.timer);
    if (rpc.error) request.reject(new Error(rpc.error.message ?? "codex request failed"));
    else request.resolve(rpc.result);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error("codex process is not running"));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex request timed out: ${method}`));
      }, CODEX_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        proc.write(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
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
