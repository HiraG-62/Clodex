import { describe, expect, it, vi } from "vitest";
import { tokenExpired } from "./connection.js";

describe("tokenExpired", () => {
  it("401 だけを token の失効と判定する", async () => {
    expect(await tokenExpired(vi.fn(async () => new Response(null, { status: 401 })))).toBe(true);
    expect(await tokenExpired(vi.fn(async () => new Response(null, { status: 503 })))).toBe(false);
  });

  it("接続失敗は token の失効と決めつけない", async () => {
    expect(await tokenExpired(vi.fn(async () => Promise.reject(new Error("offline"))))).toBe(false);
  });
});
