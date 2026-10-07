import { describe, expect, it } from "vitest";
import { releaseVersion } from "./release-version.mjs";

describe("releaseVersion", () => {
  it("master の build はパッチを 1 つ上げて -dev.<実行番号> を付ける", () => {
    expect(releaseVersion({ refType: "branch", refName: "master", runNumber: "57", packageVersion: "0.1.0" })).toBe("0.1.1-dev.57");
    expect(releaseVersion({ refType: "branch", refName: "master", runNumber: "3", packageVersion: "1.9.9" })).toBe("1.9.10-dev.3");
  });

  it("tag の build は package.json の版をそのまま使い、tag と違えば失敗する", () => {
    expect(releaseVersion({ refType: "tag", refName: "v0.1.1", runNumber: "9", packageVersion: "0.1.1" })).toBe("0.1.1");
    expect(() => releaseVersion({ refType: "tag", refName: "v0.1.2", runNumber: "9", packageVersion: "0.1.1" })).toThrow("v0.1.2");
  });

  it("dev の元にする版が x.y.z でなければ失敗する", () => {
    expect(() => releaseVersion({ refType: "branch", refName: "master", runNumber: "1", packageVersion: "0.1.1-dev.2" })).toThrow("0.1.1-dev.2");
  });
});
