// Agent ごとの FIFO キュー。人間の入力と formal message を直列に送る（DESIGN.md §12 配送ルール）
import type { AgentAdapter, AgentStartOptions, TurnResult } from "../agents/agent-adapter.js";
import type { AgentMessage } from "../protocol/messages.js";
import type { RecoveryItem } from "../project/recovery-store.js";

const CLOSED_RESULT: TurnResult = { status: "failed", text: "mailbox is closed" };
const CANCELED_RESULT: TurnResult = { status: "interrupted", text: "canceled before delivery" };

interface QueueItem {
  kind: "send" | "compact" | "model" | "effort";
  text: string;
  message: AgentMessage | undefined; // 人間の入力・compact なら undefined
  inputId?: string; // 人間の入力の ID（取り消しに使う）
  images?: readonly string[]; // 人間の入力に添えた画像（実パス）
  suffix?: string; // 配送するときだけ本文の末尾に足す（送信待ちの表示には出さない）
  context?: true;
  resolve: (result: TurnResult) => void;
}

export interface EnqueueOptions {
  message?: AgentMessage;
  inputId?: string;
  images?: readonly string[];
  suffix?: string;
  context?: true;
}

// 上限で止まったときに配送を止めて待つ（DESIGN.md 上限での停止と自動再開）
export interface LimitHold { resumeAt: number; text: string }

export class AgentMailbox {
  private readonly queue: QueueItem[] = [];
  private draining = false;
  private paused = false;
  private closed = false;
  // /resume で選ばれた session。次回の起動で一度だけ使う（sessionId が undefined なら新しい session）
  private nextSession: { sessionId: string | undefined } | undefined;
  private idleWaiters: Array<() => void> = [];
  // 配送中のターンが処理している message。Budget の chain 追跡に使う（DESIGN.md §14）
  current: AgentMessage | undefined;
  private activeSend = false;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private resumeAt: number | undefined;

  constructor(
    private readonly agent: AgentAdapter,
    // 起動のたびに呼ぶ（役割の変更などを次の起動に反映する。DESIGN.md §28 E）
    private readonly startOptions: () => AgentStartOptions,
    private readonly onError: (message: string) => void,
    private readonly onChange: () => void = () => {},
    private readonly assertStart: () => void = () => {},
    // 送ったターンが失敗したときに呼ぶ。上限で止まったなら再開の時刻と続きの指示を返す
    private readonly limitHold: () => LimitHold | undefined = () => undefined,
    private readonly deliveryNote: () => string = () => "",
  ) {}

  // 失敗しても reject せず failed の TurnResult を返す（呼び出し側は待たずに投げてよい）
  enqueue(text: string, { message, inputId, images, suffix, context }: EnqueueOptions = {}): Promise<TurnResult> {
    if (this.closed) return Promise.resolve(CLOSED_RESULT);
    return this.push({
      kind: "send", text, message, ...(inputId ? { inputId } : {}), ...(images?.length ? { images } : {}), ...(suffix ? { suffix } : {}), ...(context ? { context } : {}),
    });
  }

  // 配送待ちの人間の入力（配送中のものは含まない）
  get pendingInputs(): Array<{ id: string; text: string }> {
    return this.queue.flatMap((item) => (item.inputId ? [{ id: item.inputId, text: item.text }] : []));
  }

  get pendingMessages(): AgentMessage[] {
    return this.queue.flatMap((item) => item.message ? [item.message] : []);
  }

  get holdUntil(): string | undefined {
    return this.resumeAt === undefined ? undefined : new Date(this.resumeAt).toISOString();
  }

  get recoveryQueue(): RecoveryItem[] {
    return this.queue.flatMap((item): RecoveryItem[] => {
      if (item.message) return [{ kind: "message", message: item.message }];
      if (item.inputId) return [{ kind: "input", text: item.text, ...(item.images ? { images: [...item.images] } : {}), ...(item.context ? { context: true } : {}) }];
      return [];
    });
  }

  get activeSending(): boolean { return this.activeSend; }

  get isClosed(): boolean { return this.closed; }

  get holding(): boolean { return this.holdTimer !== undefined; }

  holdForLimit(hold: LimitHold): void {
    if (this.closed || this.holding) return;
    this.hold(hold);
    this.onChange();
  }

  // 待つのをやめて配送を再開する（続きの指示は積まない）
  releaseHold(): void {
    if (!this.holdTimer) return;
    clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    this.resumeAt = undefined;
    this.resume();
  }

