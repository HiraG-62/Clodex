import { describe, expect, it } from "vitest";
import { createRestrictingSid, parseTokenOptions, validateAclTarget, tokenHelperSource, aclScript } from "./sandbox-token.js";

describe("write-restricted token spike", () => {
  it("通常の restricted token は明示指定時だけ使用", () => {
    expect(parseTokenOptions([]).fullRestricted).toBe(false);
    expect(parseTokenOptions(["--full-restricted"]).fullRestricted).toBe(true);
    expect(() => parseTokenOptions(["--full-restricted", "--run-cli"])).toThrow();
  });
  it("home の例外は継承なしの走査・属性読取りだけ", () => {
    const home = "C:\\Users\\Human";
    expect(() => validateAclTarget(home, home, "Traverse")).not.toThrow();
    expect(() => validateAclTarget(home, home, "ReadAndExecute")).toThrow();
    expect(() => validateAclTarget("C:\\Users", home, "Traverse")).toThrow();
    const script = aclScript(home, "S-1-5-21-1-2-3-4", false, "Traverse");
    expect(script).toContain("Traverse,ReadAttributes,ReadExtendedAttributes");
    expect(script).toContain("InheritanceFlags]::None");
    expect(script).not.toContain("'Modify'");
  });
  it("CLI と ACL 保持は明示指定時だけ有効", () => {
    expect(parseTokenOptions([])).toMatchObject({ runCli: false, keep: false });
    expect(parseTokenOptions(["--run-cli", "--keep"])).toMatchObject({ runCli: true, keep: true });
    expect(() => parseTokenOptions(["--project"])).toThrow();
    expect(() => parseTokenOptions(["--unknown"])).toThrow();
  });
  it("実行ごとに異なる未登録 SID を使う", () => {
    const first = createRestrictingSid();
    expect(first).toMatch(/^S-1-5-21-\d+-\d+-\d+-\d+$/);
    expect(createRestrictingSid()).not.toBe(first);
  });
  it("対象と記録先をそれぞれ指定できる", () => {
    expect(parseTokenOptions(["--project", "E:\\test", "--other-project", "E:\\other", "--measure-project", "E:\\measure", "--output", "E:\\report.md"])).toMatchObject({ project: "E:\\test", otherProject: "E:\\other", measureProject: "E:\\measure", output: "E:\\report.md", runCli: false });
    expect(parseTokenOptions(["--cleanup", "E:\\manifest.json"]).cleanup).toBe("E:\\manifest.json");
    expect(() => parseTokenOptions(["--project", "--run-cli"])).toThrow();
  });
  it("ドライブや人のプロファイル全体に ACL を追加しない", () => {
    const home = "C:\\Users\\Human";
    for (const path of ["C:\\", "E:\\", home, "C:\\Users", "relative", "\\\\server\\share"]) expect(() => validateAclTarget(path, home)).toThrow();
    expect(() => validateAclTarget("E:\\dev\\project", home)).not.toThrow();
    expect(() => validateAclTarget(`${home}\\.claude.json`, home)).not.toThrow();
    for (const path of ["C:\\USERS\\HUMAN", `${home}\\..`, "C:relative"]) expect(() => validateAclTarget(path, home)).toThrow();
  });
  it("helper は WRITE_RESTRICTED だけを指定し既存の権限を無効化しない", () => {
    expect(tokenHelperSource).toContain("WRITE_RESTRICTED=0x8");
    expect(tokenHelperSource).toContain("CreateProcessAsUser");
    expect(tokenHelperSource).not.toContain("DISABLE_MAX_PRIVILEGE");
  });
});
