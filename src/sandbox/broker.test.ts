import { connect } from "node:net";
import { createInterface } from "node:readline";
import { expect, it, vi } from "vitest";
import { connectBroker } from "./broker.js";

it("認証後に stdio を中継し、UTF-8 分割・改行・kill・close を扱う", async () => {
  const messages: Array<Record<string, unknown>> = [];
  const cleanup = vi.fn(async () => {});
  let brokerPort = 0;
  const broker = await connectBroker({ launch: async (port, token) => {
    brokerPort = port;
    const denied = connect(port, "127.0.0.1");
    denied.on("error", () => {});
    denied.end(`${JSON.stringify({ type: "hello", token: "wrong" })}\n`);
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => {});
    socket.on("connect", () => socket.write(`${JSON.stringify({ type: "hello", token })}\n`));
    const send = (message: unknown) => socket.write(`${JSON.stringify(message)}\n`);
    createInterface({ input: socket }).on("line", (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      messages.push(message);
      if (message.type === "start") send({ id: message.id, type: "spawn" });
      if (message.type === "write") {
        const data = Buffer.from("日本語\r\n末尾");
        for (const fragment of [data.subarray(0, 2), data.subarray(2)]) send({ type: "stdout", id: message.id, data: fragment.toString("base64") });
      }
      if (message.type === "kill") send({ type: "exit", id: message.id, code: 0 });
      if (message.type === "close") socket.end();
    });
    return cleanup;
  } });
  try {
    await new Promise<void>((resolve, reject) => {
      const extra = connect(brokerPort, "127.0.0.1");
      extra.once("error", () => resolve());
      extra.once("connect", () => { extra.destroy(); reject(new Error("認証後も listen が継続")); });
    });
    const child = broker.spawn("claude", ["--version"], { cwd: "project", env: { OPENAI_API_KEY: "secret", USERPROFILE: "human", CLODEX_AGENT: "claude" } });
    const lines: string[] = [];
    child.onLine((line) => lines.push(line));
    await child.spawned;
    child.write("入力");
    await vi.waitFor(() => expect(lines).toEqual(["日本語"]));
    const exited = new Promise<void>((resolve) => child.onExit(() => resolve()));
    child.kill();
    await exited;
    expect(lines).toEqual(["日本語", "末尾"]);
    expect(messages.find((message) => message.type === "start")).toEqual({ type: "start", id: 1, command: "claude", args: ["--version"], cwd: "project", agent: "claude" });
    expect(messages.find((message) => message.type === "write")?.data).toBe("入力\n");
  } finally { await broker.close(); }
  expect(cleanup).toHaveBeenCalledOnce();
});
