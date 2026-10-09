import { describe, expect, it } from "vitest";
import { en, ja } from "../i18n/messages.js";
import { formatNotification, shouldPushNotification } from "./notify-format.js";

const base = { projectRoot: "C:\\dev\\Clodex", conversationTitle: "改善", agent: "claude" as const };

describe("formatNotification", () => {
  it.each([
    ["work", "作業完了しました。", "Work finished."],
    ["reply", "応答しました。", "Replied."],
    ["failed", "失敗しました。", "Failed."],
    ["interrupted", "中断しました。", "Interrupted."],
    ["question", "ユーザの回答待ちです。", "Waiting for your answer."],
  ] as const)("%s の日英の本文を統一する", (kind, japanese, english) => {
    expect(formatNotification({ ...base, kind }, ja)).toMatchObject({ title: "Clodex【Clodex】「改善」", body: `${japanese}（Claude）` });
    expect(formatNotification({ ...base, kind }, en)).toMatchObject({ title: "Clodex【Clodex】「改善」", body: `${english} (Claude)` });
  });

  it("会話名なし・上限・エラー・notice を扱う", () => {
    expect(formatNotification({ ...base, conversationTitle: undefined, kind: "reply" }, ja).title).toBe("Clodex【Clodex】「（入力なし）」");
    expect(formatNotification({ ...base, kind: "limitHold", time: "10/9 01:00" }, ja).body).toBe("利用枠の上限で停止しました。再開 10/9 01:00。（Claude）");
    expect(formatNotification({ ...base, kind: "limitHold", time: "10/9 01:00" }, en).body).toBe("Stopped at usage limit. Resumes 10/9 01:00. (Claude)");
    expect(formatNotification({ ...base, kind: "error", line: "詳細\n続き" }, ja).body).toBe("エラー: 詳細（Claude）");
    expect(formatNotification({ ...base, kind: "error", line: "details\nmore" }, en).body).toBe("Error: details (Claude)");
    expect(formatNotification({ ...base, kind: "notice", line: "お知らせ", agent: undefined }, ja).body).toBe("お知らせ");
    expect(formatNotification({ ...base, kind: "notice", line: "Notice", agent: undefined }, en).body).toBe("Notice");
  });
});

it("Web Push はターン終了と質問に限る", () => {
  for (const kind of ["work", "reply", "failed", "interrupted", "question"] as const) expect(shouldPushNotification(kind)).toBe(true);
  for (const kind of ["limitHold", "error", "notice"] as const) expect(shouldPushNotification(kind)).toBe(false);
});
