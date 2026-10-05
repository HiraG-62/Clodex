import { afterEach, describe, expect, it } from "vitest";
import { DisplayHub } from "./display-hub.js";
import { startWebServer, type WebServerHandle } from "./web-server.js";

const TOKEN = "a".repeat(64);
const COOKIE = `clodex_token=${TOKEN}`;

let server: WebServerHandle | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const setup = async (onInput?: (line: string) => Promise<void>) => {
  const hub = new DisplayHub();
  const inputs: string[] = [];
  const errors: unknown[] = [];
  server = await startWebServer({
    port: 0, token: TOKEN, hub, onInput: onInput ?? (async (line) => void inputs.push(line)), onError: (e) => errors.push(e),
  });
  return { hub, inputs, errors, base: server.url };
};

const postInput = (base: string, body: string | Blob) =>
  fetch(`${base}/api/input`, { method: "POST", headers: { cookie: COOKIE }, body });

// SSE の本文を指定の行数ぶん読む
const readEvents = async (response: Response, count: number): Promise<string[]> => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const lines: string[] = [];
  while (lines.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop()!;
    for (const part of parts) if (part.startsWith("data: ")) lines.push(JSON.parse(part.slice("data: ".length)));
  }
  await reader.cancel();
  return lines;
};

describe("startWebServer", () => {
  it("127.0.0.1 だけで待ち受ける", async () => {
    const { base } = await setup();
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("token が無い・違うリクエストは 401", async () => {
    const { base } = await setup();
    expect((await fetch(`${base}/`)).status).toBe(401);
    expect((await fetch(`${base}/events`, { headers: { cookie: "clodex_token=wrong" } })).status).toBe(401);
    expect((await fetch(`${base}/api/input`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(`${base}/?token=wrong`, { redirect: "manual" })).status).toBe(401);
  });

  it("/?token= で開くと HttpOnly cookie を設定して / へ移動する", async () => {
    const { base } = await setup();
    const response = await fetch(`${base}/?token=${TOKEN}`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toMatch(new RegExp(`^${COOKIE};.*HttpOnly`));
  });

  it("cookie があれば画面を返す", async () => {
    const { base } = await setup();
    const response = await fetch(`${base}/`, { headers: { cookie: COOKIE } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    expect(await response.text()).toContain("/events");
  });

  it("/events は直近の行を送ってから新しい行を流す", async () => {
    const { base, hub } = await setup();
    hub.publish("old line");
    const response = await fetch(`${base}/events`, { headers: { cookie: COOKIE } });
    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
    setTimeout(() => hub.publish("new line"), 50);
    expect(await readEvents(response, 2)).toEqual(["old line", "new line"]);
  });

  it("POST /api/input の行を onInput に渡す", async () => {
    const { base, inputs } = await setup();
    const response = await fetch(`${base}/api/input`, {
      method: "POST", headers: { cookie: COOKIE, "content-type": "application/json" }, body: JSON.stringify({ line: "@codex hi" }),
    });
    expect(response.status).toBe(204);
    expect(inputs).toEqual(["@codex hi"]);
  });

  it("不正な入力は 400", async () => {
    const { base, inputs } = await setup();
    const post = (body: string) => fetch(`${base}/api/input`, { method: "POST", headers: { cookie: COOKIE }, body });
    expect((await post("not json")).status).toBe(400);
    expect((await post(JSON.stringify({ line: 1 }))).status).toBe(400);
    expect(inputs).toEqual([]);
  });

  it("同じ文字数の非 ASCII の token でも落ちずに 401", async () => {
    const { base } = await setup();
    expect((await fetch(`${base}/?token=${encodeURIComponent("あ".repeat(64))}`, { redirect: "manual" })).status).toBe(401);
    expect((await fetch(`${base}/`, { headers: { cookie: COOKIE } })).status).toBe(200);
  });

  it("onInput が失敗したら 500 を返し、サーバーは動き続ける", async () => {
    const { base, errors } = await setup(async () => { throw new Error("interrupt failed"); });
    expect((await postInput(base, JSON.stringify({ line: "/interrupt" }))).status).toBe(500);
    expect(errors).toHaveLength(1);
    expect((await fetch(`${base}/`, { headers: { cookie: COOKIE } })).status).toBe(200);
  });

  it("上限を超える入力は 413 を返す", async () => {
    const { base, inputs } = await setup();
    expect((await postInput(base, JSON.stringify({ line: "x".repeat(70 * 1024) }))).status).toBe(413);
    expect(inputs).toEqual([]);
  });

  it("日本語の入力を化けさせずに渡す", async () => {
    const { base, inputs } = await setup();
    const line = "日本語の依頼🎌".repeat(2000);
    expect((await postInput(base, new Blob([JSON.stringify({ line })]))).status).toBe(204);
    expect(inputs).toEqual([line]);
  });

  it("未知の path は 404", async () => {
    const { base } = await setup();
    expect((await fetch(`${base}/unknown`, { headers: { cookie: COOKIE } })).status).toBe(404);
  });
});
