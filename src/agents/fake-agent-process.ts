// テスト用: AgentProcess の偽物。書き込まれた JSON を記録し、任意の行を流せる
import type { AgentProcess, SpawnAgentProcess, SpawnOptions } from "./agent-process.js";

export type JsonObject = Record<string, unknown>;
type Responder = (message: JsonObject) => unknown;

export class FakeAgentProcess implements AgentProcess {
  readonly written: JsonObject[] = [];
  spawned: Promise<void> = Promise.resolve();
  killed = false;
  private lineHandlers: Array<(line: string) => void> = [];
  private exitHandlers: Array<(code: number | null) => void> = [];

  // JSON-RPC request（id + method）に対する result を返す。undefined なら応答しない
  constructor(private readonly responder?: Responder, private readonly exitOnKill = true) {}

  write(line: string): void {
    const message = JSON.parse(line) as JsonObject;
    this.written.push(message);
    if (!this.responder || message.id === undefined || message.method === undefined) return;
    const result = this.responder(message);
    if (result !== undefined) queueMicrotask(() => this.emit({ id: message.id, result }));
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandlers.push(handler);
  }

  onExit(handler: (code: number | null) => void): void {
    this.exitHandlers.push(handler);
  }

  kill(): void {
    this.killed = true;
    if (this.exitOnKill) this.exit(null);
  }

  emit(message: JsonObject): void {
    this.emitRaw(JSON.stringify(message));
  }

  emitRaw(line: string): void {
    for (const handler of this.lineHandlers) handler(line);
  }

  exit(code: number | null): void {
    for (const handler of this.exitHandlers) handler(code);
  }

  writtenWith(key: string, value: unknown): JsonObject[] {
    return this.written.filter((m) => m[key] === value);
  }
}

export interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
}

export interface FakeSpawnerOptions {
  spawnError?: Error;     // 実行ファイルが無い等の起動失敗を再現する
  exitOnKill?: boolean;   // false なら kill しても exit しない（終了待ちの再現用）
}

export const createFakeSpawner = (responder?: Responder, { spawnError, exitOnKill = true }: FakeSpawnerOptions = {}) => {
  const calls: SpawnCall[] = [];
  const processes: FakeAgentProcess[] = [];
  const spawn: SpawnAgentProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const proc = new FakeAgentProcess(responder, exitOnKill);
    processes.push(proc);
    if (spawnError) {
      proc.spawned = Promise.reject(spawnError);
      queueMicrotask(() => proc.exit(null));
    }
    return proc;
  };
  return { spawn, calls, processes, get last(): FakeAgentProcess { return processes.at(-1)!; } };
};

export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
