// テスト用: AgentAdapter の偽物。start / send を記録し、ターン完了をテストから制御する
import type {
  AgentAdapter, AgentEvent, AgentEventHandler, AgentId, AgentStartOptions, AgentStatus, TurnResult,
} from "./agent-adapter.js";

export class FakeAgentAdapter implements AgentAdapter {
  status: AgentStatus = "stopped";
  sessionId: string | undefined;
  readonly starts: AgentStartOptions[] = [];
  readonly sent: string[] = [];
  startError: Error | undefined;
  private readonly handlers = new Set<AgentEventHandler>();
  private resolveTurn: ((result: TurnResult) => void) | undefined;

  constructor(readonly id: AgentId) {}

  async start(options: AgentStartOptions): Promise<void> {
    this.starts.push(options);
    if (this.startError) throw this.startError;
    this.sessionId = options.resumeSessionId ?? `${this.id}-session`;
    this.status = "idle";
  }

  send(text: string): Promise<TurnResult> {
    if (this.status !== "idle") return Promise.reject(new Error(`${this.id} is ${this.status}`));
    this.sent.push(text);
    this.status = "busy";
    return new Promise((resolve) => (this.resolveTurn = resolve));
  }

  completeTurn(result: TurnResult = { status: "completed", text: "ok" }): void {
    const resolve = this.resolveTurn;
    this.resolveTurn = undefined;
    if (this.status === "busy") this.status = "idle";
    resolve?.(result);
  }

  async interrupt(): Promise<void> {}

  async stop(): Promise<void> {
    this.status = "stopped";
  }

  onEvent(handler: AgentEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: AgentEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}
