// スマホ等から clodex を操作・観測する Web サーバー（DESIGN.md §17 Web UI）
// 127.0.0.1 だけで待ち受け、外部からは tailscale serve 経由で使う
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { PreviewResult } from "../project/file-preview.js";
import type { FeedItem, WebFeed } from "./web-feed.js";
import type { WebPage } from "./web-page.js";

const HOST = "127.0.0.1";
const COOKIE_NAME = "clodex_token";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const KEEPALIVE_MS = 25_000;
const MAX_BODY_BYTES = 64 * 1024;
const HTTP = {
  ok: 200, noContent: 204, found: 302, badRequest: 400, unauthorized: 401, notFound: 404, tooLarge: 413, serverError: 500,
} as const;

export interface WebServerOptions {
  port: number;
  token: string;
  feed: WebFeed;
  page: WebPage;
  onInput: (line: string) => Promise<void>;
  // @path の候補（DESIGN.md §28 v0.3 A）
  listFiles: () => Promise<string[]>;
  // 成果物のプレビュー（DESIGN.md §28 v0.3 B）
  preview: {
    file(path: string): Promise<PreviewResult>;
    diff(path: string): Promise<PreviewResult>;
  };
  onError?: (error: unknown) => void;
}

export interface WebServerHandle {
  readonly url: string;
  close(): Promise<void>;
}

// timingSafeEqual はバイト長が違うと例外を投げるので、先にバイト長を比べる
const sameToken = (candidate: string | undefined, token: string) => {
  if (candidate === undefined) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

const cookieToken = (req: IncomingMessage) =>
  req.headers.cookie?.split(";").map((c) => c.trim().split("=")).find(([name]) => name === COOKIE_NAME)?.[1];

// 上限を超えたら読み捨てて最後まで受け取る（413 を返せるよう接続は切らない）。
// UTF-8 がチャンクの境目で分かれても化けないよう、バイト列をつなげてからデコードする
const readBody = (req: IncomingMessage): Promise<string | undefined> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => resolve(size > MAX_BODY_BYTES ? undefined : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const parseLine = (body: string): string | undefined => {
  try {
    const parsed = JSON.parse(body) as { line?: unknown };
    return typeof parsed.line === "string" ? parsed.line : undefined;
  } catch {
    return undefined;
  }
};

const sendItem = (res: ServerResponse, item: FeedItem) => res.write(`data: ${JSON.stringify(item)}\n\n`);

const sendJson = (res: ServerResponse, value: unknown) => {
  res.writeHead(HTTP.ok, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};

const sendPreview = (res: ServerResponse, result: PreviewResult) => {
  if (!result.ok) return void res.writeHead(result.status, { "content-type": "text/plain; charset=utf-8" }).end(result.message);
  res.writeHead(HTTP.ok, { "content-type": result.contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(result.body);
};

export const startWebServer = async ({ port, token, feed, page, onInput, listFiles, preview, onError }: WebServerOptions): Promise<WebServerHandle> => {
  const streams = new Set<ServerResponse>();

  const handleEvents = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(HTTP.ok, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    // 接続（再接続を含む）のたびに画面の版、直近の履歴、最新の状態を送る
    sendItem(res, { type: "version", version: page.version });
    for (const item of feed.recent()) sendItem(res, item);
    const state = feed.latestState();
    if (state) sendItem(res, { type: "state", state });
    const unsubscribe = feed.subscribe((item) => sendItem(res, item));
    // プロキシ等に切られないよう、定期的に comment を送る
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
    keepalive.unref();
    streams.add(res);
    req.on("close", () => {
      unsubscribe();
      clearInterval(keepalive);
      streams.delete(res);
    });
  };

  const handleInput = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    if (body === undefined) return void res.writeHead(HTTP.tooLarge).end();
    const line = parseLine(body);
    if (line === undefined) return void res.writeHead(HTTP.badRequest).end();
    await onInput(line);
    res.writeHead(HTTP.noContent).end();
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    const queryToken = url.searchParams.get("token") ?? undefined;

    // 初回はスマホで /?token=... を開き、以後は cookie で認証する
    if (url.pathname === "/" && queryToken !== undefined) {
      if (!sameToken(queryToken, token)) return void res.writeHead(HTTP.unauthorized).end();
      res.writeHead(HTTP.found, {
        location: "/",
        "set-cookie": `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
      });
      return void res.end();
    }
    if (!sameToken(cookieToken(req), token)) return void res.writeHead(HTTP.unauthorized).end();

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(HTTP.ok, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return void res.end(page.html);
    }
    if (req.method === "GET" && url.pathname === "/events") return handleEvents(req, res);
    if (req.method === "GET" && url.pathname === "/api/state") return sendJson(res, feed.latestState() ?? null);
    if (req.method === "GET" && url.pathname === "/api/files") return sendJson(res, await listFiles());
    const previewPath = url.searchParams.get("path");
    if (req.method === "GET" && url.pathname === "/api/file" && previewPath) return sendPreview(res, await preview.file(previewPath));
    if (req.method === "GET" && url.pathname === "/api/diff" && previewPath) return sendPreview(res, await preview.diff(previewPath));
    if (req.method === "POST" && url.pathname === "/api/input") return handleInput(req, res);
    res.writeHead(HTTP.notFound).end();
  };

  // コマンドの失敗等でプロセスを落とさない
  const http = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      onError?.(error);
      if (!res.headersSent) res.writeHead(HTTP.serverError);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, HOST, resolve);
  });

  return {
    url: `http://${HOST}:${(http.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => {
      for (const res of streams) res.end();
      http.closeAllConnections();
      http.close(() => resolve());
    }),
  };
};
