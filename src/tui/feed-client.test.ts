import { afterEach, describe, expect, it, vi } from "vitest";
import { WebFeed } from "../web/web-feed.js";
import { createLocalFeedClient, createRemoteFeedClient } from "./feed-client.js";

afterEach(() => vi.unstubAllGlobals());

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
