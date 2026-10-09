import { PassThrough } from "node:stream";
import { render as renderInk } from "ink";
import { cleanup, render } from "ink-testing-library";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLanguage, t } from "../i18n/i18n.js";
import type { FeedItem } from "../web/web-feed.js";
import type { FeedClient } from "./feed-client.js";
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
  enableVirtualTerminalInput,
  MouseInputRelay,
  TUI_RENDER_OPTIONS,
  TuiApp,
  withMouseTracking,
} from "./tui.js";

afterEach(cleanup);

const fakeClient = () => {
  let listener: (item: FeedItem) => void = () => {};
  let connectionListener: (connected: boolean) => void = () => {};
  let resolveConnected: () => void = () => {};
  const connected = new Promise<void>(resolve => {
    resolveConnected = resolve;
  });
  const client: FeedClient = {
    connect: async (onItem, onConnectionChange) => {
      listener = onItem;
      connectionListener = onConnectionChange ?? (() => {});
      resolveConnected();
      return () => {};
    },
    send: async () => {},
    files: async () => [],
    history: async () => ({ items: [], hasMore: false }),
  };
  return { client, connected, emit: (item: FeedItem) => listener(item), connection: (value: boolean) => connectionListener(value) };
};
const waitFor = (assertion: () => void) => vi.waitFor(assertion, { interval: 5 });

