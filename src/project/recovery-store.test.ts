import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRecovery, recoveryPath, saveRecovery } from "./recovery-store.js";

describe("recovery store", () => {
  const setup = () => {
    const home = mkdtempSync(join(tmpdir(), "clodex-recovery-"));
    const project = join(home, "project");
    return { home, project, path: recoveryPath(home, project) };
  };

  it("配送待ちと作業中の会話だけを保存し、読み直す", () => {
    const { home, project, path } = setup();
    const data = {
      current: "c1",
      conversations: {
        c1: {
          interrupted: ["claude" as const],
          queue: { claude: [{ kind: "input" as const, text: "次", images: ["shot.png"], context: true as const }], codex: [] },
        },
        c2: { interrupted: [], queue: { claude: [], codex: [] } },
      },
    };
    saveRecovery(home, project, data);
    expect(loadRecovery(home, project)).toEqual({ current: "c1", conversations: { c1: data.conversations.c1 } });
    expect(JSON.parse(readFileSync(path, "utf8")).conversations).not.toHaveProperty("c2");
  });

  it("壊れたファイルは空として扱う", () => {
    const { home, project, path } = setup();
    saveRecovery(home, project, { current: "c1", conversations: {} });
    writeFileSync(path, JSON.stringify({ current: "c1", conversations: { c1: { interrupted: ["nobody"], queue: {} } } }));
    expect(loadRecovery(home, project)).toBeUndefined();
    writeFileSync(path, "not JSON");
    expect(loadRecovery(home, project)).toBeUndefined();
  });

  it("lastWork を保存し、壊れた Agent の値だけを無視する", () => {
    const { home, project, path } = setup();
    const conversation = { interrupted: ["claude" as const], queue: { claude: [], codex: [] }, lastWork: { claude: { plan: "方針", actions: ["Read a.ts"] } } };
    saveRecovery(home, project, { current: "c1", conversations: { c1: conversation } });
    expect(loadRecovery(home, project)?.conversations.c1?.lastWork).toEqual(conversation.lastWork);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    saved.conversations.c1.lastWork.codex = { actions: "broken" };
    writeFileSync(path, JSON.stringify(saved));
    expect(loadRecovery(home, project)?.conversations.c1?.lastWork).toEqual(conversation.lastWork);
  });
});

it("未回答だけの会話も保存する", () => {
  const home = mkdtempSync(join(tmpdir(), "clodex-question-recovery-"));
  const project = join(home, "project");
  const conversation = {
    interrupted: [],
    queue: { claude: [], codex: [] },
    questions: [{ id: "q1", agent: "claude" as const, questions: [{ question: "方針", options: [{ label: "A" }, { label: "B" }] }] }],
  };
  saveRecovery(home, project, { current: "c1", conversations: { c1: conversation } });
  expect(loadRecovery(home, project)?.conversations.c1).toEqual(conversation);
});
