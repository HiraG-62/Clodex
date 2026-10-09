// スマホ等から clodex を操作・観測する Web サーバー（DESIGN.md §17 Web UI）
// 127.0.0.1 だけで待ち受け、外部からは tailscale serve 経由で使う
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as QRCode from "qrcode";
import type { PreviewResult } from "../project/file-preview.js";
import { APPLE_TOUCH_ICON_PNG_BASE64 } from "./apple-touch-icon.js";
import { fontFilePath } from "./fonts.js";
import { SERVICE_WORKER } from "./service-worker.js";
import { type ConnectionStatus, queryTailscale } from "./tailscale.js";
import { type FeedItem, GUI_ACTIONS, type GuiAction, type GuiInfo, type GuiUpdate, type WebFeed } from "./web-feed.js";
import { ICON_SVG, MANIFEST, type WebPage } from "./web-page.js";

const HOST = "127.0.0.1";
const COOKIE_NAME = "clodex_token";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const KEEPALIVE_MS = 25_000;
const MAX_BODY_BYTES = 64 * 1024;
const APPLE_TOUCH_ICON_PNG = Buffer.from(APPLE_TOUCH_ICON_PNG_BASE64, "base64");
const HTTP = {
  ok: 200,
  noContent: 204,
  found: 302,
  badRequest: 400,
  unauthorized: 401,
  notFound: 404,
  conflict: 409,
  tooLarge: 413,
  unsupported: 415,
  serverError: 500,
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
  // 貼り付けた画像を保存し、フルパスを返す（DESIGN.md §28 v0.3 C）
  upload: { maxBytes: number; accepts(contentType: string): boolean; save(contentType: string, body: Buffer): Promise<string> };
  onError?: (error: unknown) => void;
  connect?: () => Promise<ConnectionStatus>;
  // スマホへの通知（DESIGN.md §28 スマホへの通知（Web Push））
  push?: PushEndpoints;
}

export interface PushEndpoints {
  publicKey(): string;
  subscribe(input: unknown): string | undefined;
  unsubscribe(id: string): void;
  setVisible(id: string, visible: boolean): void;
  connect(id: string, visible: boolean): { close(): void };
}

export interface WebServerHandle {
  readonly url: string;
  updatePage(page: WebPage): void;
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
  req.headers.cookie
    ?.split(";")
    .map(c => c.trim().split("="))
    .find(([name]) => name === COOKIE_NAME)?.[1];

// 上限を超えたら読み捨てて最後まで受け取る（413 を返せるよう接続は切らない）。
// UTF-8 がチャンクの境目で分かれても化けないよう、バイト列をつなげてからデコードする
const readBytes = (req: IncomingMessage, maxBytes: number): Promise<Buffer | undefined> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
    });
    req.on("end", () => resolve(size > maxBytes ? undefined : Buffer.concat(chunks)));
    req.on("error", reject);
  });

const readBody = async (req: IncomingMessage): Promise<string | undefined> => (await readBytes(req, MAX_BODY_BYTES))?.toString("utf8");

const parseLine = (body: string): string | undefined => {
  try {
    const parsed = JSON.parse(body) as { line?: unknown };
    return typeof parsed.line === "string" ? parsed.line : undefined;
  } catch {
    return undefined;
  }
};

