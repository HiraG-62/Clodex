import { describe, expect, it } from "vitest";
import { askUserSchema, askUserShape } from "./questions.js";

describe("ask_user の選択肢", () => {
  it("推奨の印を説明とは別に保持する", () => {
    const parsed = askUserSchema.parse({
      questions: [
        {
          question: "どれにする？",
          options: [{ label: "A", description: "速い", recommended: true }, { label: "B" }],
        },
      ],
    });
    expect(parsed.questions[0]?.options).toEqual([{ label: "A", description: "速い", recommended: true }, { label: "B" }]);
  });
  it("tool の schema で推奨の印の使い方を伝える", () => {
    expect(JSON.stringify(askUserShape.questions.toJSONSchema())).toContain("recommended");
  });
});
