import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type PushSend, PushService } from "./push.js";

const SUBSCRIPTION = { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "p", auth: "a" } };
const setup = (send: PushSend = async () => {}) => {
  const dir = mkdtempSync(join(tmpdir(), "clodex-push-"));
  const sent: Array<{ endpoint: string; payload: string }> = [];
  const push = new PushService(dir, async (subscription, payload, vapid) => {
    sent.push({ endpoint: subscription.endpoint, payload });
    expect(vapid.subject).toBe("https://github.com/HiraG-62/Clodex");
    await send(subscription, payload, vapid);
  });
  return { dir, push, sent };
};

describe("PushService", () => {
  it("VAPID の鍵を初回に作って保存し、次からは同じ鍵を使う", () => {
    const { dir, push } = setup();
    const key = push.publicKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(new PushService(dir).publicKey()).toBe(key);
  });

  it("購読を保存して id を返し、不正な購読は拒否する", () => {
    const { dir, push } = setup();
    const id = push.subscribe(SUBSCRIPTION);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(push.subscribe(SUBSCRIPTION)).toBe(id);
    expect(JSON.parse(readFileSync(join(dir, "subscriptions.json"), "utf8"))).toEqual([{ id, ...SUBSCRIPTION }]);
    expect(push.subscribe({ endpoint: "x" })).toBeUndefined();
    push.unsubscribe(id!);
    expect(JSON.parse(readFileSync(join(dir, "subscriptions.json"), "utf8"))).toEqual([]);
  });

  it("画面が見えている端末には送らず、接続が切れたら送る", async () => {
    const { push, sent } = setup();
    const id = push.subscribe(SUBSCRIPTION)!;
    const stream = push.connect(id, true);
    await push.notify({ title: "完了", body: "Claude: ok" });
    expect(sent).toEqual([]);
    push.setVisible(id, false);
    await push.notify({ title: "完了", body: "1" });
    expect(sent).toHaveLength(1);
    push.setVisible(id, true);
    stream.close();
    await push.notify({ title: "完了", body: "2" });
    expect(sent.map(entry => JSON.parse(entry.payload))).toEqual([
      { title: "完了", body: "1" },
      { title: "完了", body: "2" },
    ]);
  });

  it("410 の購読は消し、ほかの失敗は残す", async () => {
    const failures = [Object.assign(new Error("gone"), { statusCode: 410 }), new Error("network")];
    const { push } = setup(async () => {
      throw failures.shift();
    });
    const gone = push.subscribe(SUBSCRIPTION)!;
    await push.notify({ title: "t", body: "b" });
    expect(push.has(gone)).toBe(false);
    const kept = push.subscribe({ ...SUBSCRIPTION, endpoint: "https://fcm.googleapis.com/x" })!;
    await push.notify({ title: "t", body: "b" });
    expect(push.has(kept)).toBe(true);
  });
});
