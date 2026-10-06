import { expect, it } from "vitest";
import { isShellInput } from "./shell-input.js";

it("先頭の ! だけをコマンド入力として判定する", () => {
  for (const text of ["!", "!pnpm test", "!echo a\nb"]) expect(isShellInput(text)).toBe(true);
  for (const text of ["", "hello!", " !pwd", "/status", "@claude !pwd"]) expect(isShellInput(text)).toBe(false);
});
