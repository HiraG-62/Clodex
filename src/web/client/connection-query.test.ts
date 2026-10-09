import { describe, expect, it } from "vitest";
import { connectionQuery } from "./connection-query.js";

describe("connectionQuery", () => {
  it("GUI の版と Push の購読状態を接続に添える", () => {
    expect(connectionQuery("1.2.3", "device-1", "visible").toString()).toBe("gui=1.2.3&push=device-1&visible=1");
    expect(connectionQuery("1.2.3", "device-1", "hidden").get("visible")).toBe("0");
    expect(connectionQuery(undefined, undefined, "visible").toString()).toBe("");
  });
});
