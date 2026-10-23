import { expect, it } from "vitest";
import { format, MESSAGES } from "../../i18n/i18n.js";
import { formatVerification } from "./verification-format.js";

it.each([
  ["ja", "終了コード不明"],
  ["en", "exit unknown"],
] as const)("%s で結果不明の検査を警告色にしない", (language, unknown) => {
  const result = formatVerification(
    {
      id: "r",
      type: "RESULT",
      from: "codex",
      to: "claude",
      taskId: "T",
      repository: "root",
      createdAt: "now",
      body: "完了",
      evidence: { root: "root", checks: [{ command: "pnpm run check:anim", ran: true }], changed: [] },
    },
    (key, params) => format(MESSAGES[language][key], params),
  );
  expect(result.checks).toEqual([{ text: `pnpm run check:anim: ${unknown}`, warning: false }]);
});
