import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { CoordinatorEvent, CoordinatorEventInput } from "../coordinator/event-bus.js";
import type { HistoryItem } from "../web/web-feed.js";
import { ConversationTranscript, transcriptPath } from "./conversation-transcript.js";

const at = "2026-10-08T00:00:00.000Z";
const event = (item: CoordinatorEventInput): CoordinatorEvent => ({ ...item, at });
const path = () => transcriptPath(join(mkdtempSync(join(tmpdir(), "clodex-transcript-")), "conversations.json"), "conversation-1");

it("会話の本文だけを時系列で保存し、別の Agent とユーザーのやり取りも返す", () => {
  const transcript = new ConversationTranscript(path());
  transcript.append(event({ kind: "human", agent: "claude", text: "要件" }));
  transcript.append(event({ kind: "agent", agent: "claude", event: { type: "text", text: "作業中" } }));
  transcript.append(event({ kind: "agent", agent: "claude", event: { type: "turn", result: { status: "completed", text: "設計案" } } }));
  transcript.append(event({ kind: "human", agent: "codex", text: "追加の依頼" }));
  transcript.append(event({ kind: "agent", agent: "codex", event: { type: "tool", name: "Edit", input: "src/a.ts" } }));
  transcript.append(event({ kind: "agent", agent: "codex", event: { type: "turn", result: { status: "completed", text: "実装結果" } } }));
  expect(transcript.page()).toEqual({ entries: [
    { at, kind: "input", from: "human", to: "claude", body: "要件" },
    { at, kind: "reply", from: "claude", body: "設計案" },
    { at, kind: "input", from: "human", to: "codex", body: "追加の依頼" },
    { at, kind: "reply", from: "codex", body: "実装結果" },
  ] });
  expect(new ConversationTranscript(transcript.filePath).page().entries).toHaveLength(4);
});

it("formal message と質問・回答の本文を返し、古いページへたどれる", () => {
  const transcript = new ConversationTranscript(path());
  transcript.append(event({ kind: "message", message: { id: "m1", from: "claude", to: "codex", type: "DELEGATE", taskId: "T", body: "実装して", repository: "C:\\app", createdAt: at } }));
  transcript.append(event({ kind: "question", id: "q1", agent: "codex", questions: [{ question: "どちらですか", options: [{ label: "A" }, { label: "B" }] }] }));
  transcript.append(event({ kind: "answer", id: "q1", agent: "codex", answers: [["A"]] }));
  const newer = transcript.page({ limit: 2 });
  expect(newer).toEqual({ entries: [
    { at, kind: "question", from: "codex", to: "human", body: "どちらですか" },
    { at, kind: "answer", from: "human", to: "codex", body: "A" },
  ], nextBefore: 1 });
  expect(transcript.page({ before: newer.nextBefore, limit: 2 })).toEqual({ entries: [
    { at, kind: "message", from: "claude", to: "codex", body: "実装して" },
  ] });
});

it("保存済み feed から初期化し、続く event を重複なく足す", () => {
  const transcript = new ConversationTranscript(path());
  const history: HistoryItem[] = [{ type: "event", seq: 1, event: event({ kind: "human", agent: "claude", text: "以前の入力" }) }];
  transcript.seed(history);
  transcript.seed(history);
  transcript.append(event({ kind: "agent", agent: "claude", event: { type: "turn", result: { status: "completed", text: "今の返答" } } }));
  expect(transcript.page().entries.map((entry) => entry.body)).toEqual(["以前の入力", "今の返答"]);
});

it("会話 ID ごとに保存先を分け、途中の作業と出力は初期履歴にも含めない", () => {
  const statePath = join(mkdtempSync(join(tmpdir(), "clodex-transcript-")), "conversations.json");
  const first = new ConversationTranscript(transcriptPath(statePath, "first"));
  const second = new ConversationTranscript(transcriptPath(statePath, "second"));
  first.seed([
    { type: "event", seq: 1, event: event({ kind: "human", agent: "claude", text: "会話 1" }) },
    { type: "event", seq: 2, event: event({ kind: "agent", agent: "claude", event: { type: "text", text: "途中の作業" } }) },
    { type: "output", seq: 3, text: "コマンド出力" },
    { type: "event", seq: 4, event: event({ kind: "notice", text: "通知" }) },
  ]);
  second.seed([{ type: "event", seq: 1, event: event({ kind: "human", agent: "codex", text: "会話 2" }) }]);
  expect(first.page().entries.map((entry) => entry.body)).toEqual(["会話 1"]);
  expect(second.page().entries.map((entry) => entry.body)).toEqual(["会話 2"]);
});
