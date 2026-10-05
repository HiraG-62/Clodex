// Agent 間の routing と lifecycle を決定論的に行う（DESIGN.md §3.9, §12）
import {
  AGENT_IDS, type AgentAdapter, type AgentId, type AgentStatus, type PermissionLevel, type TurnResult,
} from "../agents/agent-adapter.js";
import { buildEnvelope } from "../context/context-resolver.js";
import { createMessage, type CreateMessageResult } from "../protocol/messages.js";
import { AgentMailbox } from "./agent-mailbox.js";
import { BudgetManager, type BudgetLimits } from "./budget-manager.js";
import { DEFAULT_USAGE_ALERT, UsageMonitor, type UsageAlert, type UsageSnapshot } from "./usage-monitor.js";
import type { EventBus } from "./event-bus.js";

// 起動時の Agent の設定（DESIGN.md §9 Agent の設定の保存）
export interface AgentStartSettings {
  permission?: PermissionLevel;
  model?: string;
  effort?: string;
}

export interface CoordinatorOptions {
  projectRoot: string;
  agents: Record<AgentId, AgentAdapter>;
  bus: EventBus;
  mcpUrlFor: (agent: AgentId) => string;
  instructions?: Partial<Record<AgentId, string>>;
  createMessageId?: () => string;
  limits?: BudgetLimits;
  settings?: Partial<Record<AgentId, AgentStartSettings>>;
  usageAlert?: Partial<UsageAlert>;
  // clodex --resume: 各 Agent の最初の起動で継続する session（DESIGN.md §18）
  resumeSessionIds?: Partial<Record<AgentId, string>>;
}

export class Coordinator {
  private readonly mailboxes: Record<AgentId, AgentMailbox>;
  private readonly budget: BudgetManager;
  private readonly usage: UsageMonitor;

  constructor(private readonly options: CoordinatorOptions) {
    const { agents, bus, projectRoot, mcpUrlFor, instructions, limits, settings } = options;
    this.budget = new BudgetManager(limits);
    this.usage = new UsageMonitor(bus, { ...DEFAULT_USAGE_ALERT, ...options.usageAlert });
    for (const id of AGENT_IDS) {
      agents[id].onEvent((event) => bus.publish({ kind: "agent", agent: id, event }));
      // 起動前なので値を保持するだけ（次の起動時に使われる）
      const { permission, model, effort } = settings?.[id] ?? {};
      if (permission) void agents[id].setPermission(permission);
      if (model) void agents[id].setModel(model);
      if (effort) void agents[id].setEffort(effort);
    }
    const createMailbox = (id: AgentId) => {
      const instruction = instructions?.[id];
      const resumeSessionId = options.resumeSessionIds?.[id];
      return new AgentMailbox(
        agents[id],
        {
          cwd: projectRoot, mcpUrl: mcpUrlFor(id),
          ...(instruction ? { instructions: instruction } : {}),
          ...(resumeSessionId ? { resumeSessionId } : {}),
        },
        (message) => bus.publish({ kind: "agent", agent: id, event: { type: "error", message } }),
      );
    };
    this.mailboxes = { claude: createMailbox("claude"), codex: createMailbox("codex") };
  }

  // MCP の send_message から呼ばれる。検証・記録・配送を行い、受理結果を送信元へ返す
  receiveMessage(from: AgentId, input: unknown): CreateMessageResult {
    const { projectRoot, bus, createMessageId } = this.options;
    const result = createMessage(input, {
      from, repository: projectRoot, ...(createMessageId ? { createId: createMessageId } : {}),
    });
    if (!result.ok) return result;
    const { message } = result;

    // 送信元が処理中の message を親として chain を決める（DESIGN.md §14）
    const budgetError = this.budget.admit(message, this.mailboxes[from].current);
    if (budgetError) {
      bus.publish({ kind: "agent", agent: from, event: { type: "error", message: budgetError } });
      return { ok: false, error: budgetError };
    }

    bus.publish({ kind: "message", message });
    // ACK は記録のみ。配送して Agent を起こさない（DESIGN.md §12, §25）
    if (message.type !== "ACK") void this.mailboxes[message.to].enqueue(buildEnvelope(message), message);
    return result;
  }

