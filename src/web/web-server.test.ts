import { afterEach, describe, expect, it } from "vitest";
import type { ConnectionStatus } from "./tailscale.js";
import { type FeedItem, WebFeed, type WebState } from "./web-feed.js";
import { buildWebPage } from "./web-page.js";

const PAGE = buildWebPage("ja");

import { startWebServer, type WebServerHandle } from "./web-server.js";

const TOKEN = "a".repeat(64);
const COOKIE = `clodex_token=${TOKEN}`;
const diffRequests: Array<{ path: string; since?: string }> = [];
const STATE: WebState = {
  project: "C:app",
  primary: "claude",
  roles: { codex: "実装" },
  agents: [],
  tabs: [],
  conversations: [],
  pendingInputs: [],
  pendingMessages: [],
  questions: [],
  processes: [],
  language: "ja",
  sandbox: { enabled: false, ready: false },
  limitsUnlimited: false,
  limits: { messages: { value: 8, default: 8 }, reviews: { value: 3, default: 3 }, delegations: { value: 4, default: 4 }, depth: { value: 2, default: 2 } },
};

let server: WebServerHandle | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const setup = async (onInput?: (line: string) => Promise<void>, connect?: () => Promise<ConnectionStatus>) => {
  const feed = new WebFeed();
  const inputs: string[] = [];
  const errors: unknown[] = [];
  server = await startWebServer({
    port: 0,
    token: TOKEN,
    feed,
    page: PAGE,
    onInput: onInput ?? (async line => void inputs.push(line)),
    connect,
    onError: e => errors.push(e),
    listFiles: async () => ["README.md", "src/a.ts"],
    preview: {
      file: async path =>
        path === "a.png"
          ? { ok: true as const, contentType: "image/png", body: Buffer.from([1, 2]) }
          : { ok: false as const, status: 404, message: `not found: ${path}` },
      diff: async (path, since) => {
        diffRequests.push({ path, since });
        return { ok: true as const, contentType: "text/plain; charset=utf-8", body: Buffer.from("+x") };
      },
    },
    upload: { maxBytes: 4, accepts: type => type === "image/png", save: async (type, body) => `C:/up/${body.length}.${type.slice(6)}` },
  });
  return { feed, inputs, errors, base: server.url };
};

