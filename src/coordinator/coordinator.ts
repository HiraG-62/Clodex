// Agent 間の routing と lifecycle を決定論的に行う（DESIGN.md §3.9, §12）
import { AGENT_IDS, type AgentAdapter, type AgentId, type TurnResult } from "../agents/agent-adapter.js";
import { buildEnvelope } from "../context/context-resolver.js";
import { createMessage, type CreateMessageResult } from "../protocol/messages.js";
import { AgentMailbox } from "./agent-mailbox.js";
import type { EventBus } from "./event-bus.js";

export interface CoordinatorOptions {
  projectRoot: string;
  agents: Record<AgentId, AgentAdapter>;
  bus: EventBus;
  mcpUrlFor: (agent: AgentId) => string;
  models?: Partial<Record<AgentId, string>>;
  createMessageId?: () => string;
}

export class Coordinator {
  private readonly mailboxes: Record<AgentId, AgentMailbox>;

  constructor(private readonly options: CoordinatorOptions) {
    const { agents, bus, projectRoot, mcpUrlFor, models } = options;
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

    bus.publish({ kind: "message", message: result.message });
    // ACK は記録のみ。配送して Agent を起こさない（DESIGN.md §12, §25）
    if (result.message.type !== "ACK") {
      void this.mailboxes[result.message.to].enqueue(buildEnvelope(result.message));
    }
    return result;
  }

  sendToAgent(id: AgentId, text: string): Promise<TurnResult> {
    return this.mailboxes[id].enqueue(text);
  }

  async stop(): Promise<void> {
    for (const id of AGENT_IDS) this.mailboxes[id].close();
    await Promise.all(AGENT_IDS.map((id) => this.options.agents[id].stop()));
  }
}