  sendToAgent(id: AgentId, text: string): Promise<TurnResult> {
    this.options.bus.publish({ kind: "human", agent: id, text });
    return this.mailboxes[id].enqueue(text);
  }

  // 全 Agent の配送が終わるまで待つ。配送中のターンが相手へ message を送ることがあるので、全員が同時に空になるまで繰り返す
  async whenIdle(): Promise<void> {
    while (!AGENT_IDS.every((id) => this.mailboxes[id].isIdle)) {
      await Promise.all(AGENT_IDS.map((id) => this.mailboxes[id].whenIdle()));
    }
  }

  // /resume・/new: targets の Agent を止め、次回はそれぞれ指定の session（無ければ新規）で起動する。拒否したら理由を返す
  async switchSessions(
    sessions: Partial<Record<AgentId, string>>, targets: readonly AgentId[] = AGENT_IDS,
  ): Promise<string | undefined> {
    // 起動中や配送待ちも含めて、受け付けた作業がある Agent は止めない
    const busy = targets.filter((id) => this.options.agents[id].status === "busy" || !this.mailboxes[id].isIdle);
    if (busy.length) return `${busy.join(", ")} is busy. Use /interrupt first.`;
    for (const id of targets) this.mailboxes[id].pause();
    try {
      await Promise.all(targets.map((id) => this.options.agents[id].stop()));
      for (const id of targets) {
        this.mailboxes[id].switchSession(sessions[id]);
        this.usage.clearContext(id);
      }
    } finally {
      for (const id of targets) this.mailboxes[id].resume();
    }
    return undefined;
  }

  // 省略時は起動中の Agent だけ（停止中の Agent は compact するものが無い）
  compact(id?: AgentId): Promise<TurnResult[]> {
    const targets = id ? [id] : AGENT_IDS.filter((agent) => this.options.agents[agent].status !== "stopped");
    return Promise.all(targets.map((target) => this.mailboxes[target].enqueueCompact()));
  }

  async interrupt(id?: AgentId): Promise<void> {
    const targets = id ? [id] : AGENT_IDS;
    await Promise.all(targets.map((target) => this.options.agents[target].interrupt()));
  }

  async setPermission(level: PermissionLevel, id?: AgentId): Promise<void> {
    const targets = id ? [id] : AGENT_IDS;
    await Promise.all(targets.map((target) => this.options.agents[target].setPermission(level)));
  }

  async setModel(model: string, id: AgentId): Promise<TurnResult | void> {
    return this.mailboxes[id].enqueueModel(model);
  }

  async setEffort(level: string, id?: AgentId): Promise<TurnResult | void> {
    if (id) return this.mailboxes[id].enqueueEffort(level);
    const results = await Promise.all(AGENT_IDS.map((agent) => this.mailboxes[agent].enqueueEffort(level)));
    return results.find((result) => result.status === "failed") ?? results[0];
  }

  status(): Array<{
    id: AgentId; status: AgentStatus; sessionId: string | undefined; permission: PermissionLevel;
    model: string | undefined; effort: string | undefined; usage: UsageSnapshot;
  }> {
    return AGENT_IDS.map((id) => {
      const { status, permission, model, effort } = this.options.agents[id];
      return { id, status, sessionId: this.mailboxes[id].sessionId, permission, model, effort, usage: this.usage.snapshot(id) };
    });
  }

  async stop(): Promise<void> {
    for (const id of AGENT_IDS) this.mailboxes[id].close();
    await Promise.all(AGENT_IDS.map((id) => this.options.agents[id].stop()));
  }
}
