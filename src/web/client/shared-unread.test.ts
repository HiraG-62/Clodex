import { describe, expect, it } from "vitest";
import type { Artifact } from "./artifacts.js";
import { hasNewShared, sharedOpenedKey } from "./shared-unread.js";

const shared = (at: string): Artifact => ({ path: "shared.md", kind: "referenced", group: "presented", at, firstAt: at, changed: false });
const work = (at: string): Artifact => ({ path: "work.md", kind: "changed", group: "work", at, firstAt: at, changed: true });

describe("hasNewShared", () => {
  it("未閲覧で資料があれば点を出す", () => {
    expect(hasNewShared([shared("2026-10-10T01:00:00Z")], null)).toBe(true);
    expect(hasNewShared([], null)).toBe(false);
  });

  it("閲覧後に新しい資料が増えたときだけ点を出す", () => {
    const opened = "2026-10-10T02:00:00Z";
    expect(hasNewShared([shared("2026-10-10T01:00:00Z"), work("2026-10-10T03:00:00Z")], opened)).toBe(false);
    expect(hasNewShared([shared("2026-10-10T03:00:00Z")], opened)).toBe(true);
  });
});

it("閲覧時刻の鍵に project root と会話 ID を含める", () => {
  expect(sharedOpenedKey("C:/a", "one")).not.toBe(sharedOpenedKey("C:/b", "one"));
  expect(sharedOpenedKey("C:/a", "one")).not.toBe(sharedOpenedKey("C:/a", "two"));
});