  private hold({ resumeAt, text }: LimitHold): void {
    this.paused = true;
    this.resumeAt = resumeAt;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = undefined;
      this.resumeAt = undefined;
      if (this.closed) return;
      this.queue.unshift({ kind: "send", text, message: undefined, resolve: () => {} });
      this.resume();
    }, Math.max(0, resumeAt - Date.now()));
    this.holdTimer.unref?.();
  }

  // 配送待ちの人間の入力を取り消し、本文を返す。配送済み・無いなら undefined
  cancel(id: string): string | AgentMessage | undefined {
    const index = this.queue.findIndex((item) => item.inputId === id || item.message?.id === id);
    const [item] = index < 0 ? [] : this.queue.splice(index, 1);
    if (!item) return undefined;
    item.resolve(CANCELED_RESULT);
    this.onChange();
    this.resolveIdleIfDone();
    return item.message ?? item.text;
  }

  // 配送待ちの formal message を破棄して返す（/interrupt。人間の入力は残す）
  discardMessages(): AgentMessage[] {
    const discarded = this.queue.filter((item) => item.message);
    this.queue.splice(0, this.queue.length, ...this.queue.filter((item) => !item.message));
    for (const item of discarded) item.resolve(CANCELED_RESULT);
    if (discarded.length) this.onChange();
    this.resolveIdleIfDone();
    return discarded.flatMap((item) => (item.message ? [item.message] : []));
  }

  private resolveIdleIfDone(): void {
    if (this.isIdle) for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  // compact も 1 ターンなので、送信と同じキューで直列に扱う
  enqueueCompact(): Promise<TurnResult> {
    if (this.closed) return Promise.resolve(CLOSED_RESULT);
    return this.push({ kind: "compact", text: "", message: undefined });
  }

  enqueueModel(model: string): Promise<TurnResult> {
    if (this.closed) return Promise.resolve(CLOSED_RESULT);
    return this.push({ kind: "model", text: model, message: undefined });
  }

  enqueueEffort(level: string): Promise<TurnResult> {
    if (this.closed) return Promise.resolve(CLOSED_RESULT);
    return this.push({ kind: "effort", text: level, message: undefined });
  }

  private push(item: Omit<QueueItem, "resolve">): Promise<TurnResult> {
    const result = new Promise<TurnResult>((resolve) => this.queue.push({ ...item, resolve }));
    this.onChange();
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

  switchSession(sessionId: string | undefined): void {
    this.nextSession = { sessionId };
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    void this.drain();
  }

  // 未配送分を破棄し、以後は Agent を起動しない（停止中の再起動を防ぐ）
  close(): void {
    this.closed = true;
    clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    this.resumeAt = undefined;
    for (const item of this.queue.splice(0)) item.resolve(CLOSED_RESULT);
    if (!this.draining) for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private async drain(): Promise<void> {
    if (this.draining || this.paused) return;
    this.draining = true;
    try {
      for (let item = this.queue.shift(); item; item = this.paused ? undefined : this.queue.shift()) {
        this.activeSend = item.kind === "send";
        this.current = item.message;
        this.onChange();
        try {
          const result = item.kind === "compact" ? await this.compact()
            : item.kind === "model" || item.kind === "effort" ? await this.setting(item.kind, item.text)
              : await this.deliver(`${item.text}${item.suffix ?? ""}`, item.images);
          item.resolve(result);
          const hold = item.kind === "send" && result.status === "failed" ? this.limitHold() : undefined;
          if (hold) this.hold(hold);
        } finally {
          this.current = undefined;
          this.activeSend = false;
          this.onChange();
        }
      }
    } finally {
      this.draining = false;
      if (this.isIdle) for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  // 停止中の Agent を compact のためだけに起動しない
  private async compact(): Promise<TurnResult> {
    if (this.agent.status === "stopped") return { status: "failed", text: `${this.agent.id} is not running` };
    try {
      return await this.agent.compact();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onError(message);
      return { status: "failed", text: message };
    }
  }

  private async deliver(text: string, images?: readonly string[]): Promise<TurnResult> {
    try {
      await this.ensureRunning();
      return await this.agent.send(`${text}${this.deliveryNote()}`, images);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onError(message);
      return { status: "failed", text: message };
    }
  }

  private async setting(kind: "model" | "effort", value: string): Promise<TurnResult> {
    try {
      // 停止中は次の起動時に使う。Claude は slash command のターン、Codex は値の保持で反映する。
      const result = kind === "model" ? await this.agent.setModel(value) : await this.agent.setEffort(value);
      return result ?? { status: "completed", text: "" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onError(message);
      return { status: "failed", text: message };
    }
  }

  // Lazy Start: 必要になったときに起動し、以前の session があれば resume する。
  // 一度起動した後は Agent の session を、初回は startOptions の resumeSessionId（clodex --resume）を使う
  // 起動中は今の session、停止中は次の起動で使う session（undefined なら新規）
  get sessionId(): string | undefined {
    if (this.agent.status !== "stopped") return this.agent.sessionId;
    return this.nextSession
      ? this.nextSession.sessionId
      : (this.agent.sessionId ?? this.startOptions().resumeSessionId);
  }

  async ensureRunning(): Promise<void> {
    if (this.agent.status !== "stopped") return;
    this.assertStart();
    const resumeSessionId = this.sessionId;
    const { resumeSessionId: _initial, ...options } = this.startOptions();
    await this.agent.start({ ...options, ...(resumeSessionId ? { resumeSessionId } : {}) });
    // 起動に失敗したら次の試行でも選んだ session を使う
    this.nextSession = undefined;
  }
}
