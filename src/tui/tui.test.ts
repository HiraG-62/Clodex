import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { setLanguage, t } from "../i18n/i18n.js";
import type { FeedItem } from "../web/web-feed.js";
import type { FeedClient } from "./feed-client.js";
import { DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING, TUI_RENDER_OPTIONS, TuiApp, withMouseTracking } from "./tui.js";

afterEach(cleanup);

const fakeClient = () => {
  let listener: (item: FeedItem) => void = () => {};
  const client: FeedClient = {
    connect: async (onItem) => { listener = onItem; return () => {}; },
    send: async () => {}, files: async () => [],
  };
  return { client, emit: (item: FeedItem) => listener(item) };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("TuiApp", () => {
  it("作業中のターンと候補を下部に表示する", async () => {
    setLanguage("ja");
    const { client, emit } = fakeClient();
    const app = render(React.createElement(TuiApp, { client }));
    await tick();
    emit({ type: "event", seq: 1, event: { kind: "agent", agent: "claude", at: new Date().toISOString(), event: { type: "turn_started" } } });
    emit({ type: "event", seq: 2, event: { kind: "agent", agent: "claude", at: new Date().toISOString(), event: { type: "text", text: "方針を確認" } } });
    app.stdin.write("/");
    await tick();
    expect(app.lastFrame()).toContain("Claude · 作業しています");
    expect(app.lastFrame()).toContain("方針を確認");
    expect(app.lastFrame()).toContain("/status");
  });

  it("完了したターンをログに表示する", async () => {
    setLanguage("ja");
    const { client, emit } = fakeClient();
    const app = render(React.createElement(TuiApp, { client }));
    await tick();
    emit({ type: "event", seq: 1, event: { kind: "agent", agent: "codex", at: new Date().toISOString(), event: { type: "turn_started" } } });
    emit({ type: "event", seq: 2, event: { kind: "agent", agent: "codex", at: new Date().toISOString(), event: { type: "turn", result: { status: "completed", text: "# 完了しました" } } } });
    await tick();
    expect(app.frames.join("\n")).toContain("完了しました");
    expect(app.frames.join("\n")).toContain("Codex · 完了");
  });

  it("Ctrl+O 以後に完了するターンの作業を展開する", async () => {
    setLanguage("ja");
    const { client, emit } = fakeClient();
    const app = render(React.createElement(TuiApp, { client }));
    await tick();
    app.stdin.write("\x0f");
    emit({ type: "event", seq: 1, event: { kind: "agent", agent: "claude", at: new Date().toISOString(), event: { type: "turn_started" } } });
    emit({ type: "event", seq: 2, event: { kind: "agent", agent: "claude", at: new Date().toISOString(), event: { type: "tool", name: "Read", input: "src/a.ts" } } });
    emit({ type: "event", seq: 3, event: { kind: "agent", agent: "claude", at: new Date().toISOString(), event: { type: "turn", result: { status: "completed", text: "終了" } } } });
    await tick();
    expect(app.frames.join("\n")).toContain("Read: src/a.ts");
  });

  it("Ctrl+O で過去のターンの作業も開閉する", async () => {
    setLanguage("ja");
    const { client, emit } = fakeClient();
    const app = render(React.createElement(TuiApp, { client }));
    await tick();
    emit({ type: "event", seq: 1, event: { kind: "agent", agent: "claude", at: new Date().toISOString(), event: { type: "turn_started" } } });
    emit({ type: "event", seq: 2, event: { kind: "agent", agent: "claude", at: new Date().toISOString(), event: { type: "tool", name: "Read", input: "old.ts" } } });
    emit({ type: "event", seq: 3, event: { kind: "agent", agent: "claude", at: new Date().toISOString(), event: { type: "turn", result: { status: "completed", text: "完了" } } } });
    await tick();
    expect(app.lastFrame()).not.toContain("Read: old.ts");
    app.stdin.write("\x0f");
    await tick();
    expect(app.lastFrame()).toContain("Read: old.ts");
  });

  it("SGR マウスのクリックを入力欄に入れない", async () => {
    setLanguage("ja");
    const { client } = fakeClient();
    const app = render(React.createElement(TuiApp, { client }));
    await tick();
    app.stdin.write("\x1b[<0;12;8M");
    await tick();
    expect(app.lastFrame()).toContain("メッセージ");
    expect(app.lastFrame()).not.toContain("<0;12;8");
  });

  it("空の入力欄はカーソルと同じ行に薄い案内を出し、入力すると消す", async () => {
    setLanguage("ja");
    const { client } = fakeClient();
    const app = render(React.createElement(TuiApp, { client }));
    await tick();
    const lines = (app.lastFrame() ?? "").split("\n");
    const inputLine = lines.findIndex((line) => line.includes("メッセージ"));
    expect(lines[inputLine + 1]).toContain("╰");
    app.stdin.write("a");
    await tick();
    expect(app.lastFrame()).not.toContain("メッセージ");
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
    await withMouseTracking((value) => writes.push(value), async () => {});
    expect(writes).toEqual(["\x1b[?1000h\x1b[?1006h", "\x1b[?1006l\x1b[?1000l"]);
    expect(writes).toEqual([ENABLE_MOUSE_TRACKING, DISABLE_MOUSE_TRACKING]);
  });
  it("実行中の例外でも終了シーケンスを出す", async () => {
    const writes: string[] = [];
    await expect(withMouseTracking((value) => writes.push(value), async () => { throw new Error("失敗"); })).rejects.toThrow("失敗");
    expect(writes.at(-1)).toBe(DISABLE_MOUSE_TRACKING);
  });
  it("シグナルと通常終了の両方が来てもマウスを一度だけ解除する", async () => {
    const writes: string[] = [];
    await withMouseTracking((value) => writes.push(value), async (stop) => { stop(); });
    expect(writes).toEqual([ENABLE_MOUSE_TRACKING, DISABLE_MOUSE_TRACKING]);
  });
});
