// テスト用: AgentAdapter の偽物。start / send を記録し、ターン完了をテストから制御する
import type {
  AgentAdapter, AgentEvent, AgentEventHandler, AgentId, AgentStartOptions, AgentStatus, PermissionLevel, TurnResult,
} from "./agent-adapter.js";

export class FakeAgentAdapter implements AgentAdapter {
  status: AgentStatus = "stopped";
  sessionId: string | undefined;
  permission: PermissionLevel = "edit";
  model: string | undefined;
  effort: string | undefined;
  readonly starts: AgentStartOptions[] = [];
  readonly sent: string[] = [];
  compacts = 0;
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

  readonly sentImages: Array<readonly string[]> = [];
  send(text: string, images: readonly string[] = []): Promise<TurnResult> {
    if (images.length) this.sentImages.push(images);
    if (this.status !== "idle") return Promise.reject(new Error(`${this.id} is ${this.status}`));
    this.sent.push(text);
    this.status = "busy";
    return new Promise((resolve) => (this.resolveTurn = resolve));
  }

  compact(): Promise<TurnResult> {
    if (this.status !== "idle") return Promise.reject(new Error(`${this.id} is ${this.status}`));
    this.compacts++;
    this.status = "busy";
    return new Promise((resolve) => (this.resolveTurn = resolve));
  }

  completeTurn(result: TurnResult = { status: "completed", text: "ok" }): void {
    const resolve = this.resolveTurn;
    this.resolveTurn = undefined;
    if (this.status === "busy") this.status = "idle";
    resolve?.(result);
  }

  readonly steered: string[] = [];
  readonly steerIds: string[] = [];
  async steer(text: string, steerId: string): Promise<boolean> {
    if (this.status !== "busy") return false;
    this.steered.push(text);
    this.steerIds.push(steerId);
    return true;
  }

  async interrupt(): Promise<void> {}

  async setPermission(level: PermissionLevel): Promise<void> {
    this.permission = level;
  }
  async setModel(model: string): Promise<TurnResult | void> {
    this.model = model;
  }
  async setEffort(level: string): Promise<TurnResult | void> {
    this.effort = level;
  }

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
