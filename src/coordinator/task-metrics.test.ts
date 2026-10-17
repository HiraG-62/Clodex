import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../protocol/messages.js";
import { EventBus } from "./event-bus.js";
import { TaskMetricsRecorder, TaskMetricsStore } from "./task-metrics.js";
import { aggregateTaskMetrics, type TaskMetricRecord } from "./task-metrics-summary.js";

const message = (id = "d", type: AgentMessage["type"] = "DELEGATE"): AgentMessage => ({
  id,
  type,
  taskId: "T",
  from: "claude",
  to: "codex",
  body: "x",
  repository: "test",
  createdAt: new Date(0).toISOString(),
});
const setup = () => {
  let time = 1000;
  const path = join(mkdtempSync(join(tmpdir(), "clodex-metrics-")), "metrics.jsonl");
  const store = new TaskMetricsStore(path);
  const bus = new EventBus(() => new Date(time));
  const recorder = new TaskMetricsRecorder("c", store, () => new Date(time));
  bus.subscribe(event => recorder.record(event));
  return {
    bus,
    recorder,
    store,
    path,
    tick: (value: number) => {
      time = value;
    },
  };
};

describe("task の記録", () => {
  it("ターン外の usage と累計を加算せず、次のターンへ持ち越さない", () => {
    const { bus, recorder, store } = setup();
    const usage = () => bus.publish({ kind: "agent", agent: "codex", event: { type: "usage", input: 60, cachedInput: 40, output: 10 } });
    const end = () => bus.publish({ kind: "agent", agent: "codex", event: { type: "turn", result: { status: "completed", text: "" } } });
    usage();
    recorder.start("codex", "first");
    bus.publish({ kind: "agent", agent: "codex", event: { type: "context", tokens: 100, inputTotal: 10_000_000 } });
    bus.publish({ kind: "agent", agent: "codex", event: { type: "input_total", total: 10_000_000 } });
    usage();
    end();
    usage();
    recorder.start("codex", "second");
    end();
    expect(store.snapshot("c").tasks).toMatchObject([
      { taskId: "first", inputTokens: 60, cachedInputTokens: 40, outputTokens: 10 },
      { taskId: "second", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    ]);
  });
  it("配送した task と待ち時間、各ターンの usage の合計を記録する", () => {
    const { bus, recorder, store, tick, path } = setup();
    bus.publish({ kind: "message", message: message() });
    recorder.deliver(message());
    recorder.start("codex", "T");
    bus.publish({ kind: "agent", agent: "codex", event: { type: "context", tokens: 10, inputTotal: 10_000_100 } });
    bus.publish({ kind: "agent", agent: "codex", event: { type: "usage", input: 30, cachedInput: 20, output: 4 } });
    bus.publish({ kind: "agent", agent: "codex", event: { type: "usage", input: 30, cachedInput: 20, output: 4 } });
    tick(4000);
    bus.publish({ kind: "agent", agent: "codex", event: { type: "turn", result: { status: "completed", text: "" } } });
    recorder.start("codex", "T");
    bus.publish({ kind: "agent", agent: "codex", event: { type: "usage", input: 40, cachedInput: 10, output: 4 } });
    tick(5000);
    bus.publish({ kind: "agent", agent: "codex", event: { type: "turn", result: { status: "failed", text: "" } } });
    expect(store.snapshot("c").tasks[0]).toMatchObject({ turns: 2, inputTokens: 100, cachedInputTokens: 50, outputTokens: 12, durationMs: 4000, waitMs: 1000 });
    expect(new TaskMetricsStore(path).snapshot("c")).toEqual(store.snapshot("c"));
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(4);
  });
  it("人の入力・自発・compact・別 task の割り込みを未割当にし、session の変更を扱う", () => {
    const { bus, recorder, store } = setup();
    const end = () => bus.publish({ kind: "agent", agent: "codex", event: { type: "turn", result: { status: "interrupted", text: "" } } });
    for (const _kind of ["human", "spontaneous", "compact"]) {
      recorder.start("codex");
      end();
    }
    recorder.start("codex", "T");
    recorder.steer("codex", "other");
    end();
    recorder.start("codex", "T");
    bus.publish({ kind: "agent", agent: "codex", event: { type: "usage", input: 60, cachedInput: 40, output: 10 } });
    end();
    recorder.start("codex", "T");
    bus.publish({ kind: "agent", agent: "codex", event: { type: "session", sessionId: "new" } });
    bus.publish({ kind: "agent", agent: "codex", event: { type: "usage", input: 20, cachedInput: 10, output: 5 } });
    recorder.steer("codex", "T");
    end();
    expect(store.snapshot("c").unassigned).toMatchObject({ turns: 4 });
    expect(store.snapshot("c").tasks[0]).toMatchObject({ turns: 2, inputTokens: 80, cachedInputTokens: 50, outputTokens: 15 });
  });
  it("会話を分け、RESULT 時点の累計を保持し、破損行と書込失敗で作業を止めない", () => {
    const { bus, recorder, store, path } = setup();
    recorder.start("codex", "T");
    bus.publish({ kind: "agent", agent: "codex", event: { type: "turn", result: { status: "completed", text: "" } } });
    bus.publish({ kind: "message", message: { ...message("r", "RESULT"), status: "done" } });
    bus.publish({ kind: "message", message: message("q", "QUESTION") });
    expect(store.snapshot("c").results.r).toMatchObject({ turns: 1, questions: 0 });
    expect(store.snapshot("c").tasks[0]?.questions).toBe(1);
    expect(store.snapshot("other").tasks).toEqual([]);
    writeFileSync(path, `${readFileSync(path, "utf8")}\n{broken\n`);
    expect(new TaskMetricsStore(path).snapshot("c")).toEqual(store.snapshot("c"));
    const broken = new TaskMetricsStore(join(path, "impossible"));
    expect(() => broken.append({ kind: "delivery", conversationId: "c", at: new Date(0).toISOString(), taskId: "T", messageId: "d", waitMs: 1 })).not.toThrow();
    expect(broken.snapshot("c").tasks[0]?.waitMs).toBe(1);
  });
  it("RESULT の送信ターン終了まで反映し、後続の再依頼で過去カードを変えない", () => {
    const { bus, recorder, store, path, tick } = setup();
    recorder.start("codex", "T");
    bus.publish({ kind: "message", message: { ...message("r", "RESULT"), from: "codex", to: "claude", status: "done" } });
    expect(store.snapshot("c").results.r?.turns).toBe(0);
    tick(2000);
    bus.publish({ kind: "agent", agent: "codex", event: { type: "usage", input: 80, cachedInput: 20, output: 10 } });
    bus.publish({ kind: "agent", agent: "codex", event: { type: "turn", result: { status: "completed", text: "" } } });
    expect(store.snapshot("c").results.r).toMatchObject({ turns: 1, inputTokens: 80, outputTokens: 10 });
    bus.publish({ kind: "message", message: message("d2") });
    recorder.start("codex", "T");
    tick(3000);
    bus.publish({ kind: "agent", agent: "codex", event: { type: "turn", result: { status: "completed", text: "" } } });
    expect(store.snapshot("c").tasks[0]?.turns).toBe(2);
    expect(store.snapshot("c").results.r?.turns).toBe(1);
    expect(new TaskMetricsStore(path).snapshot("c")).toEqual(store.snapshot("c"));
  });
});

describe("task の集計", () => {
  it("再依頼・理由・受入完了・初回受入を数える", () => {
    const records: TaskMetricRecord[] = [
      { ...message(), kind: "message", conversationId: "c", at: "2026-01-01T00:00:00Z" },
      { ...message("r", "RESULT"), kind: "message", conversationId: "c", at: "2026-01-01T00:01:00Z", status: "done" },
      { ...message("a", "ADD"), kind: "message", conversationId: "c", at: "2026-01-01T00:02:00Z", rework: "spec" },
      { ...message("f", "FIX"), kind: "message", conversationId: "c", at: "2026-01-01T00:03:00Z", rework: "impl" },
      { ...message("d2"), kind: "message", conversationId: "c", at: "2026-01-01T00:04:00Z", rework: "check", relatesTo: "previous" },
      { ...message("r2", "RESULT"), kind: "message", conversationId: "c", at: "2026-01-01T00:05:00Z", status: "approved" },
    ];
    expect(aggregateTaskMetrics(records.slice(0, 2)).tasks[0]).toMatchObject({ accepted: true, firstAccepted: true });
    expect(aggregateTaskMetrics(records.slice(0, 3)).tasks[0]?.accepted).toBe(false);
    expect(aggregateTaskMetrics(records).tasks[0]).toMatchObject({
      results: 2,
      delegates: 2,
      retries: 3,
      rework: { spec: 1, impl: 1, check: 1 },
      accepted: true,
      firstAccepted: false,
      elapsedMs: 300000,
    });
  });
});
