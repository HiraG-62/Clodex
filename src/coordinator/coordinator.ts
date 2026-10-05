// Agent 間の routing と lifecycle を決定論的に行う（DESIGN.md §3.9, §12）
import { AGENT_IDS, type AgentAdapter, type AgentId, type AgentStatus, type TurnResult } from "../agents/agent-adapter.js";
import { buildEnvelope } from "../context/context-resolver.js";
import { createMessage, type CreateMessageResult } from "../protocol/messages.js";
import { AgentMailbox } from "./agent-mailbox.js";
import { BudgetManager, type BudgetLimits } from "./budget-manager.js";
import type { EventBus } from "./event-bus.js";

export interface CoordinatorOptions {
  projectRoot: string;
  agents: Record<AgentId, AgentAdapter>;
  bus: EventBus;
  mcpUrlFor: (agent: AgentId) => string;
  models?: Partial<Record<AgentId, string>>;
  createMessageId?: () => string;
  limits?: BudgetLimits;
}

export class Coordinator {
  private readonly mailboxes: Record<AgentId, AgentMailbox>;
  private readonly budget: BudgetManager;

  constructor(private readonly options: CoordinatorOptions) {
    const { agents, bus, projectRoot, mcpUrlFor, models, limits } = options;
    this.budget = new BudgetManager(limits);
    for (const id of AGENT_IDS) {
      agents[id].onEvent((event) => bus.publish({ kind: "agent", agent: id, event }));
    }
    const createMailbox = (id: AgentId) => {
      const model = models?.[id];
      return new AgentMailbox(
        agents[id],
        { cwd: projectRoot, mcpUrl: mcpUrlFor(id), ...(model ? { model } : {}) },
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
    return this.mailboxes[id].enqueue(text);
  }

  // 全 Agent の配送が終わるまで待つ。配送中のターンが相手へ message を送ることがあるので、全員が同時に空になるまで繰り返す
  async whenIdle(): Promise<void> {
    while (!AGENT_IDS.every((id) => this.mailboxes[id].isIdle)) {
      await Promise.all(AGENT_IDS.map((id) => this.mailboxes[id].whenIdle()));
    }
  }

  async interrupt(id?: AgentId): Promise<void> {
    const targets = id ? [id] : AGENT_IDS;
    await Promise.all(targets.map((target) => this.options.agents[target].interrupt()));
  }

  status(): Array<{ id: AgentId; status: AgentStatus; sessionId: string | undefined }> {
    return AGENT_IDS.map((id) => {
      const { status, sessionId } = this.options.agents[id];
      return { id, status, sessionId };
    });
  }

  async stop(): Promise<void> {
    for (const id of AGENT_IDS) this.mailboxes[id].close();
    await Promise.all(AGENT_IDS.map((id) => this.options.agents[id].stop()));
  }
}
