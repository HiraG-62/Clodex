import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../protocol/messages.js";
import { collectArtifacts, displayPath } from "./artifacts.js";
import type { TimelineItem } from "./timeline.js";

const message = (files: string[], body: string): AgentMessage => ({
  id: "m", from: "claude", to: "codex", type: "DELEGATE", taskId: "T", body, files,
  repository: "C:\\dev\\app", createdAt: "2026-10-06T00:00:00.000Z",
});

describe("collectArtifacts", () => {
  it("変更・参照・本文の画像を新しい順に集め、同じパスは最後の種類で 1 つにする", () => {
    const items: TimelineItem[] = [
      {
        kind: "turn", id: "t1", at: "1", agent: "claude", status: "completed", text: "証跡: C:\\home\\.clodex\\artifacts\\p\\shot.png を見て",
        steps: [{ kind: "tool", name: "Edit", input: "", files: ["C:\\dev\\app\\src\\a.ts"] }, { kind: "say", text: "途中 ./out/diagram.webp" }],
      },
      { kind: "message", id: "m1", at: "2", message: message(["src/b.ts", "C:/dev/app/src/a.ts"], "画像は docs/fig.PNG") },
      { kind: "human", id: "h", at: "3", agent: "claude", text: "x.png" },
    ];
    expect(collectArtifacts(items)).toEqual([
      { path: "docs/fig.PNG", kind: "image", at: "2" },
      { path: "C:/dev/app/src/a.ts", kind: "referenced", at: "2" },
      { path: "src/b.ts", kind: "referenced", at: "2" },
      { path: "C:\\home\\.clodex\\artifacts\\p\\shot.png", kind: "image", at: "1" },
      { path: "./out/diagram.webp", kind: "image", at: "1" },
    ]);
  });

  it("画像の拡張子でない語は拾わない", () => {
    const items: TimelineItem[] = [{ kind: "turn", id: "t", at: "1", agent: "codex", status: "completed", text: "a.pngx と png と .png", steps: [] }];
    expect(collectArtifacts(items)).toEqual([]);
  });
});

describe("displayPath", () => {
  it("project の中は相対パスにし、外はそのまま", () => {
    expect(displayPath("C:\\dev\\app\\src\\a.ts", "C:\\dev\\app")).toBe("src/a.ts");
    expect(displayPath("c:/DEV/app/README.md", "C:\\dev\\app\\")).toBe("README.md");
    expect(displayPath("C:\\home\\shot.png", "C:\\dev\\app")).toBe("C:/home/shot.png");
    expect(displayPath("src/a.ts", "C:\\dev\\app")).toBe("src/a.ts");
  });
});
