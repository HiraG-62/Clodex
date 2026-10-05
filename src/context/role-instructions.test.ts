import { describe, expect, it } from "vitest";
import { buildRoleInstructions } from "./role-instructions.js";

describe("buildRoleInstructions", () => {
  it("自分と相手の役割と、相手の役割の作業は send_message で依頼することを伝える", () => {
    const text = buildRoleInstructions("claude", { claude: "設計とレビュー", codex: "実装" });
    expect(text).toContain('You are the "claude" agent in Clodex');
    expect(text).toContain('peer agent "codex"');
    expect(text).toContain("Your role: 設計とレビュー");
    expect(text).toContain("Role of codex: 実装");
    expect(text).toMatch(/send_message tool of the "clodex" MCP server/);
    expect(text).toMatch(/Do not do the same work/);
  });

  it("相手から見た文面は立場が入れ替わる", () => {
    const text = buildRoleInstructions("codex", { claude: "設計", codex: "実装" });
    expect(text).toContain('You are the "codex" agent');
    expect(text).toContain("Your role: 実装");
    expect(text).toContain("Role of claude: 設計");
  });

  it("片方だけ役割があれば、無い方は not specified", () => {
    const text = buildRoleInstructions("codex", { claude: "設計" });
    expect(text).toContain("Your role: not specified");
    expect(text).toContain("Role of claude: 設計");
  });

  it("役割の有無にかかわらず /permission を案内するよう伝える", () => {
    expect(buildRoleInstructions("claude", undefined)).toContain("/permission");
    expect(buildRoleInstructions("codex", { claude: "設計" })).toContain("/permission");
  });

  it("役割が無ければ相手の Agent がいることだけを伝える", () => {
    const text = buildRoleInstructions("claude", undefined);
    expect(text).toContain('peer agent "codex"');
    expect(text).not.toContain("Your role");
    expect(text).toMatch(/only when an independent view/);
  });
});
