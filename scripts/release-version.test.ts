import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { devNumber, releaseVersion } from "./release-version.mjs";

describe("releaseVersion", () => {
  it("master の build はパッチを 1 つ上げて -dev.<N> を付ける", () => {
    expect(releaseVersion({ refType: "branch", refName: "master", devNumber: 3, packageVersion: "0.1.0" })).toBe("0.1.1-dev.3");
    expect(releaseVersion({ refType: "branch", refName: "master", devNumber: 0, packageVersion: "1.9.9" })).toBe("1.9.10-dev.0");
  });

  it("tag の build は package.json の版をそのまま使い、tag と違えば失敗する", () => {
    expect(releaseVersion({ refType: "tag", refName: "v0.1.1", packageVersion: "0.1.1" })).toBe("0.1.1");
    expect(() => releaseVersion({ refType: "tag", refName: "v0.1.2", packageVersion: "0.1.1" })).toThrow("v0.1.2");
  });

  it("dev の元にする版が x.y.z でなければ失敗する", () => {
    expect(() => releaseVersion({ refType: "branch", refName: "master", devNumber: 1, packageVersion: "0.1.1-dev.2" })).toThrow("0.1.1-dev.2");
  });
});

describe("devNumber", () => {
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), "clodex-release-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
    git("init", "-q");
    const commit = (path: string, content: string) => {
      mkdirSync(join(dir, dirname(path)), { recursive: true });
      writeFileSync(join(dir, path), content);
      git("add", "-A");
      git("commit", "-q", "-m", path);
    };
    const version = (v: string) => commit("package.json", `{\n  "name": "x",\n  "version": "${v}"\n}\n`);
    return { dir, commit, version };
  };

  it("版を最後に変えたコミットより後の、docs と *.md だけではないコミットを数える", () => {
    const { dir, commit, version } = repo();
    version("0.1.0");
    expect(devNumber(dir)).toBe(0);
    commit("src/a.ts", "1");
    commit("docs/a.txt", "1");
    commit("README.md", "1");
    commit("src/a.ts", "2");
    expect(devNumber(dir)).toBe(2);
  });

  it("本番の版を上げたら 0 から数え直す", () => {
    const { dir, commit, version } = repo();
    version("0.1.0");
    commit("src/a.ts", "1");
    version("0.1.1");
    expect(devNumber(dir)).toBe(0);
    commit("src/a.ts", "2");
    expect(devNumber(dir)).toBe(1);
  });
});