describe("TuiApp", () => {
  it("切断中は再接続中を出し、復旧時に消す", async () => {
    setLanguage("ja");
    const { client, connected, connection } = fakeClient();
    const app = render(React.createElement(TuiApp, { client }));
    await connected;
    connection(false);
    await waitFor(() => expect(app.lastFrame()).toContain("再接続中…"));
    connection(true);
    await waitFor(() => expect(app.lastFrame()).not.toContain("再接続中…"));
  });
  it("本体が待機中でも動いているサブエージェントの数を表示する", async () => {
    setLanguage("ja");
    const { client, emit, connected } = fakeClient();
    const app = render(React.createElement(TuiApp, { client }));
    await connected;
    emit({
      type: "state",
      state: {
        project: "app",
        primary: "claude",
        roles: {},
        agents: [
          {
            id: "claude",
            status: "idle",
            sessionId: "s",
            permission: "edit",
            models: [],
            usage: {},
            subagents: [
              { id: "a", description: "調査" },
              { id: "b", description: "実装" },
            ],
          },
        ],
        tabs: [],
        conversations: [],
        pendingInputs: [],
        pendingMessages: [],
        questions: [],
        processes: [],
        language: "ja",
        sandbox: { enabled: false, ready: false },
        limitsUnlimited: false,
        limits: {
          messages: { value: 8, default: 8 },
          reviews: { value: 3, default: 3 },
          delegations: { value: 4, default: 4 },
          depth: { value: 2, default: 2 },
        },
      },
    });
    await waitFor(() => expect(app.lastFrame()).toContain("待機中 · sub 2"));
  });

  it("送信待ちの件数に Agent 間メッセージを含める", async () => {
    setLanguage("ja");
    const { client, emit, connected } = fakeClient();
    const app = render(React.createElement(TuiApp, { client }));
    await connected;
    emit({
      type: "state",
      state: {
        project: "app",
        primary: "claude",
        roles: {},
        agents: [],
        tabs: [],
        conversations: [],
        pendingInputs: [],
        pendingMessages: [{ id: "msg_1", agent: "codex", from: "claude", type: "DELEGATE", taskId: "T", text: "作業" }],
        questions: [],
        processes: [],
        language: "ja",
        sandbox: { enabled: false, ready: false },
        limitsUnlimited: false,
        limits: {
          messages: { value: 8, default: 8 },
          reviews: { value: 3, default: 3 },
          delegations: { value: 4, default: 4 },
          depth: { value: 2, default: 2 },
        },
      },
    });
    await waitFor(() => expect(app.lastFrame()).toContain("送信待ち 1 件"));
  });
  it("先頭の ! の入力と削除でコマンドの枠ラベルを切り替える", async () => {
    setLanguage("ja");
    const { client, connected } = fakeClient();
    const app = render(React.createElement(TuiApp, { client }));
    await connected;
    app.stdin.write("!");
    await waitFor(() => expect(app.lastFrame()).toContain("╭─ コマンド "));
    app.stdin.write("\x7f");
    await waitFor(() => expect(app.lastFrame()).toContain("メッセージ"));
    expect(app.lastFrame()).not.toContain("╭─ コマンド ");
  });
  it("作業中のターンと候補を下部に表示する", async () => {
    setLanguage("ja");
    const { client, emit, connected } = fakeClient();
    const app = render(React.createElement(TuiApp, { client }));
    await connected;
    emit({ type: "event", seq: 1, event: { kind: "agent", agent: "claude", at: new Date().toISOString(), event: { type: "turn_started" } } });
    emit({ type: "event", seq: 2, event: { kind: "agent", agent: "claude", at: new Date().toISOString(), event: { type: "text", text: "方針を確認" } } });
    app.stdin.write("/");
    await waitFor(() => {
      expect(app.lastFrame()).toContain("Claude · 作業中");
      expect(app.lastFrame()).toContain("方針を確認");
      expect(app.lastFrame()).toContain("/status");
    });
  });

  it("完了したターンをログに表示する", async () => {
    setLanguage("ja");
    const { client, emit, connected } = fakeClient();
    const app = render(React.createElement(TuiApp, { client }));
    await connected;
    emit({ type: "event", seq: 1, event: { kind: "agent", agent: "codex", at: new Date().toISOString(), event: { type: "turn_started" } } });
    emit({
      type: "event",
      seq: 2,
      event: { kind: "agent", agent: "codex", at: new Date().toISOString(), event: { type: "turn", result: { status: "completed", text: "# 完了しました" } } },
    });
    await waitFor(() => {
      expect(app.frames.join("\n")).toContain("完了しました");
      expect(app.frames.join("\n")).toContain("Codex · 完了");
    });
  });

  it("Ctrl+O 以後に完了するターンの作業を展開する", async () => {
    setLanguage("ja");
    const { client, emit, connected } = fakeClient();
    const app = render(React.createElement(TuiApp, { client }));
    await connected;
    app.stdin.write("\x0f");
    emit({ type: "event", seq: 1, event: { kind: "agent", agent: "claude", at: new Date().toISOString(), event: { type: "turn_started" } } });
    emit({
      type: "event",
      seq: 2,
      event: { kind: "agent", agent: "claude", at: new Date().toISOString(), event: { type: "tool", name: "Read", input: "src/a.ts" } },
    });
    emit({
      type: "event",
      seq: 3,
      event: { kind: "agent", agent: "claude", at: new Date().toISOString(), event: { type: "turn", result: { status: "completed", text: "終了" } } },
    });
    await waitFor(() => expect(app.frames.join("\n")).toContain("Read: src/a.ts"));
  });

  it("Ctrl+O で過去のターンの作業も開閉する", async () => {
    setLanguage("ja");
    const { client, emit, connected } = fakeClient();
    const app = render(React.createElement(TuiApp, { client }));
    await connected;
    emit({ type: "event", seq: 1, event: { kind: "agent", agent: "claude", at: new Date().toISOString(), event: { type: "turn_started" } } });
    emit({
      type: "event",
      seq: 2,
      event: { kind: "agent", agent: "claude", at: new Date().toISOString(), event: { type: "tool", name: "Read", input: "old.ts" } },
    });
    emit({
      type: "event",
      seq: 3,
      event: { kind: "agent", agent: "claude", at: new Date().toISOString(), event: { type: "turn", result: { status: "completed", text: "完了" } } },
    });
    await waitFor(() => expect(app.lastFrame()).toContain("完了"));
    expect(app.lastFrame()).not.toContain("Read: old.ts");
    app.stdin.write("\x0f");
    await waitFor(() => expect(app.lastFrame()).toContain("Read: old.ts"));
  });

  it("中継 stream のホイールでログをスクロールし、マウス入力を入力欄に入れない", async () => {
    setLanguage("ja");
    const source = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const mouseInput = new MouseInputRelay(source);
    const { client, emit, connected } = fakeClient();
    const app = render(React.createElement(TuiApp, { client, mouseInput }));
    await connected;
    for (let seq = 1; seq <= 30; seq++) emit({ type: "output", seq, text: `ログ ${seq}` });
    await waitFor(() => expect(app.lastFrame()).toContain("ログ 30"));
    source.write("\x1b[<64;12;8M");
    source.write("\x1b[<0;12;8M");
    await waitFor(() => expect(app.lastFrame()).toContain("ログ 1"));
    expect(app.lastFrame()).not.toContain("ログ 30");
    expect(app.lastFrame()).toContain("メッセージ");
    expect(app.lastFrame()).not.toContain("<0;12;8");
    mouseInput.close();
  });

  it("空の入力欄はカーソルと同じ行に薄い案内を出し、入力すると消す", async () => {
    setLanguage("ja");
    const { client, connected } = fakeClient();
    const app = render(React.createElement(TuiApp, { client }));
    await connected;
    await waitFor(() => expect(app.lastFrame()).toContain("メッセージ"));
    const lines = (app.lastFrame() ?? "").split("\n");
    const inputLine = lines.findIndex(line => line.includes("メッセージ"));
    expect(lines[inputLine + 1]).toContain("╰");
    app.stdin.write("a");
    await waitFor(() => expect(app.lastFrame()).toContain("│ a"));
    expect(app.lastFrame()).not.toContain("メッセージ");
  });

  it("Windows の Backspace と Ctrl+End を Ink の入力として扱う", async () => {
    setLanguage("ja");
    const { client, emit, connected } = fakeClient();
    const app = render(React.createElement(TuiApp, { client }));
    await connected;
    app.stdin.write("ab\x7f");
    await waitFor(() => expect(app.lastFrame()).toContain("│ a"));
    expect(app.lastFrame()).not.toContain("ab");
    for (let seq = 1; seq <= 30; seq++) emit({ type: "output", seq, text: `ログ ${seq}` });
    await waitFor(() => expect(app.lastFrame()).toContain("ログ 30"));
    app.stdin.write("\x1b[5~");
    await waitFor(() => expect(app.lastFrame()).toContain("ログ 1"));
    expect(app.lastFrame()).not.toContain("ログ 30");
    app.stdin.write("\x1b[1;5F");
    await waitFor(() => expect(app.lastFrame()).toContain("ログ 30"));
  });

  it("マウスの開始（VT 入力の設定）に失敗したら notice を 1 行出す", async () => {
    setLanguage("ja");
    const { client, connected } = fakeClient();
    const startMouse = vi.fn().mockRejectedValue(new Error("失敗"));
    const app = render(React.createElement(TuiApp, { client, startMouse }));
    await connected;
    await waitFor(() => {
      expect(startMouse).toHaveBeenCalledTimes(1);
      expect(app.lastFrame()).toContain(t("tui.mouseUnavailable"));
    });
  });
});

