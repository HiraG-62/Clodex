import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import type { AgentProcess, SpawnAgentProcess } from "../agents/agent-process.js";

const CONNECT_TIMEOUT = 30_000;
const HEARTBEAT_MS = 10_000;
const MAX_FRAME = 16 * 1024 * 1024;
export class BrokerExitError extends Error {
  constructor(command: string, readonly code: number | null) { super(`broker 実行失敗: ${command} (${code})`); }
}
export interface BrokerConnection {
  spawn: SpawnAgentProcess;
  run(command: string, args: string[], cwd: string, timeoutMs?: number): Promise<string>;
  close(): Promise<void>;
}
export interface BrokerLauncher {
  launch(port: number, token: string): Promise<() => Promise<void>>;
}
interface Child {
  resolve(): void;
  reject(error: Error): void;
  data(data: Buffer): void;
  exit(code: number | null): void;
}

export async function connectBroker(launcher: BrokerLauncher): Promise<BrokerConnection> {
  const token = randomBytes(32).toString("hex");
  const server = createServer();
  const candidates = new Set<Socket>();
  const children = new Map<number, Child>();
  let socket: Socket | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let timer: NodeJS.Timeout | undefined;
  let sequence = 0;
  const send = (value: unknown) => {
    if (!socket || socket.destroyed) throw new Error("broker 切断済み");
    socket.write(`${JSON.stringify(value)}\n`);
  };
  const finishChildren = () => {
    for (const child of children.values()) { child.reject(new Error("broker 接続終了")); child.exit(null); }
    children.clear();
  };
  const close = async () => {
    clearTimeout(timer);
    clearInterval(heartbeat);
    if (socket && !socket.destroyed) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, CONNECT_TIMEOUT);
        socket!.once("close", () => { clearTimeout(timeout); resolve(); });
        socket!.end(`${JSON.stringify({ type: "close" })}\n`);
      });
    }
    for (const candidate of candidates) candidate.destroy();
    finishChildren();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup?.();
  };
  try {
    const connected = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("broker 接続タイムアウト")), CONNECT_TIMEOUT);
      server.on("error", reject);
      server.on("connection", (candidate) => {
        candidates.add(candidate);
        candidate.setTimeout(CONNECT_TIMEOUT, () => candidate.destroy());
        candidate.on("error", () => {});
        candidate.on("close", () => { candidates.delete(candidate); if (candidate === socket) finishChildren(); });
        let received = 0;
        candidate.on("data", (data: Buffer) => { received += data.length; if (received > MAX_FRAME) candidate.destroy(); if (data.includes(10)) received = 0; });
        createInterface({ input: candidate }).on("error", () => candidate.destroy()).on("line", (line) => {
          let message: Record<string, unknown>;
          try {
            const raw: unknown = JSON.parse(line);
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("frame");
            message = raw as Record<string, unknown>;
          } catch { candidate.destroy(); return; }
          if (candidate !== socket) {
            const supplied = Buffer.from(typeof message.token === "string" ? message.token : "");
            if (socket || message.type !== "hello" || supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) { candidate.destroy(); return; }
            socket = candidate;
            clearTimeout(timer);
            send({ type: "welcome", token });
            resolve();
            return;
          }
          const child = children.get(Number(message.id));
          if (!child) return;
          if (message.type === "spawn") child.resolve();
          if (message.type === "error") child.reject(new Error(String(message.message)));
          if (message.type === "stdout" && typeof message.data === "string") child.data(Buffer.from(message.data, "base64"));
          if (message.type === "exit") { child.exit(typeof message.code === "number" ? message.code : null); children.delete(Number(message.id)); }
        });
      });
    });
    void connected.catch(() => {});
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("broker ポートなし");
    cleanup = await launcher.launch(address.port, token);
    await connected;
    heartbeat = setInterval(() => { if (socket && !socket.destroyed) send({ type: "ping" }); }, HEARTBEAT_MS);
    const spawn: SpawnAgentProcess = (command, args, { cwd, env }): AgentProcess => {
      const id = ++sequence;
      let resolve!: () => void, reject!: (error: Error) => void;
      const spawned = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
      void spawned.catch(() => {});
      const lines: Array<(line: string) => void> = [];
      const exits: Array<(code: number | null) => void> = [];
      const decoder = new StringDecoder("utf8");
      let buffered = "", finished = false;
      const flush = () => {
        let end: number;
        while ((end = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, end).replace(/\r$/, ""); buffered = buffered.slice(end + 1);
          for (const handler of lines) handler(line);
        }
      };
      children.set(id, { resolve, reject,
        data: (data) => { buffered += decoder.write(data); flush(); },
        exit: (code) => {
          if (finished) return;
          finished = true;
          reject(new Error(`broker 子プロセス終了: ${code}`));
          buffered += decoder.end(); flush();
          if (buffered) for (const handler of lines) handler(buffered);
          for (const handler of exits) handler(code);
        },
      });
      try { send({ type: "start", id, command, args, cwd, agent: env.CLODEX_AGENT }); }
      catch (error) { children.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
      return { spawned, write: (line) => { if (!finished) send({ type: "write", id, data: `${line}\n` }); }, onLine: (handler) => { lines.push(handler); }, onExit: (handler) => { exits.push(handler); }, kill: () => { if (!finished && socket && !socket.destroyed) send({ type: "kill", id }); } };
    };
    const run = async (command: string, args: string[], cwd: string, timeoutMs = CONNECT_TIMEOUT): Promise<string> => {
      const proc = spawn(command, args, { cwd, env: {} });
      try {
        return await new Promise<string>((resolve, reject) => {
          const output: string[] = [];
          const timeout = setTimeout(() => { proc.kill(); reject(new Error("broker 実行タイムアウト")); }, timeoutMs);
          proc.onLine((line) => output.push(line));
          proc.onExit((code) => { clearTimeout(timeout); if (code === 0) resolve(output.join("\n")); else reject(new BrokerExitError(command, code)); });
          proc.spawned.catch((error: unknown) => { clearTimeout(timeout); reject(error); });
        });
      } finally { proc.kill(); }
    };
    return { spawn, run, close };
  } catch (error) { await close(); throw error; }
}
