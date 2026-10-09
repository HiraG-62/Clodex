// TUI はこの interface だけを使い、Hub の所在を意識しない。
import type { HubLock } from "../hub/hub-lock.js";
import type { FeedItem, HistoryPage, WebFeed } from "../web/web-feed.js";

export interface FeedClient {
  connect(onItem: (item: FeedItem) => void, onConnectionChange?: (connected: boolean) => void): Promise<() => void>;
  send(line: string): Promise<void>;
  files(): Promise<string[]>;
  history(before: number): Promise<HistoryPage>;
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
  history: async (before) => feed.before(before),
});

export const createRemoteFeedClient = (lock: HubLock, token: string): FeedClient => {
  const RETRY_INITIAL_MS = 1000;
  const RETRY_MAX_MS = 30000;
  const headers = { cookie: `clodex_token=${token}` };
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(new URL(path, lock.url), { ...init, headers: { ...headers, ...init.headers } });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response;
  };
  return {
    connect: async (onItem, onConnectionChange) => {
      const controller = new AbortController();
      let retryDelay = RETRY_INITIAL_MS;
      let wake: (() => void) | undefined;
      let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const wait = (ms: number) => new Promise<void>((resolve) => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, ms);
        wake = () => { clearTimeout(timer); resolve(); };
      });
      const read = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!controller.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
              const data = block.split(/\r?\n/).filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
              if (data) onItem(JSON.parse(data) as FeedItem);
            }
          }
        } finally { reader.releaseLock(); }
      };
      const openStream = async () => {
        const response = await request("/events", { signal: controller.signal });
        const reader = response.body?.getReader();
        if (!reader) throw new Error("SSE body is empty");
        activeReader = reader;
        onConnectionChange?.(true);
        retryDelay = RETRY_INITIAL_MS;
        return reader;
      };
      const first = await openStream();
      void (async () => {
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined = first;
        while (!controller.signal.aborted) {
          if (reader) {
            try { await read(reader); }
            catch (error) { if (!controller.signal.aborted) console.error(error); }
            activeReader = undefined;
          }
          if (controller.signal.aborted) break;
          onConnectionChange?.(false);
          await wait(retryDelay);
          if (controller.signal.aborted) break;
          retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
          try { reader = await openStream(); }
          catch (error) {
            if (!controller.signal.aborted) console.error(error);
            reader = undefined;
          }
        }
      })();
      return () => { controller.abort(); wake?.(); void activeReader?.cancel().catch(() => {}); };
    },
    send: async (line) => { await request("/api/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ line }) }); },
    history: async (before) => await (await request(`/api/history?before=${before}`)).json() as HistoryPage,
    files: async () => await (await request("/api/files")).json() as string[],
  };
};
