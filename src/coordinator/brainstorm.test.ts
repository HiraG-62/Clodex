import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentAdapter } from "../agents/fake-agent-adapter.js";
import { roundPrompt, summaryPrompt } from "./brainstorm.js";
import { Coordinator } from "./coordinator.js";
import { EventBus } from "./event-bus.js";

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe("ブレストのプロンプト", () => {
  it.each([
    { peer: "codex", prefix: "C" },
    { peer: "claude", prefix: "X" },
  ] as const)("相手が $peer のとき自分の案に $prefix の通し番号を付け、次の周から ID で批評する", ({ peer, prefix }) => {
    for (const round of [1, 2, 3]) {
      const prompt = roundPrompt({ topic: "新機能", rounds: 3 }, round, peer, "相手の案", []);
      expect(prompt).toContain(`Assign IDs to your ideas: ${prefix}1, ${prefix}2, ...`);
      expect(prompt).toContain("Continue numbering across rounds");
      if (round === 1) {
        expect(prompt).not.toContain("相手の案");
      } else {
        expect(prompt).toContain("Refer to the other agent's ideas by ID when critiquing them");
        expect(prompt).toContain(`${peer}'s previous response:\n相手の案`);
      }
    }
  });

  it("まとめは案の ID・提案者・現状・根拠の表と、従来の論点・有望な案・未解決の問いを求める", () => {
    const prompt = summaryPrompt({ topic: "新機能", rounds: 2 }, [], []);
    expect(prompt).toContain("ID | Proposer | Status | Basis");
    expect(prompt).toContain("adopted / adopted with changes / on hold / rejected");
    expect(prompt).toContain("measurements, code, or the other agent's critique");
    expect(prompt).toContain("key questions");
    expect(prompt).toContain("promising ideas with reasons");
    expect(prompt).toContain("unresolved questions");
  });
});

const setup = (rounds: number) => {
  const claude = new FakeAgentAdapter("claude");
  const codex = new FakeAgentAdapter("codex");
  const bus = new EventBus();
  const events: Array<{ kind: string }> = [];
  bus.subscribe(event => events.push(event));
  const artifactsDir = mkdtempSync(join(tmpdir(), "clodex-brainstorm-"));
  const coordinator = new Coordinator({
    projectRoot: "C:\\project",
    agents: { claude, codex },
    bus,
    mcpUrlFor: id => `http://localhost/${id}`,
    brainstorm: { topic: "新機能", rounds },
    brainstormPrimary: "claude",
    brainstormArtifactsDir: artifactsDir,
    settings: { claude: { permission: "read-only" }, codex: { permission: "read-only" } },
  });
  return { claude, codex, coordinator, events, artifactsDir };
};

