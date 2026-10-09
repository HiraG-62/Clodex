import { describe, expect, it } from "vitest";
import { nextUnanswered, questionAnswers } from "./question-flow.js";

const question = (label: string, multiSelect = false) => ({ question: label, options: [{ label: `${label}1` }, { label: `${label}2` }], multiSelect });
const QUESTIONS = [question("a"), question("b", true), question("c")];
const draft = (selected: number[][], other: string[] = ["", "", ""]) => ({ selected: selected.map(indexes => new Set(indexes)), other });

describe("questionAnswers", () => {
  it("選んだ選択肢の label と「その他」の入力を質問ごとに並べる", () => {
    expect(questionAnswers(QUESTIONS, draft([[1], [0, 1], []], ["", " 追加 ", "自由"]))).toEqual([["a2"], ["b1", "b2", "追加"], ["自由"]]);
  });
});

describe("nextUnanswered", () => {
  it("今の質問より後の未回答の質問を返し、後ろに無ければ前から探す", () => {
    expect(nextUnanswered(QUESTIONS, draft([[0], [], []]), 0)).toBe(1);
    expect(nextUnanswered(QUESTIONS, draft([[], [1], [0]]), 1)).toBe(0);
  });
  it("すべて答えていれば undefined", () => {
    expect(nextUnanswered(QUESTIONS, draft([[0], [1], []], ["", "", "x"]), 2)).toBeUndefined();
  });
});
