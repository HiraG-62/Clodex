import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type { AgentProcess, SpawnAgentProcess } from "../agents/agent-process.js";

const CONNECT_TIMEOUT = 30_000;
const HEARTBEAT_MS = 10_000;
const MAX_FRAME = 16 * 1024 * 1024;
const LINE_FEED = 10;
const OUTPUT_TAIL_BYTES = 8 * 1024;
const childId = z.number().int().positive();
const frameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), token: z.string() }),
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("spawn"), id: childId }),
  z.object({ type: z.literal("error"), id: childId, message: z.string() }),
  z.object({ type: z.literal("stdout"), id: childId, data: z.string() }),
  z.object({ type: z.literal("stderr"), id: childId, data: z.string() }),
  z.object({ type: z.literal("exit"), id: childId, code: z.number().int().nullable() }),
]);
export class BrokerExitError extends Error {
  constructor(
    command: string,
    readonly code: number | null,
    diagnostics = "",
  ) {
    super(`broker 実行失敗: ${command} (${code})${diagnostics}`);
  }
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
  data(data: Buffer, stream: "stdout" | "stderr"): void;
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
    for (const child of children.values()) {
      child.reject(new Error("broker 接続終了"));
      child.exit(null);
    }
    children.clear();
  };
  const close = async () => {
    clearTimeout(timer);
    clearInterval(heartbeat);
    if (socket && !socket.destroyed) {
      await new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, CONNECT_TIMEOUT);
        socket!.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
        socket!.end(`${JSON.stringify({ type: "close" })}\n`);
      });
    }
    for (const candidate of candidates) candidate.destroy();
    finishChildren();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await cleanup?.();
  };
  try {
    const connected = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("broker 接続タイムアウト")), CONNECT_TIMEOUT);
      server.on("error", reject);
      server.on("connection", candidate => {
        candidates.add(candidate);
        candidate.setTimeout(CONNECT_TIMEOUT, () => candidate.destroy());
        candidate.on("error", () => {});
        candidate.on("close", () => {
          candidates.delete(candidate);
          if (candidate === socket) finishChildren();
        });
        let received = 0;
        candidate.on("data", (data: Buffer) => {
          received += data.length;
          if (received > MAX_FRAME) candidate.destroy();
          if (data.includes(LINE_FEED)) received = 0;
        });
        createInterface({ input: candidate })
          .on("error", () => candidate.destroy())
          .on("line", line => {
            let message: z.infer<typeof frameSchema>;
            try {
              message = frameSchema.parse(JSON.parse(line));
            } catch {
              candidate.destroy();
              return;
            }
            if (candidate !== socket) {
              const supplied = Buffer.from(message.type === "hello" ? message.token : "");
              if (socket || message.type !== "hello" || supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) {
                candidate.destroy();
                return;
              }
              socket = candidate;
              server.close();
              for (const other of candidates) if (other !== candidate) other.destroy();
              clearTimeout(timer);
              send({ type: "welcome", token });
              resolve();
              return;
            }
            if (!("id" in message)) return;
            const child = children.get(message.id);
            if (!child) return;
            if (message.type === "spawn") child.resolve();
            if (message.type === "error") child.reject(new Error(String(message.message)));
            if (message.type === "stdout" || message.type === "stderr") child.data(Buffer.from(message.data, "base64"), message.type);
            if (message.type === "exit") {
              child.exit(typeof message.code === "number" ? message.code : null);
              children.delete(Number(message.id));
            }
          });
      });
    });
    void connected.catch(() => {});
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("broker ポートなし");
    cleanup = await launcher.launch(address.port, token);
    await connected;
    heartbeat = setInterval(() => {
      if (socket && !socket.destroyed) send({ type: "ping" });
    }, HEARTBEAT_MS);
    const spawn = (command: string, args: string[], { cwd, env }: Parameters<SpawnAgentProcess>[2]): AgentProcess & { diagnostics(): string } => {
      const id = ++sequence;
      let resolve!: () => void, reject!: (error: Error) => void;
      const spawned = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      void spawned.catch(() => {});
      const lines: Array<(line: string) => void> = [];
      const exits: Array<(code: number | null) => void> = [];
      const decoder = new StringDecoder("utf8");
      const tails = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      let buffered = "",
        finished = false;
      const flush = () => {
        let end: number;
        while ((end = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, end).replace(/\r$/, "");
          buffered = buffered.slice(end + 1);
          for (const handler of lines) handler(line);
        }
      };
      children.set(id, {
        resolve,
        reject,
        data: (data, stream) => {
          tails[stream] = Buffer.from(Buffer.concat([tails[stream], data]).subarray(-OUTPUT_TAIL_BYTES));
          if (stream === "stdout") {
            buffered += decoder.write(data);
            flush();
          }
        },
        exit: code => {
          if (finished) return;
          finished = true;
          reject(new Error(`broker 子プロセス終了: ${code}`));
          buffered += decoder.end();
          flush();
          if (buffered) for (const handler of lines) handler(buffered);
          for (const handler of exits) handler(code);
        },
      });
      try {
        send({ type: "start", id, command, args, cwd, agent: env.CLODEX_AGENT });
      } catch (error) {
        children.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
      return {
        spawned,
        diagnostics: () => `\nstdout:\n${tails.stdout.toString("utf8")}\nstderr:\n${tails.stderr.toString("utf8")}`,
        write: line => {
          if (!finished) send({ type: "write", id, data: `${line}\n` });
        },
        onLine: handler => {
          lines.push(handler);
        },
        onExit: handler => {
          exits.push(handler);
        },
        kill: () => {
          if (!finished && socket && !socket.destroyed) send({ type: "kill", id });
        },
      };
    };
    const run = async (command: string, args: string[], cwd: string, timeoutMs = CONNECT_TIMEOUT): Promise<string> => {
      const proc = spawn(command, args, { cwd, env: {} });
      try {
        return await new Promise<string>((resolve, reject) => {
          const output: string[] = [];
          const timeout = setTimeout(() => {
            proc.kill();
            reject(new Error(`broker 実行タイムアウト${proc.diagnostics()}`));
          }, timeoutMs);
          proc.onLine(line => output.push(line));
          proc.onExit(code => {
            clearTimeout(timeout);
            if (code === 0) resolve(output.join("\n"));
            else reject(new BrokerExitError(command, code, proc.diagnostics()));
          });
          proc.spawned.catch((error: unknown) => {
            clearTimeout(timeout);
            reject(new Error(`${error instanceof Error ? error.message : String(error)}${proc.diagnostics()}`));
          });
        });
      } finally {
        proc.kill();
      }
    };
    return { spawn, run, close };
  } catch (error) {
    await close();
    throw error;
  }
}
