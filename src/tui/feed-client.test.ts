import { afterEach, describe, expect, it, vi } from "vitest";
import { WebFeed } from "../web/web-feed.js";
import { createLocalFeedClient, createRemoteFeedClient } from "./feed-client.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("createLocalFeedClient", () => {
  it("履歴と新着を受け、入力とファイル候補を渡す", async () => {
    const feed = new WebFeed();
    feed.publishOutput("old");
    const lines: string[] = [];
    const client = createLocalFeedClient(feed, async (line) => { lines.push(line); }, async () => ["a.ts"]);
    const received: string[] = [];
    const close = await client.connect((item) => { if (item.type === "output") received.push(item.text); });
    feed.publishOutput("new");
    await client.send("/help");
    expect(await client.files()).toEqual(["a.ts"]);
    expect(received).toEqual(["old", "new"]);
    expect(lines).toEqual(["/help"]);
    close();
    feed.publishOutput("later");
    expect(received).toEqual(["old", "new"]);
  });
});

describe("createRemoteFeedClient", () => {
  it("stream 終了後は間隔を伸ばして再接続し、stop 後は再接続しない", async () => {
    vi.useFakeTimers();
    let streams = 0;
    const fetchMock = vi.fn(async () => {
      streams++;
      if (streams === 2) throw new Error("offline");
      return new Response(new ReadableStream({ start(controller) { controller.close(); } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createRemoteFeedClient({ pid: 1, port: 4319, url: "http://127.0.0.1:4319" }, "secret");
    const changes: boolean[] = [];
    const stop = await client.connect(() => {}, (connected) => changes.push(connected));
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(changes).toContain(false);
    stop();
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("token 付き HTTP/SSE で feed・入力・ファイル候補を扱う", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/api/files")) return new Response('["src/a.ts"]');
      if (String(url).endsWith("/api/input")) return new Response(null, { status: 204 });
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"output","seq":1,"text":"hello"}\n\n'));
        controller.close();
      } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createRemoteFeedClient({ pid: 1, port: 4319, url: "http://127.0.0.1:4319" }, "secret");
    const received: string[] = [];
    const close = await client.connect((item) => { if (item.type === "output") received.push(item.text); });
    await client.send("/help");
    expect(await client.files()).toEqual(["src/a.ts"]);
    expect(received).toEqual(["hello"]);
    expect(calls.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:4319/events", "http://127.0.0.1:4319/api/input", "http://127.0.0.1:4319/api/files",
    ]);
    expect(calls.every(({ init }) => (init.headers as Record<string, string>).cookie === "clodex_token=secret")).toBe(true);
    close();
  });
});

it("local の history は指定 seq より前の履歴を返す", async () => {
  const feed = new WebFeed();
  for (let i = 1; i <= 500; i++) feed.publishOutput(String(i));
  const client = createLocalFeedClient(feed, async () => {}, async () => []);
  const page = await client.history(301);
  expect(page.items).toHaveLength(200);
  expect(page.items[0]?.seq).toBe(101);
  expect(page.items.at(-1)?.seq).toBe(300);
  expect(page.hasMore).toBe(true);
});

it("remote の history は認証付きで前の履歴を取得する", async () => {
  const page = { items: [{ type: "output", seq: 1, text: "過去" }], hasMore: false };
  const fetchMock = vi.fn(async (_url: URL, _init: RequestInit) => new Response(JSON.stringify(page)));
  vi.stubGlobal("fetch", fetchMock);
  const client = createRemoteFeedClient({ pid: 1, port: 4319, url: "http://127.0.0.1:4319" }, "secret");
  expect(await client.history(201)).toEqual(page);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(String(url)).toBe("http://127.0.0.1:4319/api/history?before=201");
  expect(init.headers).toEqual({ cookie: "clodex_token=secret" });
});