const parseJson = (body: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

const parseGuiAction = (body: string): GuiAction | undefined => {
  const action = parseJson(body)?.action;
  return GUI_ACTIONS.find(candidate => candidate === action);
};

const parseGuiUpdate = (body: string): GuiUpdate | undefined => {
  const value = parseJson(body);
  const status = value?.status;
  if (status === "checking" || status === "latest" || status === "installing") return { status };
  if (status === "available" && typeof value?.version === "string") return { status, version: value.version };
  if (status === "error" && typeof value?.message === "string") return { status, message: value.message };
  return undefined;
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

export const startWebServer = async ({
  port,
  token,
  feed,
  page,
  onInput,
  listFiles,
  preview,
  upload,
  onError,
  connect,
  push,
}: WebServerOptions): Promise<WebServerHandle> => {
  const getConnection = connect ?? (() => queryTailscale(port));
  const streams = new Set<ServerResponse>();
  // GUI の中の画面の接続（DESIGN.md §28 Web UI の設定からの更新）
  let guiStream: ServerResponse | undefined;
  let gui: GuiInfo | null = null;
  const setGui = (next: GuiInfo | null) => {
    gui = next;
    for (const res of streams) sendItem(res, { type: "gui", gui });
  };

  const handleEvents = (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const guiVersion = url.searchParams.get("gui");
    const pushId = url.searchParams.get("push");
    const pushStream = pushId ? push?.connect(pushId, url.searchParams.get("visible") === "1") : undefined;
    res.writeHead(HTTP.ok, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    // 接続（再接続を含む）のたびに画面の版、直近の履歴、最新の状態を送る
    sendItem(res, { type: "version", version: page.version });
    for (const item of feed.recent()) sendItem(res, item);
    const state = feed.latestState();
    if (state) sendItem(res, { type: "state", state });
    if (gui) sendItem(res, { type: "gui", gui });
    const unsubscribe = feed.subscribe(item => sendItem(res, item));
    // プロキシ等に切られないよう、定期的に comment を送る
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
    keepalive.unref();
    streams.add(res);
    if (guiVersion) {
      guiStream = res;
      setGui({ version: guiVersion });
    }
    req.on("close", () => {
      unsubscribe();
      clearInterval(keepalive);
      streams.delete(res);
      pushStream?.close();
      if (guiStream !== res) return;
      guiStream = undefined;
      setGui(null);
    });
  };

  const handlePush = async (req: IncomingMessage, res: ServerResponse, pathname: string, endpoints: PushEndpoints) => {
    const body = await readBody(req);
    if (body === undefined) return void res.writeHead(HTTP.tooLarge).end();
    const value = parseJson(body);
    if (pathname === "/api/push/subscribe") {
      const id = endpoints.subscribe(value);
      return id ? sendJson(res, { id }) : void res.writeHead(HTTP.badRequest).end();
    }
    const id = value?.id;
    if (typeof id !== "string") return void res.writeHead(HTTP.badRequest).end();
    if (pathname === "/api/push/unsubscribe") endpoints.unsubscribe(id);
    else if (typeof value?.visible === "boolean") endpoints.setVisible(id, value.visible);
    else return void res.writeHead(HTTP.badRequest).end();
    res.writeHead(HTTP.noContent).end();
  };

  const handleGuiUpdate = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    if (body === undefined) return void res.writeHead(HTTP.tooLarge).end();
    const action = parseGuiAction(body);
    if (!action) return void res.writeHead(HTTP.badRequest).end();
    if (!guiStream || !gui) return void res.writeHead(HTTP.conflict).end();
    setGui({ ...gui, update: { status: action === "check" ? "checking" : "installing" } });
    sendItem(guiStream, { type: "gui_command", action });
    res.writeHead(HTTP.noContent).end();
  };

  const handleGuiStatus = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    if (body === undefined) return void res.writeHead(HTTP.tooLarge).end();
    const update = parseGuiUpdate(body);
    if (!update) return void res.writeHead(HTTP.badRequest).end();
    if (!gui) return void res.writeHead(HTTP.conflict).end();
    setGui({ ...gui, update });
    res.writeHead(HTTP.noContent).end();
  };

  const handleInput = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    if (body === undefined) return void res.writeHead(HTTP.tooLarge).end();
    const line = parseLine(body);
    if (line === undefined) return void res.writeHead(HTTP.badRequest).end();
    await onInput(line);
    res.writeHead(HTTP.noContent).end();
  };

  const handleUpload = async (req: IncomingMessage, res: ServerResponse) => {
    const contentType = (req.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "";
    if (!upload.accepts(contentType)) return void res.writeHead(HTTP.unsupported).end();
    const body = await readBytes(req, upload.maxBytes);
    if (body === undefined) return void res.writeHead(HTTP.tooLarge).end();
    sendJson(res, { path: await upload.save(contentType, body) });
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
    // PWA の manifest とアイコンは秘密を含まないので、認証の前に返す
    if (req.method === "GET" && url.pathname === "/manifest.webmanifest") {
      return void res.writeHead(HTTP.ok, { "content-type": "application/manifest+json" }).end(MANIFEST);
    }
    if (req.method === "GET" && url.pathname === "/icon.svg") {
      return void res.writeHead(HTTP.ok, { "content-type": "image/svg+xml" }).end(ICON_SVG);
    }
    if (req.method === "GET" && url.pathname === "/sw.js") {
      return void res.writeHead(HTTP.ok, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" }).end(SERVICE_WORKER);
    }
    if (req.method === "GET" && url.pathname === "/apple-touch-icon.png") {
      return void res.writeHead(HTTP.ok, { "content-type": "image/png" }).end(APPLE_TOUCH_ICON_PNG);
    }
    if (req.method === "GET" && url.pathname.startsWith("/fonts/")) {
      const file = fontFilePath(url.pathname);
      if (!file) return void res.writeHead(HTTP.notFound).end();
      try {
        const body = await readFile(file);
        return void res
          .writeHead(HTTP.ok, {
            "content-type": "font/woff2",
            "cache-control": "public, max-age=31536000, immutable",
          })
          .end(body);
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
          return void res.writeHead(HTTP.notFound).end();
        }
        throw error;
      }
    }
    if (!sameToken(cookieToken(req), token)) return void res.writeHead(HTTP.unauthorized).end();

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(HTTP.ok, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return void res.end(page.html);
    }
    if (req.method === "GET" && url.pathname === "/events") return handleEvents(req, res, url);
    if (push && req.method === "GET" && url.pathname === "/api/push/key") return sendJson(res, { key: push.publicKey() });
    if (push && req.method === "POST" && ["/api/push/subscribe", "/api/push/unsubscribe", "/api/push/visibility"].includes(url.pathname)) {
      return handlePush(req, res, url.pathname, push);
    }
    if (req.method === "GET" && url.pathname === "/api/state") return sendJson(res, feed.latestState() ?? null);
    if (req.method === "GET" && url.pathname === "/api/connect") {
      try {
        const connection = await getConnection();
        if (connection.state === "ready") {
          const remoteUrl = `${connection.url}?token=${encodeURIComponent(token)}`;
          const qrSvg = await QRCode.toString(remoteUrl, { type: "svg", width: 240, margin: 2 });
          return sendJson(res, { state: "ready", url: remoteUrl, qrSvg });
        }
        if (connection.state === "noServe") return sendJson(res, { state: "noServe", command: `tailscale serve --bg ${port}` });
        return sendJson(res, connection);
      } catch (error) {
        res.writeHead(HTTP.serverError, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        return void res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    }
    if (req.method === "GET" && url.pathname === "/api/files") return sendJson(res, await listFiles());
    if (req.method === "GET" && url.pathname === "/api/history") {
      const before = url.searchParams.get("before");
      if (!before?.trim() || !Number.isFinite(Number(before))) return void res.writeHead(HTTP.badRequest).end();
      const limit = url.searchParams.get("limit");
      return sendJson(res, feed.before(Number(before), limit === null ? undefined : Number(limit)));
    }
    const previewPath = url.searchParams.get("path");
    if (req.method === "GET" && url.pathname === "/api/file" && previewPath) return sendPreview(res, await preview.file(previewPath));
    if (req.method === "GET" && url.pathname === "/api/diff" && previewPath) return sendPreview(res, await preview.diff(previewPath));
    if (req.method === "POST" && url.pathname === "/api/input") return handleInput(req, res);
    if (req.method === "POST" && url.pathname === "/api/upload") return handleUpload(req, res);
    if (req.method === "POST" && url.pathname === "/api/gui/update") return handleGuiUpdate(req, res);
    if (req.method === "POST" && url.pathname === "/api/gui/status") return handleGuiStatus(req, res);
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
    updatePage: next => {
      page = next;
      for (const res of streams) sendItem(res, { type: "version", version: page.version });
    },
    url: `http://${HOST}:${(http.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>(resolve => {
        for (const res of streams) res.end();
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
};
