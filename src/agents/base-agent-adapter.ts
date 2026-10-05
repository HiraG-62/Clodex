import {
  DEFAULT_PERMISSION,
  type AgentAdapter, type AgentEvent, type AgentEventHandler, type AgentId, type AgentStartOptions, type AgentStatus,
  type PermissionLevel, type TurnResult,
} from "./agent-adapter.js";
import type { AgentProcess } from "./agent-process.js";

// 両 Adapter 共通の status / event / turn / 終了処理。CLI 固有のプロトコルはサブクラスが扱う
export abstract class BaseAgentAdapter implements AgentAdapter {
  abstract readonly id: AgentId;
  status: AgentStatus = "stopped";
  sessionId: string | undefined;
  permission: PermissionLevel = DEFAULT_PERMISSION;
  // 起動に使った権限レベル。起動中に変更されたら起動完了時に差分を反映する
  protected launchPermission: PermissionLevel = DEFAULT_PERMISSION;

  protected proc: AgentProcess | undefined;
  private readonly handlers = new Set<AgentEventHandler>();
  private resolveTurn: ((result: TurnResult) => void) | undefined;
  private spontaneousTurn: Promise<TurnResult> | undefined;
  private stopping: Promise<void> | undefined;
  private resolveStop: (() => void) | undefined;

  abstract start(options: AgentStartOptions): Promise<void>;
  abstract interrupt(): Promise<void>;
  // 起動中の Agent に権限レベルの変更を反映する（CLI 固有）
  protected abstract applyPermission(level: PermissionLevel): Promise<void>;

  async setPermission(level: PermissionLevel): Promise<void> {
    this.permission = level;
    if (this.proc && this.status !== "starting") await this.applyPermission(level);
  }

  // サブスクラスが起動完了時に呼ぶ
  protected async applyPermissionChangedDuringStart(): Promise<void> {
    if (this.permission !== this.launchPermission) await this.applyPermission(this.permission);
  }
  protected abstract handleMessage(message: unknown): void;
  protected abstract writeTurn(text: string): void;
  protected abstract writeCompact(): void;

  onEvent(handler: AgentEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  send(text: string): Promise<TurnResult> {
    return this.beginTurn(() => this.writeTurn(text));
  }

  compact(): Promise<TurnResult> {
    return this.beginTurn(() => this.writeCompact());
  }

  private beginTurn(write: () => void): Promise<TurnResult> {
    if (this.spontaneousTurn) return this.spontaneousTurn.then(() => this.beginTurn(write));
    if (this.status !== "idle") return Promise.reject(new Error(`${this.id} is ${this.status}`));
    this.status = "busy";
    this.emit({ type: "turn_started" });
    const turn = new Promise<TurnResult>((resolve) => (this.resolveTurn = resolve));
    write();
    return turn;
  }

  protected beginSpontaneousTurn(): void {
    if (this.status !== "idle") return;
    this.status = "busy";
    this.spontaneousTurn = new Promise<TurnResult>((resolve) => (this.resolveTurn = resolve));
    this.emit({ type: "turn_started" });
  }

  stop(): Promise<void> {
    if (!this.proc) return Promise.resolve();
    // 複数の呼び出し元が同じ終了を待てるよう、停止中の Promise を共有する
    this.stopping ??= new Promise<void>((resolve) => {
      this.resolveStop = resolve;
      this.proc?.kill();
    });
    return this.stopping;
  }

  protected emit(event: AgentEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  protected attach(proc: AgentProcess): void {
    this.proc = proc;
    proc.onLine((line) => this.handleLine(line));
    proc.onExit((code) => this.handleExit(code));
  }

  protected finishTurn(result: TurnResult): void {
    const resolve = this.resolveTurn;
    if (!resolve) return;
    this.resolveTurn = undefined;
    this.spontaneousTurn = undefined;
    if (this.status === "busy") this.status = "idle";
    this.emit({ type: "turn", result });
    resolve(result);
  }

  // 認証違反など継続してはいけない状態。ターンを失敗させてプロセスを止める
  protected abort(message: string): void {
    this.emit({ type: "error", message });
    this.finishTurn({ status: "failed", text: message });
    this.proc?.kill();
  }

  protected handleExit(code: number | null): void {
    this.proc = undefined;
    this.status = "stopped";
    this.finishTurn({ status: "failed", text: `${this.id} process exited (code ${code})` });
    this.emit({ type: "exit", code });
    this.resolveStop?.();
    this.resolveStop = undefined;
    this.stopping = undefined;
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit({ type: "error", message: `${this.id}: invalid JSON line: ${line.slice(0, 200)}` });
      return;
    }
    this.handleMessage(message);
  }
}
