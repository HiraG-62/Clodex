// Coordinator 内の observable event を集約する in-memory bus（DESIGN.md §17）
import type { AgentEvent, AgentId } from "../agents/agent-adapter.js";
import type { AgentMessage } from "../protocol/messages.js";
import type { UserQuestion } from "../protocol/questions.js";

export type CoordinatorEventInput =
  | { kind: "agent"; agent: AgentId; event: AgentEvent; handoff?: true; inputIds?: string[] }
  | { kind: "message"; message: AgentMessage }
  | { kind: "retry"; to: AgentId; messageId: string; attempt: number }
  | { kind: "human"; agent: AgentId; text: string; inputId?: string; steer?: boolean; steerId?: string; nextRound?: true } // steer: 実行中のターンに足した
  | { kind: "canceled"; id: string; agent?: AgentId; text?: string }
  | { kind: "steered"; inputId: string; steerId: string }
  | { kind: "brainstormReleased"; inputId: string }
  | { kind: "question"; id: string; agent: AgentId; questions: UserQuestion[] }
  | { kind: "answer"; id: string; agent: AgentId; answers: string[][] }
  | { kind: "notice"; text: string; level?: "warn"; limitHold?: { agent: AgentId; time: string } }
  | { kind: "brainstorm"; phase: "round" | "summary"; round?: number; total: number; artifact?: string };

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
