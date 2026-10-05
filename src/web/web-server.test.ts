import { afterEach, describe, expect, it } from "vitest";
import { WebFeed, type FeedItem, type WebState } from "./web-feed.js";
import { buildWebPage } from "./web-page.js";

const PAGE = buildWebPage("ja");
import { startWebServer, type WebServerHandle } from "./web-server.js";

const TOKEN = "a".repeat(64);
const COOKIE = `clodex_token=${TOKEN}`;
const STATE: WebState = { project: "C:\app", primary: "claude", roles: { codex: "実装" }, agents: [], conversations: [], pendingInputs: [] };

let server: WebServerHandle | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const setup = async (onInput?: (line: string) => Promise<void>) => {
  const feed = new WebFeed();
  const inputs: string[] = [];
  const errors: unknown[] = [];
  server = await startWebServer({
    port: 0, token: TOKEN, feed, page: PAGE, onInput: onInput ?? (async (line) => void inputs.push(line)), onError: (e) => errors.push(e),
    listFiles: async () => ["README.md", "src/a.ts"],
    preview: {
      file: async (path) => (path === "a.png"
        ? { ok: true as const, contentType: "image/png", body: Buffer.from([1, 2]) }
        : { ok: false as const, status: 404, message: `not found: ${path}` }),
      diff: async () => ({ ok: true as const, contentType: "text/plain; charset=utf-8", body: Buffer.from("+x") }),
    },
    upload: { maxBytes: 4, accepts: (type) => type === "image/png", save: async (type, body) => `C:/up/${body.length}.${type.slice(6)}` },
  });
  return { feed, inputs, errors, base: server.url };
};

const postInput = (base: string, body: string | Blob) =>
  fetch(`${base}/api/input`, { method: "POST", headers: { cookie: COOKIE }, body });

// SSE の本文を指定の件数ぶん読む
const readEvents = async (response: Response, count: number): Promise<FeedItem[]> => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const lines: FeedItem[] = [];
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

  it("/events は画面の版・直近の履歴・最新の状態を送ってから、新しいものを流す", async () => {
    const { base, feed } = await setup();
    feed.publishOutput("old line");
    feed.publishState(STATE);
    const response = await fetch(`${base}/events`, { headers: { cookie: COOKIE } });
    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
    setTimeout(() => feed.publishOutput("new line"), 50);
    expect(await readEvents(response, 4)).toEqual([
      { type: "version", version: PAGE.version },
      { type: "output", seq: 1, text: "old line" },
      { type: "state", state: STATE },
      { type: "output", seq: 2, text: "new line" },
    ]);
  });

  it("/api/state は最新の状態を返す", async () => {
    const { base, feed } = await setup();
    expect(await (await fetch(`${base}/api/state`, { headers: { cookie: COOKIE } })).json()).toBeNull();
    feed.publishState(STATE);
    expect(await (await fetch(`${base}/api/state`, { headers: { cookie: COOKIE } })).json()).toEqual(STATE);
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

  it("GET /api/files は project のファイルの一覧を返し、token が無ければ 401", async () => {
    const { base } = await setup();
    const response = await fetch(`${base}/api/files`, { headers: { cookie: COOKIE } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(["README.md", "src/a.ts"]);
    expect((await fetch(`${base}/api/files`)).status).toBe(401);
  });

  it("GET /api/file と /api/diff はプレビューの結果を返す", async () => {
    const { base } = await setup();
    const image = await fetch(`${base}/api/file?path=a.png`, { headers: { cookie: COOKIE } });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(`${base}/api/file?path=b.txt`, { headers: { cookie: COOKIE } })).status).toBe(404);
    expect(await (await fetch(`${base}/api/diff?path=a.ts`, { headers: { cookie: COOKIE } })).text()).toBe("+x");
    expect((await fetch(`${base}/api/file?path=a.png`)).status).toBe(401);
  });

  it("POST /api/upload は画像を保存してパスを返し、種類違い・大きすぎ・token なしは拒否する", async () => {
    const { base } = await setup();
    const post = (type: string, body: number[], cookie = COOKIE) =>
      fetch(`${base}/api/upload`, { method: "POST", headers: { cookie, "content-type": type }, body: new Blob([new Uint8Array(body)]) });
    const ok = await post("image/png", [1, 2, 3]);
    expect(await ok.json()).toEqual({ path: "C:/up/3.png" });
    expect((await post("text/html", [1])).status).toBe(415);
    expect((await post("image/png", [1, 2, 3, 4, 5])).status).toBe(413);
    expect((await post("image/png", [1], "")).status).toBe(401);
  });

  it("PWA の manifest とアイコンは token なしで返す", async () => {
    const { base } = await setup();
    const manifest = await fetch(`${base}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toMatchObject({ name: "Clodex", display: "standalone" });
    expect((await fetch(`${base}/icon.svg`)).headers.get("content-type")).toBe("image/svg+xml");
  });

  it("未知の path は 404", async () => {
    const { base } = await setup();
    expect((await fetch(`${base}/unknown`, { headers: { cookie: COOKIE } })).status).toBe(404);
  });
});
