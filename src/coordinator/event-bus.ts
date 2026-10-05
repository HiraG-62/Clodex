// Coordinator 内の observable event を集約する in-memory bus（DESIGN.md §17）
import type { AgentEvent, AgentId } from "../agents/agent-adapter.js";
import type { AgentMessage } from "../protocol/messages.js";

export type CoordinatorEventInput =
  | { kind: "agent"; agent: AgentId; event: AgentEvent }
  | { kind: "message"; message: AgentMessage };

export type CoordinatorEvent = CoordinatorEventInput & { at: string };

export type CoordinatorEventHandler = (event: CoordinatorEvent) => void;

const reportToStderr = (error: unknown) => console.error("[clodex] event subscriber failed:", error);

export class EventBus {
  private readonly handlers = new Set<CoordinatorEventHandler>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly onSubscriberError: (error: unknown) => void = reportToStderr,
  ) {}

  subscribe(handler: CoordinatorEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  publish(input: CoordinatorEventInput): void {
    const event: CoordinatorEvent = { ...input, at: this.now().toISOString() };
    // 配送中の subscribe / unsubscribe に影響されないよう、publish 時点の購読者に配る
    for (const handler of [...this.handlers]) {
      try {
        handler(event);
      } catch (error) {
        this.reportSubscriberError(error);
      }
    }
  }

  // 報告処理自体の失敗でも配送を止めない
  private reportSubscriberError(error: unknown): void {
    try {
      this.onSubscriberError(error);
    } catch {
      // 報告手段が壊れている場合は諦める
    }
  }
}
