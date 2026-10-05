// TUI はこの interface だけを使い、Hub の所在を意識しない。
import type { HubLock } from "../hub/hub-lock.js";
import type { FeedItem, WebFeed } from "../web/web-feed.js";

export interface FeedClient {
  connect(onItem: (item: FeedItem) => void): Promise<() => void>;
  send(line: string): Promise<void>;
  files(): Promise<string[]>;
}

export const createLocalFeedClient = (
  feed: WebFeed, send: (line: string) => Promise<void>, files: () => Promise<string[]>,
): FeedClient => ({
  connect: async (onItem) => {
    for (const item of feed.recent()) onItem(item);
    const state = feed.latestState();
    if (state) onItem({ type: "state", state });
    return feed.subscribe(onItem);
  },
  send, files,
});

export const createRemoteFeedClient = (lock: HubLock, token: string): FeedClient => {
  const headers = { cookie: `clodex_token=${token}` };
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(new URL(path, lock.url), { ...init, headers: { ...headers, ...init.headers } });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response;
  };
  return {
    connect: async (onItem) => {
      const controller = new AbortController();
      const response = await request("/events", { signal: controller.signal });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("SSE body is empty");
      void (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!controller.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
              const data = block.split(/\r?\n/).filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
              if (data) onItem(JSON.parse(data) as FeedItem);
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) console.error(error);
        } finally { reader.releaseLock(); }
      })();
      return () => controller.abort();
    },
    send: async (line) => { await request("/api/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ line }) }); },
    files: async () => await (await request("/api/files")).json() as string[],
  };
};
