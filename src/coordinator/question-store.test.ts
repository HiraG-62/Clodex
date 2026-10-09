import { describe, expect, it } from "vitest";
import { QuestionStore } from "./question-store.js";

const input = { questions: [{ question: "どちらですか", header: "選択", options: [{ label: "A" }, { label: "B" }] }] };

describe("QuestionStore", () => {
  it("質問を保存し、回答文と人の補足を組み立てて取り除く", () => {
    const store = new QuestionStore(() => "id");
    const asked = store.ask("claude", input);
    expect(asked.result).toEqual({ ok: true, id: "q_id" });
    expect(store.pending()).toHaveLength(1);
    const answered = store.answer("q_id", [["A"]]);
    expect(answered).toMatchObject({ ok: true, text: "Answer to your question q_id:\n- 選択: A", context: ["選択: A"] });
    expect(store.pending()).toEqual([]);
  });

  it("不正な回答では質問を残す", () => {
    const store = new QuestionStore(() => "id");
    store.ask("codex", input);
    expect(store.answer("q_id", [])).toMatchObject({ ok: false });
    expect(store.pending()).toHaveLength(1);
  });

  it("不正な質問は保存しない", () => {
    const store = new QuestionStore(() => "id");
    expect(store.ask("claude", { questions: [] }).result).toMatchObject({ ok: false });
    expect(store.pending()).toEqual([]);
  });
});