describe("Windows の VT 入力", () => {
  it("分割された SGR シーケンスをつなぎ、前後のキー入力だけ Ink 側に流す", () => {
    const source = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const relay = new MouseInputRelay(source);
    const wheel: string[] = [];
    const rest: string[] = [];
    relay.on("wheel", (direction: string) => wheel.push(direction));
    relay.on("data", (chunk: Buffer) => rest.push(String(chunk)));
    source.write("A\x1b[<64;10;");
    source.write("5MB");
    expect(wheel).toEqual(["up"]);
    expect(rest.join("")).toBe("AB");
    relay.close();
  });

  it("中継 stream が raw mode と ref / unref を元の stdin に転送し、終了時に listener を外す", () => {
    const setRawMode = vi.fn();
    const ref = vi.fn();
    const unref = vi.fn();
    const source = Object.assign(new PassThrough(), { isTTY: true, setRawMode, ref, unref });
    const relay = new MouseInputRelay(source);
    expect(relay.isTTY).toBe(true);
    relay.setRawMode(true);
    relay.ref();
    relay.unref();
    expect(setRawMode).toHaveBeenCalledWith(true);
    expect(ref).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();
    expect(source.listenerCount("data")).toBe(1);
    relay.close();
    expect(source.listenerCount("data")).toBe(0);
    expect(source.isPaused()).toBe(true);
  });
  it("win32 だけで実行関数を呼ぶ", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    await enableVirtualTerminalInput("linux", run);
    expect(run).not.toHaveBeenCalled();
    await enableVirtualTerminalInput("win32", run);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("Ink の raw mode が有効になってからマウスを開始する（VT 入力の設定を含む）", async () => {
    const events: string[] = [];
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: (enabled: boolean) => {
        events.push(enabled ? "raw" : "restore");
      },
    });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    stdout.on("data", () => {});
    const { client } = fakeClient();
    const instance = renderInk(
      React.createElement(TuiApp, {
        client,
        startMouse: async () => {
          events.push("vt");
        },
      }),
      { stdin, stdout, stderr: new PassThrough(), interactive: true, patchConsole: false, exitOnCtrlC: false },
    );
    await waitFor(() => {
      expect(events.indexOf("raw")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("vt")).toBeGreaterThan(events.indexOf("raw"));
    });
    instance.unmount();
    await instance.waitUntilExit();
  });
});

