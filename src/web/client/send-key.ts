// 入力欄のキーで送信するかを決める（DESIGN.md §17 Web UI 入力）。
// ブラウザ側にそのまま埋め込むため、外部のものを参照しない 1 つの関数として書く
export type SendKey = "enter" | "ctrlEnter";

export function isSendKey(
  event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  sendKey: SendKey,
  mobile: boolean,
): boolean {
  if (mobile || event.key !== "Enter") return false;
  if (sendKey === "ctrlEnter") return event.ctrlKey || event.metaKey;
  return !event.shiftKey;
}
