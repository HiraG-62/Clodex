// 質問欄で 1 問ずつ答えるための計算（DESIGN.md Web UI の質問欄）。
// ブラウザへ関数のまま埋め込むため、外部を参照しない関数として書く（型の import のみ）
import type { UserQuestion } from "../../protocol/questions.js";

export interface QuestionDraft { selected: ReadonlyArray<ReadonlySet<number>>; other: readonly string[] }

export function questionAnswers(questions: readonly UserQuestion[], draft: QuestionDraft): string[][] {
  return questions.map((question, index) => [
    ...question.options.filter((_option, optionIndex) => draft.selected[index]?.has(optionIndex)).map((option) => option.label),
    ...(draft.other[index]?.trim() ? [draft.other[index]!.trim()] : []),
  ]);
}

// 今の質問より後ろの未回答の質問。後ろに無ければ前から探す
export function nextUnanswered(questions: readonly UserQuestion[], draft: QuestionDraft, current: number): number | undefined {
  const answered = (index: number) => Boolean(draft.selected[index]?.size || draft.other[index]?.trim());
  const order = [...questions.keys()].map((offset) => (current + 1 + offset) % questions.length);
  return order.find((index) => !answered(index));
}