describe("代替画面とマウス", () => {
  it("新着の表示を言語ごとに切り替える", () => {
    setLanguage("ja");
    expect(t("tui.newItems")).toBe("↓ 新着");
    setLanguage("en");
    expect(t("tui.newItems")).toBe("↓ New");
    setLanguage("ja");
  });
  it("Ink に代替画面を使わせ、マウスの開始と終了を逆順の対として出す", async () => {
    const writes: string[] = [];
    expect(TUI_RENDER_OPTIONS.alternateScreen).toBe(true);
    await withMouseTracking(
      value => writes.push(value),
      async mouse => {
        mouse.start();
      },
    );
    expect(writes).toEqual(["\x1b[?1000h\x1b[?1006h", "\x1b[?1006l\x1b[?1000l"]);
    expect(writes).toEqual([ENABLE_MOUSE_TRACKING, DISABLE_MOUSE_TRACKING]);
  });
  it("start するまでマウスを有効にしない（ConPTY は VT 入力の後でないとマウスの設定を端末へ渡さない）", async () => {
    const writes: string[] = [];
    await withMouseTracking(
      value => writes.push(value),
      async () => {},
    );
    expect(writes).toEqual([]);
  });
  it("実行中の例外でも終了シーケンスを出す", async () => {
    const writes: string[] = [];
    await expect(
      withMouseTracking(
        value => writes.push(value),
        async mouse => {
          mouse.start();
          throw new Error("失敗");
        },
      ),
    ).rejects.toThrow("失敗");
    expect(writes.at(-1)).toBe(DISABLE_MOUSE_TRACKING);
  });
  it("シグナルと通常終了の両方が来てもマウスを一度だけ解除し、解除後の start は無視する", async () => {
    const writes: string[] = [];
    await withMouseTracking(
      value => writes.push(value),
      async mouse => {
        mouse.start();
        mouse.stop();
        mouse.start();
      },
    );
    expect(writes).toEqual([ENABLE_MOUSE_TRACKING, DISABLE_MOUSE_TRACKING]);
  });
});

it("reset と version で前の会話のログを消す", async () => {
  const { client, emit, connected } = fakeClient();
  const app = render(React.createElement(TuiApp, { client }));
  await connected;
  for (const boundary of [{ type: "reset" }, { type: "version", version: "v" }] as const) {
    emit({ type: "output", seq: 1, text: "前の会話のログ" });
    await waitFor(() => expect(app.lastFrame()).toContain("前の会話のログ"));
    const frameCount = app.frames.length;
    emit(boundary);
    await waitFor(() => expect(app.frames.length).toBeGreaterThan(frameCount));
    expect(app.lastFrame()).not.toContain("前の会話のログ");
  }
});