const postInput = (base: string, body: string | Blob) => fetch(`${base}/api/input`, { method: "POST", headers: { cookie: COOKIE }, body });

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
  it("同梱フォントだけを token なしで版付き URL から返す", async () => {
    const { base } = await setup();
    const fontUrl = PAGE.html.match(/url\((\/fonts\/geist-sans@[^/]+\/geist-sans-latin-400-normal\.woff2)\)/)?.[1];
    expect(fontUrl).toBeDefined();
    const response = await fetch(`${base}${fontUrl}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("font/woff2");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const prefix = fontUrl!.slice(0, fontUrl!.lastIndexOf("/") + 1);
    for (const path of [
      fontUrl!.replace("geist-sans@", "unknown@"),
      fontUrl!.replace("@5.3.0", "@0.0.0"),
      `${prefix}%2e%2e%2fsecret.woff2`,
      `${prefix}name%5csecret.woff2`,
      `${prefix}%00.woff2`,
      `${prefix}geist-sans-latin-400-normal.woff`,
    ])
      expect((await fetch(`${base}${path}`)).status).toBe(404);
  });
  it("言語変更後の HTML と版を接続中と新規の画面に配信する", async () => {
    const { base } = await setup();
    const response = await fetch(`${base}/events`, { headers: { cookie: COOKIE } });
    const next = buildWebPage("en");
    expect(next.version).not.toBe(PAGE.version);
    server!.updatePage(next);
    expect(await readEvents(response, 2)).toEqual([
      { type: "version", version: PAGE.version },
      { type: "version", version: next.version },
    ]);
    expect(await (await fetch(`${base}/`, { headers: { cookie: COOKIE } })).text()).toBe(next.html);
    expect(await readEvents(await fetch(`${base}/events`, { headers: { cookie: COOKIE } }), 1)).toEqual([{ type: "version", version: next.version }]);
  });
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

  it("/api/connect は token で守り、接続 URL と QR SVG を返す", async () => {
    const { base } = await setup(undefined, async () => ({ state: "ready", url: "https://desktop.example.ts.net/" }));
    expect((await fetch(`${base}/api/connect`)).status).toBe(401);
    const response = await fetch(`${base}/api/connect`, { headers: { cookie: COOKIE } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const value = (await response.json()) as { state: string; url: string; qrSvg: string };
    expect(value.state).toBe("ready");
    expect(value.url).toBe(`https://desktop.example.ts.net/?token=${TOKEN}`);
    expect(value.qrSvg).toContain("<svg");
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
      method: "POST",
      headers: { cookie: COOKIE, "content-type": "application/json" },
      body: JSON.stringify({ line: "@codex hi" }),
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
    const { base, errors } = await setup(async () => {
      throw new Error("interrupt failed");
    });
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
    expect(await (await fetch(`${base}/api/diff?path=a.ts&since=2026-01-02T00%3A00%3A00Z`, { headers: { cookie: COOKIE } })).text()).toBe("+x");
    expect(diffRequests.at(-1)).toEqual({ path: "a.ts", since: "2026-01-02T00:00:00Z" });
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

  it("iPhone 用の 180px PNG アイコンを token なしで返す", async () => {
    const { base } = await setup();
    const response = await fetch(`${base}/apple-touch-icon.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const png = Buffer.from(await response.arrayBuffer());
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.subarray(0, signature.length)).toEqual(signature);
    expect(png.toString("ascii", 12, 16)).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(180);
    expect(png.readUInt32BE(20)).toBe(180);
  });

  it("未知の path は 404", async () => {
    const { base } = await setup();
    expect((await fetch(`${base}/unknown`, { headers: { cookie: COOKIE } })).status).toBe(404);
  });
});

it("履歴を認証付きで分割取得し、不正な before は 400", async () => {
  const { base, feed } = await setup();
  for (let i = 1; i <= 5; i++) feed.publishOutput(String(i));
  const response = await fetch(`${base}/api/history?before=5&limit=2`, { headers: { cookie: COOKIE } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    items: [
      { type: "output", seq: 3, text: "3" },
      { type: "output", seq: 4, text: "4" },
    ],
    hasMore: true,
  });
  for (const query of ["", "?before=", "?before=invalid", "?before=Infinity"]) {
    expect((await fetch(`${base}/api/history${query}`, { headers: { cookie: COOKIE } })).status).toBe(400);
  }
  expect((await fetch(`${base}/api/history?before=5`)).status).toBe(401);
});

describe("Web Push", () => {
  const setupPush = async () => {
    const calls: string[] = [];
    const feed = new WebFeed();
    server = await startWebServer({
      port: 0,
      token: TOKEN,
      feed,
      page: PAGE,
      onInput: async () => {},
      listFiles: async () => [],
      preview: { file: async () => ({ ok: false as const, status: 404, message: "" }), diff: async () => ({ ok: false as const, status: 404, message: "" }) },
      upload: { maxBytes: 4, accepts: () => false, save: async () => "" },
      push: {
        publicKey: () => "KEY",
        subscribe: input => ((input as { endpoint?: string }).endpoint ? "id1" : undefined),
        unsubscribe: id => void calls.push(`unsubscribe ${id}`),
        setVisible: (id, visible) => void calls.push(`visible ${id} ${visible}`),
        connect: (id, visible) => {
          calls.push(`connect ${id} ${visible}`);
          return { close: () => void calls.push(`close ${id}`) };
        },
      },
    });
    return { base: server.url, calls };
  };
  const post = (base: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { cookie: COOKIE }, body: JSON.stringify(body) });

  it("Service Worker は token なしで返す", async () => {
    const { base } = await setupPush();
    const response = await fetch(`${base}/sw.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(await response.text()).toContain("showNotification");
  });

  it("公開鍵・購読・解除・見えているかの API", async () => {
    const { base, calls } = await setupPush();
    expect(await (await fetch(`${base}/api/push/key`, { headers: { cookie: COOKIE } })).json()).toEqual({ key: "KEY" });
    expect(await (await post(base, "/api/push/subscribe", { endpoint: "https://x" })).json()).toEqual({ id: "id1" });
    expect((await post(base, "/api/push/subscribe", {})).status).toBe(400);
    expect((await post(base, "/api/push/visibility", { id: "id1", visible: false })).status).toBe(204);
    expect((await post(base, "/api/push/visibility", { id: "id1" })).status).toBe(400);
    expect((await post(base, "/api/push/unsubscribe", { id: "id1" })).status).toBe(204);
    expect((await fetch(`${base}/api/push/key`)).status).toBe(401);
    expect(calls).toEqual(["visible id1 false", "unsubscribe id1"]);
  });

  it("push の id 付きの接続を見えているかとともに知らせ、切れたら閉じる", async () => {
    const { base, calls } = await setupPush();
    const controller = new AbortController();
    await fetch(`${base}/events?push=id1&visible=1`, { headers: { cookie: COOKIE }, signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toEqual(["connect id1 true", "close id1"]);
  });
});

describe("GUI の更新の中継", () => {
  const post = (base: string, path: string, body: unknown, cookie = COOKIE) =>
    fetch(`${base}${path}`, { method: "POST", headers: { cookie }, body: JSON.stringify(body) });
  const events = (base: string, query = "") => fetch(`${base}/events${query}`, { headers: { cookie: COOKIE } });

  it("GUI の接続を全画面に知らせ、確認の依頼を GUI へ、結果を全画面へ送る", async () => {
    const { base } = await setup();
    const phone = await events(base);
    const gui = await events(base, "?gui=0.1.2-dev.3");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await post(base, "/api/gui/update", { action: "check" })).status).toBe(204);
    expect((await post(base, "/api/gui/status", { status: "available", version: "0.1.2-dev.4" })).status).toBe(204);
    expect((await readEvents(phone, 4)).slice(1)).toEqual([
      { type: "gui", gui: { version: "0.1.2-dev.3" } },
      { type: "gui", gui: { version: "0.1.2-dev.3", update: { status: "checking" } } },
      { type: "gui", gui: { version: "0.1.2-dev.3", update: { status: "available", version: "0.1.2-dev.4" } } },
    ]);
    expect(await readEvents(await events(base), 2)).toEqual([
      { type: "version", version: PAGE.version },
      { type: "gui", gui: { version: "0.1.2-dev.3", update: { status: "available", version: "0.1.2-dev.4" } } },
    ]);
    expect((await readEvents(gui, 4)).slice(0, 4)).toEqual([
      { type: "version", version: PAGE.version },
      { type: "gui", gui: { version: "0.1.2-dev.3" } },
      { type: "gui", gui: { version: "0.1.2-dev.3", update: { status: "checking" } } },
      { type: "gui_command", action: "check" },
    ]);
  });

  it("GUI の接続が切れたら全画面に知らせ、GUI が無ければ依頼は 409", async () => {
    const { base } = await setup();
    const phone = await events(base);
    const controller = new AbortController();
    await fetch(`${base}/events?gui=0.1.2`, { headers: { cookie: COOKIE }, signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort();
    expect((await readEvents(phone, 3)).slice(1)).toEqual([
      { type: "gui", gui: { version: "0.1.2" } },
      { type: "gui", gui: null },
    ]);
    expect((await post(base, "/api/gui/update", { action: "install" })).status).toBe(409);
  });

  it("不正な依頼・結果は 400、token が無ければ 401", async () => {
    const { base } = await setup();
    await events(base, "?gui=0.1.2");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await post(base, "/api/gui/update", { action: "remove" })).status).toBe(400);
    expect((await post(base, "/api/gui/status", { status: "available" })).status).toBe(400);
    expect((await post(base, "/api/gui/status", { status: "error" })).status).toBe(400);
    for (const progress of [-1, 100.5, 101, "50", null]) {
      expect((await post(base, "/api/gui/status", { status: "installing", progress })).status).toBe(400);
    }
    expect((await post(base, "/api/gui/update", { action: "check" }, "clodex_token=wrong")).status).toBe(401);
  });

  it("GUI の更新割合を全画面に流す", async () => {
    const { base } = await setup();
    const phone = await events(base);
    await events(base, "?gui=0.1.2");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await post(base, "/api/gui/status", { status: "installing", progress: 45 })).status).toBe(204);
    expect((await readEvents(phone, 3)).at(-1)).toEqual({ type: "gui", gui: { version: "0.1.2", update: { status: "installing", progress: 45 } } });
  });
});
