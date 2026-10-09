import { describe, expect, it } from "vitest";
import { isSendKey } from "./send-key.js";

const key = (init: { key?: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}) => ({
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  ...init,
});

describe("isSendKey", () => {
  it("既定は Enter で送信し、Shift+Enter は改行", () => {
    expect(isSendKey(key(), "enter", false)).toBe(true);
    expect(isSendKey(key({ shiftKey: true }), "enter", false)).toBe(false);
  });

  it("Ctrl+Enter の設定では Ctrl（Mac は Cmd）+Enter だけで送信する", () => {
    expect(isSendKey(key(), "ctrlEnter", false)).toBe(false);
    expect(isSendKey(key({ shiftKey: true }), "ctrlEnter", false)).toBe(false);
    expect(isSendKey(key({ ctrlKey: true }), "ctrlEnter", false)).toBe(true);
    expect(isSendKey(key({ metaKey: true }), "ctrlEnter", false)).toBe(true);
  });

  it("スマホと Enter 以外のキーでは送信しない", () => {
    expect(isSendKey(key(), "enter", true)).toBe(false);
    expect(isSendKey(key({ ctrlKey: true }), "ctrlEnter", true)).toBe(false);
    expect(isSendKey(key({ key: "Tab" }), "enter", false)).toBe(false);
  });
});
