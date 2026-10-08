import { expect, it } from "vitest";
import { limitChanges } from "./limit-changes.js";

const current = { messages: 8, reviews: 3, delegations: 4, depth: 2 };
const defaults = { messages: 8, reviews: 3, delegations: 4, depth: 2 };
const draft = { messages: "8", reviews: "3", delegations: "4", depth: "2" };

it("変更された上限だけを返す", () => {
  expect(limitChanges(current, { ...draft, messages: "16", depth: "5" }, defaults)).toEqual({ valid: true, changes: [{ name: "messages", value: 16 }, { name: "depth", value: 5 }] });
  expect(limitChanges(current, draft, defaults)).toEqual({ valid: true, changes: [] });
});

it("空欄は既定値として扱う", () => {
  expect(limitChanges({ ...current, reviews: 6 }, { ...draft, reviews: "" }, defaults)).toEqual({ valid: true, changes: [{ name: "reviews", value: 3 }] });
  expect(limitChanges(current, { messages: "", reviews: "", delegations: "", depth: "" }, defaults)).toEqual({ valid: true, changes: [] });
});

it("小数・範囲外を無効にする", () => {
  for (const value of ["1.5", "0", "101", "x"]) {
    expect(limitChanges(current, { ...draft, reviews: value }, defaults).valid).toBe(false);
  }
});
