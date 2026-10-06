import { describe, expect, it } from "vitest";
import { assessAudit, hybridHelperSource } from "./sandbox-hybrid.js";
import { hybridCommand } from "./sandbox-hybrid-runner.js";

describe("専用ユーザーと write-restricted token", () => {
  it("broker 内で agent SID と WRITE_RESTRICTED の構成を指定", () => {
    const command = hybridCommand("E:\\test\\helper.exe", "S-1-5-21-1-2-3-4", "E:\\test", "node.exe", ["a'b"]);
    expect(command).toContain("CLODEX_SPIKE_TOKEN_MODE='write-users'");
    expect(command).toContain("'S-1-5-21-1-2-3-4'");
    expect(command).toContain("'a''b'");
    expect(command).not.toContain("S-1-5-11");
  });
  it("残存 Deny と監査不能を区別して記録", () => {
    expect(assessAudit([{ path: "D:\\", deny: true }, { path: "E:\\", deny: false }, { path: "C:\\Windows\\Temp", error: "拒否" }])).toEqual({ denied: ["D:\\"], unknown: ["C:\\Windows\\Temp"] });
  });
  it("Win32 の作成・DELETE open・削除を測る", () => {
    expect(hybridHelperSource).toContain('args[0]=="--boundary"');
    expect(hybridHelperSource).toContain("DeleteFile(args[1])");
    expect(hybridHelperSource).toContain("openDeleteError");
    expect(hybridHelperSource).toContain('mode=="write-users"');
  });
});
