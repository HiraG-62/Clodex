// Agent ごとの FIFO キュー。人間の入力と formal message を直列に送る（DESIGN.md §12 配送ルール）
import type { AgentAdapter, AgentStartOptions, TurnResult } from "../agents/agent-adapter.js";
import type { AgentMessage } from "../protocol/messages.js";

const CLOSED_RESULT: TurnResult = { status: "failed", text: "mailbox is closed" };

interface QueueItem {
  text: string;
  message: AgentMessage | undefined; // 人間の入力なら undefined
  resolve: (result: TurnResult) => void;
}

export class AgentMailbox {
  private readonly queue: QueueItem[] = [];
  private draining = false;
  private closed = false;
  private idleWaiters: Array<() => void> = [];
  // 配送中のターンが処理している message。Budget の chain 追跡に使う（DESIGN.md §14）
  current: AgentMessage | undefined;

  constructor(
    private readonly agent: AgentAdapter,
    private readonly startOptions: AgentStartOptions,
    private readonly onError: (message: string) => void,
  ) {}

  // 失敗しても reject せず failed の TurnResult を返す（呼び出し側は待たずに投げてよい）
  enqueue(text: string, message?: AgentMessage): Promise<TurnResult> {
    if (this.closed) return Promise.resolve(CLOSED_RESULT);
    const result = new Promise<TurnResult>((resolve) => this.queue.push({ text, message, resolve }));
    void this.drain();
    return result;
  }

  get isIdle(): boolean {
    return !this.draining && this.queue.length === 0;
  }

  // キューが空になり配送中のターンも終わったら resolve する
  whenIdle(): Promise<void> {
    if (this.isIdle) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  // 未配送分を破棄し、以後は Agent を起動しない（停止中の再起動を防ぐ）
  close(): void {
    this.closed = true;
    for (const item of this.queue.splice(0)) item.resolve(CLOSED_RESULT);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    for (let item = this.queue.shift(); item; item = this.queue.shift()) {
      this.current = item.message;
      const result = await this.deliver(item.text);
      this.current = undefined;
      item.resolve(result);
    }
    this.draining = false;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private async deliver(text: string): Promise<TurnResult> {
    try {
      await this.ensureRunning();
      return await this.agent.send(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onError(message);
      return { status: "failed", text: message };
    }
  }

  // Lazy Delegation: 必要になったときに起動し、以前の session があれば resume する
  private async ensureRunning(): Promise<void> {
    if (this.agent.status !== "stopped") return;
    const { sessionId } = this.agent;
    await this.agent.start({ ...this.startOptions, ...(sessionId ? { resumeSessionId: sessionId } : {}) });
  }
}