describe("ブレストの進行", () => {
  it("両 Agent に同時に送り、次の周に相手の応答と人の追記を渡し、primary がまとめる", async () => {
    const { claude, codex, coordinator, events, artifactsDir } = setup(2);
    const run = coordinator.startBrainstorm();
    await flush();
    expect(claude.sent).toHaveLength(1);
    expect(codex.sent).toHaveLength(1);
    expect(claude.sent[0]).toContain("新機能");
    expect(events.some(event => event.kind === "human")).toBe(false);
    coordinator.addBrainstormInput("codex", "予算を考慮");
    claude.completeTurn({ status: "completed", text: "Claude の案" });
    codex.completeTurn({ status: "completed", text: "Codex の案" });
    await flush();
    expect(claude.sent[1]).toContain("Codex の案");
    expect(codex.sent[1]).toContain("Claude の案");
    expect(claude.sent[1]).toContain("予算を考慮");
    expect(codex.sent[1]).toContain("予算を考慮");
    claude.completeTurn({ status: "completed", text: "Claude の発展案" });
    codex.completeTurn({ status: "completed", text: "Codex の発展案" });
    await flush();
    expect(claude.sent[2]).toContain("Claude の案");
    expect(claude.sent[2]).toContain("Codex の発展案");
    expect(codex.sent).toHaveLength(2);
    claude.completeTurn({ status: "completed", text: "まとめ" });
    await run;
    const file = readdirSync(artifactsDir)[0];
    expect(file).toMatch(/^brainstorm-/);
    expect(readFileSync(join(artifactsDir, file!), "utf8")).toBe("まとめ\n");
  });

  it("失敗と中断後は次の周を送らず、send_message と権限変更を拒否する", async () => {
    const { claude, codex, coordinator } = setup(2);
    expect(coordinator.receiveMessage("claude", {})).toMatchObject({ ok: false, error: "brainstorm mode: do not use send_message" });
    await coordinator.setPermission("full");
    expect(claude.permission).toBe("read-only");
    const run = coordinator.startBrainstorm();
    await flush();
    claude.completeTurn({ status: "failed", text: "失敗" });
    codex.completeTurn();
    await run;
    expect(claude.sent).toHaveLength(1);
    expect(codex.sent).toHaveLength(1);
    expect(coordinator.brainstormState?.phase).toBe("stopped");
  });

  it("/interrupt 後は次の周を送らない", async () => {
    const { claude, codex, coordinator } = setup(2);
    const run = coordinator.startBrainstorm();
    await flush();
    await coordinator.interrupt();
    claude.completeTurn({ status: "interrupted", text: "" });
    codex.completeTurn({ status: "interrupted", text: "" });
    await run;
    expect(claude.sent).toHaveLength(1);
    expect(codex.sent).toHaveLength(1);
  });

  it("止まったときは溜めた人の入力を宛先へ配送し、次の周の印を外す", async () => {
    const { claude, codex, coordinator, events } = setup(2);
    const run = coordinator.startBrainstorm();
    await flush();
    coordinator.addBrainstormInput("claude", "追記", ["claude", "codex"]);
    expect(coordinator.recoveryState().queue.claude).toMatchObject([{ kind: "input", text: "追記", brainstorm: true }]);
    expect(coordinator.recoveryState().queue.codex).toMatchObject([{ kind: "input", text: "追記", brainstorm: true }]);
    claude.completeTurn({ status: "failed", text: "失敗" });
    codex.completeTurn();
    await run;
    await flush();
    expect(claude.sent[1]).toContain("追記");
    expect(codex.sent[1]).toContain("追記");
    expect(events.some(event => event.kind === "brainstormReleased")).toBe(true);
    claude.completeTurn();
    codex.completeTurn();
  });

  it("次の周に渡した入力も、その周が失敗すれば失わない", async () => {
    const { claude, codex, coordinator } = setup(2);
    const run = coordinator.startBrainstorm();
    await flush();
    coordinator.addBrainstormInput("claude", "費用を確認");
    claude.completeTurn();
    codex.completeTurn();
    await flush();
    expect(claude.sent[1]).toContain("費用を確認");
    expect(coordinator.recoveryState().queue.claude).toMatchObject([{ kind: "input", text: "費用を確認", brainstorm: true }]);
    claude.completeTurn({ status: "failed", text: "失敗" });
    codex.completeTurn();
    await run;
    await flush();
    expect(claude.sent[2]).toContain("費用を確認");
    claude.completeTurn();
  });

  it("復旧時はブレストを再開せず、追加入力を通常配送する", async () => {
    const { claude, coordinator } = setup(2);
    coordinator.restore({
      brainstormPhase: "round",
      interrupted: ["claude"],
      queue: { claude: [{ kind: "input", id: "in3", text: "追記", brainstorm: true }], codex: [] },
    });
    await flush();
    expect(coordinator.brainstormState?.phase).toBe("stopped");
    expect(claude.sent).toHaveLength(1);
    expect(claude.sent[0]).toContain("追記");
    expect(claude.sent[0]).not.toContain("Clodex restarted");
    claude.completeTurn();
  });

  it("ブレスト中断後の普通のターンは復旧で続ける", async () => {
    const { claude, coordinator } = setup(2);
    claude.sessionId = "saved-session";
    coordinator.restore({ brainstormPhase: "stopped", interrupted: ["claude"], queue: { claude: [], codex: [] } });
    await flush();
    expect(claude.sent[0]).toContain("Clodex restarted");
    claude.completeTurn();
  });

  it("完了後の復旧では通常の配送待ちを再送する", async () => {
    const claude = new FakeAgentAdapter("claude");
    const codex = new FakeAgentAdapter("codex");
    const coordinator = new Coordinator({
      projectRoot: "C:\\project",
      agents: { claude, codex },
      bus: new EventBus(),
      mcpUrlFor: id => `http://localhost/${id}`,
      brainstorm: { topic: "新機能", rounds: 2 },
      brainstormComplete: true,
    });
    const question = { id: "q1", agent: "claude" as const, questions: [{ question: "方向", options: [{ label: "A" }, { label: "B" }] }] };
    coordinator.restore({ interrupted: [], queue: { claude: [{ kind: "input", id: "in1", text: "完了後の依頼" }], codex: [] }, questions: [question] });
    await flush();
    expect(coordinator.brainstormState?.phase).toBe("done");
    expect(coordinator.pendingQuestions()).toEqual([question]);
    expect(claude.sent[0]).toContain("完了後の依頼");
    claude.completeTurn();
  });

  it("起動待ち中の /interrupt はブレストの指示を送らない", async () => {
    const { claude, codex, coordinator } = setup(2);
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const startClaude = claude.start.bind(claude);
    const startCodex = codex.start.bind(codex);
    claude.start = async options => {
      await gate;
      await startClaude(options);
    };
    codex.start = async options => {
      await gate;
      await startCodex(options);
    };
    const run = coordinator.startBrainstorm();
    await flush();
    await coordinator.interrupt();
    release();
    await run;
    expect(claude.sent).toHaveLength(0);
    expect(codex.sent).toHaveLength(0);
  });
});
