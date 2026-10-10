import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../protocol/messages.js";
import { classifyDiffLine, collectArtifacts, displayPath, findImagePaths, splitImagePaths } from "./artifacts.js";
import type { TimelineItem } from "./timeline.js";

const message = (files: string[], body: string): AgentMessage => ({
  id: "m",
  from: "claude",
  to: "codex",
  type: "DELEGATE",
  taskId: "T",
  body,
  files,
  repository: "C:\\dev\\app",
  createdAt: "2026-10-06T00:00:00.000Z",
});

describe("collectArtifacts", () => {
  it("最終応答と message の本文を資料、tool と message の files を成果物にし、最初の時刻を残す", () => {
    const items: TimelineItem[] = [
      {
        kind: "turn",
        id: "t1",
        at: "1",
        agent: "claude",
        status: "completed",
        text: "証跡: C:\\home\\.clodex\\artifacts\\p\\shot.png と [コード](<C:/dev/app/src/a.ts>)",
        steps: [
          { kind: "tool", name: "Edit", input: "", files: ["C:\\dev\\app\\src\\a.ts"] },
          { kind: "say", text: "途中 ./out/diagram.webp", at: "" },
        ],
      },
      { kind: "message", id: "m1", at: "2", message: message(["src/b.ts", "C:/dev/app/src/a.ts"], "[画像](docs/fig.PNG) と C:/dev/app/docs/notes.md") },
      { kind: "human", id: "h", at: "3", agent: "claude", text: "x.png" },
    ];
    expect(collectArtifacts(items)).toEqual([
      { path: "C:/dev/app/docs/notes.md", kind: "referenced", group: "presented", at: "2", firstAt: "2", changed: false },
      { path: "docs/fig.PNG", kind: "image", group: "presented", at: "2", firstAt: "2", changed: false },
      { path: "C:/dev/app/src/a.ts", kind: "referenced", group: "presented", at: "2", firstAt: "1", changed: true },
      { path: "C:\\home\\.clodex\\artifacts\\p\\shot.png", kind: "image", group: "presented", at: "1", firstAt: "1", changed: false },
      { path: "src/b.ts", kind: "referenced", group: "work", at: "2", firstAt: "2", changed: false },
    ]);
  });

  it("画像の拡張子でない語は拾わない", () => {
    const items: TimelineItem[] = [{ kind: "turn", id: "t", at: "1", agent: "codex", status: "completed", text: "a.pngx と png と .png", steps: [] }];
    expect(collectArtifacts(items)).toEqual([]);
  });

  it("区切りが 2 つの絶対パスを拾い、URL は拾わない", () => {
    const items: TimelineItem[] = [
      { kind: "turn", id: "t", at: "1", agent: "codex", status: "completed", text: "C:/dev/a.ts /tmp/b.ts ~/docs/c.md https://example.com/a.ts", steps: [] },
    ];
    expect(collectArtifacts(items).map(item => item.path)).toEqual(["~/docs/c.md", "/tmp/b.ts", "C:/dev/a.ts"]);
  });

  it("変更済みファイルが message の files にもあれば変更の種類を保つ", () => {
    const items: TimelineItem[] = [
      {
        kind: "turn",
        id: "t",
        at: "1",
        agent: "codex",
        status: "completed",
        text: "",
        steps: [{ kind: "tool", name: "Edit", input: "", files: ["src/a.ts"] }],
      },
      { kind: "message", id: "m", at: "2", message: message(["src/a.ts"], "依頼") },
    ];
    expect(collectArtifacts(items)).toEqual([{ path: "src/a.ts", kind: "changed", group: "work", at: "2", firstAt: "1", changed: true }]);
  });

  it("ターンに含まれた message の参照と画像も拾う", () => {
    const items: TimelineItem[] = [
      {
        kind: "turn",
        id: "t",
        at: "1",
        agent: "claude",
        status: "completed",
        text: "",
        steps: [],
        messages: [{ message: { ...message(["src/a.ts"], "図は docs/a.png"), spec: "docs/specs/T.md" } }],
      },
    ];
    expect(collectArtifacts(items)).toEqual([
      { path: "docs/a.png", kind: "image", group: "presented", at: "1", firstAt: "1", changed: false },
      { path: "docs/specs/T.md", kind: "referenced", group: "presented", at: "1", firstAt: "1", changed: false },
      { path: "src/a.ts", kind: "referenced", group: "work", at: "1", firstAt: "1", changed: false },
    ]);
  });
});

describe("findImagePaths", () => {
  it("Windows パスと相対パスを出現順で取り出す", () => {
    expect(findImagePaths("C:\\out\\shot.PNG ./out/a.jpg docs/b.jpeg ../c.gif ~/d.webp")).toEqual([
      "C:\\out\\shot.PNG",
      "./out/a.jpg",
      "docs/b.jpeg",
      "../c.gif",
      "~/d.webp",
    ]);
  });

  it("区切りと大文字小文字が違う同じパスは最初の 1 つだけ残す", () => {
    expect(findImagePaths("C:\\out\\shot.PNG b.gif c:/OUT/shot.png B.GIF")).toEqual(["C:\\out\\shot.PNG", "b.gif"]);
  });

  it("画像の拡張子でない語は拾わない", () => {
    expect(findImagePaths("a.pngx png .png a.svg a.webp2")).toEqual([]);
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

it("spec を参照として集める", () => {
  expect(collectArtifacts([{ kind: "message", id: "m", at: "1", message: { ...message([], "依頼"), spec: "docs/specs/T.md" } }])).toEqual([
    { path: "docs/specs/T.md", kind: "referenced", group: "presented", at: "1", firstAt: "1", changed: false },
  ]);
});

it("差分の行を追加・削除・区切り・ヘッダに分類する", () => {
  expect(["+one", "-old", "@@ -1 +1 @@", "diff --git a/x b/x", "index 123", "--- a/x", "+++ b/x", " unchanged"].map(classifyDiffLine)).toEqual([
    "add",
    "del",
    "hunk",
    "header",
    "header",
    "header",
    "header",
    "",
  ]);
});

describe("splitImagePaths", () => {
  it("本文を画像のパスとそれ以外に分ける", () => {
    expect(splitImagePaths("見て C:/out/a.png と b.ts と ./x.JPG")).toEqual([
      { text: "見て " },
      { text: "C:/out/a.png", path: "C:/out/a.png" },
      { text: " と b.ts と " },
      { text: "./x.JPG", path: "./x.JPG" },
    ]);
  });

  it("画像のパスが無ければ 1 つのまま返す", () => {
    expect(splitImagePaths("パスなし")).toEqual([{ text: "パスなし" }]);
  });
});