it("接続中の言語変更ではログを保持し、以後のラベルと候補を切り替える", async () => {
  setLanguage("ja");
  const { client, emit, connected } = fakeClient();
  const app = render(React.createElement(TuiApp, { client }));
  await connected;
  emit({ type: "version", version: "ja" });
  emit({ type: "output", seq: 1, text: "保持するログ" });
  await waitFor(() => expect(app.lastFrame()).toContain("保持するログ"));
  emit({ type: "version", version: "en" });
  emit({
    type: "state",
    state: {
      project: "app",
      primary: "claude",
      roles: {},
      agents: [],
      tabs: [],
      conversations: [],
      pendingInputs: [],
      pendingMessages: [],
      questions: [],
      processes: [],
      language: "en",
      sandbox: { enabled: false, ready: false },
      limitsUnlimited: false,
      limits: { messages: { value: 8, default: 8 }, reviews: { value: 3, default: 3 }, delegations: { value: 4, default: 4 }, depth: { value: 2, default: 2 } },
    },
  });
  app.stdin.write("/language");
  await waitFor(() => {
    expect(app.lastFrame()).toContain("保持するログ");
    expect(app.lastFrame()).toContain("show or change language");
  });
  setLanguage("ja");
});

it("上端で履歴を読み、reset 後に届いた前の会話の履歴を捨てる", async () => {
  const { client, emit, connected } = fakeClient();
  let finish: ((page: Awaited<ReturnType<FeedClient["history"]>>) => void) | undefined;
  const history = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<FeedClient["history"]>>>(resolve => {
        finish = resolve;
      }),
  );
  client.history = history;
  const app = render(React.createElement(TuiApp, { client }));
  await connected;
  emit({ type: "output", seq: 201, text: "現在のログ" });
  await waitFor(() => expect(app.lastFrame()).toContain("現在のログ"));
  app.stdin.write("\x1b[5~");
  await waitFor(() => expect(history).toHaveBeenCalledWith(201));
  app.stdin.write("\x1b[5~");
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(history).toHaveBeenCalledTimes(1);
  const frameCount = app.frames.length;
  emit({ type: "reset" });
  finish?.({ items: [{ type: "output", seq: 1, text: "古い応答" }], hasMore: false });
  await waitFor(() => expect(app.frames.length).toBeGreaterThan(frameCount));
  expect(app.lastFrame()).not.toContain("古い応答");
});

it("履歴追加後も表示中の行を保ち、hasMore が false なら再取得しない", async () => {
  const { client, emit, connected } = fakeClient();
  const history = vi.fn(async () => ({ items: [{ type: "output" as const, seq: 1, text: "過去のログ" }], hasMore: false }));
  client.history = history;
  const app = render(React.createElement(TuiApp, { client }));
  await connected;
  for (let seq = 201; seq <= 212; seq++) emit({ type: "output", seq, text: `現在の行 ${seq}` });
  await waitFor(() => expect(app.lastFrame()).toContain("現在の行 212"));
  app.stdin.write("\x1b[5~");
  await waitFor(() => {
    expect(history).toHaveBeenCalledWith(201);
    expect(app.lastFrame()).toContain("現在の行 201");
  });
  expect(app.lastFrame()).not.toContain("過去のログ");
  app.stdin.write("\x1b[5~");
  await waitFor(() => expect(app.lastFrame()).toContain("過去のログ"));
  expect(history).toHaveBeenCalledTimes(1);
});

it("今の会話が solo なら下の行に出す", async () => {
  setLanguage("ja");
  const { client, emit, connected } = fakeClient();
  const app = render(React.createElement(TuiApp, { client }));
  await connected;
  const conversation = { id: "c1", startedAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z", sessions: {}, current: true, solo: "codex" as const };
  emit({
    type: "state",
    state: {
      project: "app",
      primary: "claude",
      roles: {},
      agents: [],
      tabs: [],
      conversations: [conversation],
      pendingInputs: [],
      pendingMessages: [],
      questions: [],
      processes: [],
      language: "ja",
      sandbox: { enabled: false, ready: false },
      limitsUnlimited: false,
      limits: { messages: { value: 8, default: 8 }, reviews: { value: 3, default: 3 }, delegations: { value: 4, default: 4 }, depth: { value: 2, default: 2 } },
    },
  });
  await waitFor(() => expect(app.lastFrame()).toContain("app · solo · Codex"));
});
