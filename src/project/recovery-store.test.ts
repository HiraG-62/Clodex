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

  it.each(["opening", "round", "human", "summary"] as const)("Agent が動いていなくてもブレストの %s を保存する", brainstormPhase => {
    const { home, project } = setup();
    const conversation = { brainstormPhase, interrupted: [], queue: { claude: [], codex: [], gemini: [] } };
    saveRecovery(home, project, { current: "b", conversations: { b: conversation } });
    expect(loadRecovery(home, project)?.conversations.b).toEqual(conversation);
  });

  it("配送待ちと作業中の会話だけを保存し、読み直す", () => {
    const { home, project, path } = setup();
    const data = {
      current: "c1",
      conversations: {
        c1: {
          brainstormPhase: "round" as const,
          interrupted: ["claude" as const],
          queue: {
            claude: [{ kind: "input" as const, text: "次", images: ["shot.png"], context: true as const, brainstorm: true as const }],
            codex: [],
            gemini: [],
          },
        },
        c2: { interrupted: [], queue: { claude: [], codex: [], gemini: [] } },
      },
    };
    saveRecovery(home, project, data);
    expect(loadRecovery(home, project)).toEqual({ current: "c1", conversations: { c1: data.conversations.c1 } });
    expect(JSON.parse(readFileSync(path, "utf8")).conversations).not.toHaveProperty("c2");
  });

  it.each([false, true])("配送待ちの message の証跡と設計書検査を保持する: root=%s", withRoot => {
    const { home, project } = setup();
    const message = {
      id: "r",
      type: "RESULT" as const,
      from: "codex" as const,
      to: "claude" as const,
      taskId: "T",
      body: "完了",
      repository: project,
      createdAt: "now",
      replyTo: "request",
      evidence: {
        ...(withRoot ? { root: project } : {}),
        checks: [{ command: "pnpm test", ran: true, exitCode: 0 }],
        changed: [{ path: "a.ts", scope: "owned" as const, peer: true as const }],
      },
      specCheck: { command: "check", exitCode: 1, output: "diagnostic" },
    };
    saveRecovery(home, project, {
      current: "c",
      conversations: { c: { interrupted: [], queue: { claude: [{ kind: "message", message }], codex: [], gemini: [] } } },
    });
    expect(loadRecovery(home, project)?.conversations.c?.queue.claude[0]).toEqual({ kind: "message", message });
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
    const conversation = {
      interrupted: ["claude" as const],
      queue: { claude: [], codex: [], gemini: [] },
      lastWork: { claude: { plan: "方針", actions: ["Read a.ts"] } },
    };
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
    queue: { claude: [], codex: [], gemini: [] },
    questions: [{ id: "q1", agent: "claude" as const, questions: [{ question: "方針", options: [{ label: "A" }, { label: "B" }] }] }],
  };
  saveRecovery(home, project, { current: "c1", conversations: { c1: conversation } });
  expect(loadRecovery(home, project)?.conversations.c1).toEqual(conversation);
});

it("省略した Agent の queue を空配列で補う", () => {
  const home = mkdtempSync(join(tmpdir(), "clodex-recovery-keys-"));
  const project = join(home, "project");
  saveRecovery(home, project, { current: "c", conversations: {} });
  writeFileSync(
    recoveryPath(home, project),
    JSON.stringify({
      current: "c",
      conversations: {
        c: { interrupted: ["claude"], queue: { claude: [{ kind: "input", text: "続行" }] } },
      },
    }),
  );
  expect(loadRecovery(home, project)?.conversations.c?.queue).toEqual({ claude: [{ kind: "input", text: "続行" }], codex: [], gemini: [] });
});
