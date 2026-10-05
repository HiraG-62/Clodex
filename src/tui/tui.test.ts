import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { setLanguage } from "../i18n/i18n.js";
import type { FeedItem } from "../web/web-feed.js";
import type { FeedClient } from "./feed-client.js";
import { TuiApp } from "./tui.js";

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

  it("完了したターンを Static に書き出す", async () => {
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
});
