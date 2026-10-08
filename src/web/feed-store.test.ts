import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FeedStore, feedDirPath } from "./feed-store.js";
import { CONTEXT_INSTRUCTION } from "../context/conversation-instruction.js";
import type { HistoryItem } from "./web-feed.js";

const makeDir = () => join(mkdtempSync(join(tmpdir(), "clodex-feed-")), "nested.feed");
const output = (seq: number): HistoryItem => ({ type: "output", seq, text: `line ${seq}` });

describe("feedDirPath", () => {
  it("会話の履歴と同じ名前の .feed ディレクトリにする", () => {
    expect(feedDirPath(join("C:\\home", "E--dev-app-1a2b3c4d.json"))).toBe(join("C:\\home", "E--dev-app-1a2b3c4d.feed"));
  });
});

describe("FeedStore", () => {
  it("以前に保存した /context の内部指示を表示から除く", () => {
    const store = new FeedStore(makeDir());
    store.append("a", { type: "event", seq: 1, event: {
      kind: "human", agent: "codex", at: "2026-10-08T00:00:00Z", text: `依頼\n\n${CONTEXT_INSTRUCTION}`,
    } });
    expect(store.load("a")).toMatchObject([{ event: { text: "依頼" } }]);
  });
  it("command の識別情報とフィールドなしの旧 output をそのまま保存する", () => {
    const store = new FeedStore(makeDir());
    const items: HistoryItem[] = [
      output(1),
      { type: "output", seq: 2, text: "$ run", command: { id: 1, phase: "start" } },
      { type: "output", seq: 3, text: "exit 0 (1s)", command: { id: 1, phase: "exit" } },
    ];
    for (const item of items) store.append("a", item);
    expect(store.load("a")).toEqual(items);
  });
  it("会話ごとに追記し、読み込める。保存が無い会話は空", () => {
    const store = new FeedStore(makeDir());
    store.append("a", output(1));
    store.append("b", output(2));
    store.append("a", output(3));
    expect(store.load("a")).toEqual([output(1), output(3)]);
    expect(store.load("none")).toEqual([]);
  });

  it("直近 limit 件だけを返し、2 倍を超えていたら直近だけに書き直す", () => {
    const dir = makeDir();
    const store = new FeedStore(dir, 2);
    for (let i = 1; i <= 4; i++) store.append("a", output(i));
    expect(store.load("a")).toEqual([output(3), output(4)]);
    expect(readFileSync(join(dir, "a.jsonl"), "utf8").trim().split("\n")).toHaveLength(4);

    store.append("a", output(5));
    expect(store.load("a")).toEqual([output(4), output(5)]);
    expect(readFileSync(join(dir, "a.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("壊れた行は読み飛ばす", () => {
    const dir = makeDir();
    const store = new FeedStore(dir);
    store.append("a", output(1));
    writeFileSync(join(dir, "a.jsonl"), `${readFileSync(join(dir, "a.jsonl"), "utf8")}{broken\n{"type":"unknown"}\n{"type":"event","event":null}\n{"type":"event","event":{}}\n{"type":"event","event":{"kind":"agent"}}\n`);
    store.append("a", output(2));
    expect(store.load("a")).toEqual([output(1), output(2)]);
  });

  it("closeUnfinished は全会話の終わっていないターンを中断としてファイルに書き足す", () => {
    const store = new FeedStore(makeDir());
    const agentEvent = (seq: number, agent: "claude" | "codex", event: { type: "turn_started" } | { type: "turn"; result: { status: "completed"; text: string } }): HistoryItem =>
      ({ type: "event", seq, event: { kind: "agent", agent, at: "2026-10-05T12:00:00Z", event } });
    store.append("a", agentEvent(1, "claude", { type: "turn_started" }));
    store.append("a", agentEvent(2, "codex", { type: "turn_started" }));
    store.append("a", agentEvent(3, "codex", { type: "turn", result: { status: "completed", text: "done" } }));
    store.append("b", agentEvent(1, "codex", { type: "turn_started" }));
    store.closeUnfinished();
    // 復旧で同じ Agent が作業中でも、前の Hub のターンは中断のまま
    store.append("a", agentEvent(4, "claude", { type: "turn_started" }));
    const loaded = store.load("a", new Set(["claude"]));
    const turns = loaded.flatMap((item) => item.type === "event" && item.event.kind === "agent" ? [`${item.event.agent}:${item.event.event.type}${item.event.event.type === "turn" ? `:${item.event.event.result.status}` : ""}`] : []);
    expect(turns).toEqual(["claude:turn_started", "codex:turn_started", "codex:turn:completed", "claude:turn:interrupted", "claude:turn_started"]);
    expect(store.load("b").at(-1)).toMatchObject({ event: { agent: "codex", event: { type: "turn", result: { status: "interrupted" } } } });
    store.closeUnfinished();
    expect(readFileSync(join(store.directory, "b.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("保存時に終わっていないターンを読み込み時に interrupted にする", () => {
    const store = new FeedStore(makeDir());
    store.append("a", { type: "event", seq: 1, event: { kind: "agent", agent: "claude", at: "2026-10-05T12:00:00Z", event: { type: "turn_started" } } });
    store.append("a", { type: "event", seq: 2, event: { kind: "agent", agent: "claude", at: "2026-10-05T12:00:01Z", event: { type: "text", text: "途中" } } });
    const loaded = store.load("a");
    expect(loaded.at(-1)).toMatchObject({ type: "event", event: { kind: "agent", agent: "claude", event: { type: "turn", result: { status: "interrupted" } } } });
    expect(store.load("a")).toHaveLength(3);
  });

  it("読めないファイルは空の feed として扱う（起動や会話の切り替えを妨げない）", () => {
    const dir = makeDir();
    // ファイルの代わりにディレクトリがあると読めない
    mkdirSync(join(dir, "a.jsonl"), { recursive: true });
    expect(new FeedStore(dir).load("a")).toEqual([]);
  });

  it("prune は残す会話以外の feed を削除する", () => {
    const dir = makeDir();
    const store = new FeedStore(dir);
    store.append("keep", output(1));
    store.append("drop", output(2));
    store.prune(["keep"]);
    expect(existsSync(join(dir, "keep.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "drop.jsonl"))).toBe(false);
  });

  it("ディレクトリが無くても prune できる", () => {
    expect(() => new FeedStore(makeDir()).prune([])).not.toThrow();
  });
});

it("作業中の Agent の未完了ターンは中断にしない", () => {
  const store = new FeedStore(makeDir());
  for (const agent of ["claude", "codex"] as const) store.append("a", {
    type: "event", seq: 1, event: { kind: "agent", agent, at: "2026-10-05T12:00:00Z", event: { type: "turn_started" } },
  });
  const loaded = store.load("a", new Set(["claude"]));
  expect(loaded).toHaveLength(3);
  expect(loaded.at(-1)).toMatchObject({ event: { agent: "codex", event: { type: "turn", result: { status: "interrupted" } } } });
  expect(store.load("a", new Set(["claude", "codex"]))).toHaveLength(2);
});

it("質問と回答の event を保存して読み直す", () => {
  const store = new FeedStore(makeDir());
  const items: HistoryItem[] = [
    { type: "event", seq: 1, event: { kind: "question", id: "q1", agent: "claude", at: "now", questions: [{ question: "方針は", options: [{ label: "A" }, { label: "B" }] }] } },
    { type: "event", seq: 2, event: { kind: "answer", id: "q1", agent: "claude", at: "now", answers: [["B"]] } },
  ];
  for (const item of items) store.append("c1", item);
  expect(store.load("c1")).toEqual(items);
});
