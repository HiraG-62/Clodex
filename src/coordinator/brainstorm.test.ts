import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_IDS, type AgentId } from "../agents/agent-adapter.js";
import { agentRecord } from "../agents/agent-meta.js";
import { FakeAgentAdapter } from "../agents/fake-agent-adapter.js";
import { debateOrder, hasConsensus, parseStance, roundPrompt, summaryPrompt } from "./brainstorm.js";
import { Coordinator } from "./coordinator.js";
import { type CoordinatorEvent, EventBus } from "./event-bus.js";

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const stance = (value = "support", open = "none") => `\n\`\`\`stance\nC1: ${value}\nopen: ${open}\n\`\`\``;

describe("ブレストの議論", () => {
  it("周ごとに先頭と反論役を回す", () => {
    expect(debateOrder(1)).toEqual(["claude", "codex", "gemini"]);
    expect(debateOrder(2)).toEqual(["codex", "gemini", "claude"]);
    expect(debateOrder(4)).toEqual(AGENT_IDS);
  });
  it("開幕は独立し、議論は自分の前回以降の他者の発言だけを渡す", () => {
    const responses = [
      { round: 0, agent: "codex" as const, text: "開幕 X1" },
      { round: 0, agent: "claude" as const, text: "開幕 C1" },
      { round: 0, agent: "gemini" as const, text: "開幕 G1" },
    ];
    const config = { topic: "テーマ", rounds: 3 };
    expect(roundPrompt(config, 0, "claude", responses, [])).not.toContain("開幕 X1");
    const first = roundPrompt(config, 1, "claude", responses, []);
    expect(first).toContain("開幕 X1");
    expect(first).toContain("開幕 G1");
    expect(first).toContain("devil's advocate");
    const later = roundPrompt(
      config,
      2,
      "claude",
      [...responses, { round: 1, agent: "claude", text: "自分" }, { round: 1, agent: "codex", text: "新しい質問" }],
      [],
    );
    expect(later).not.toContain("開幕 X1");
    expect(later).not.toContain("自分");
    expect(later).toContain("新しい質問");
    expect(later).toContain("```stance");
  });
  it("stance は空白・大小文字・不正な行に寛容で、不明な立場は補わない", () => {
    expect(parseStance("``` STANCE \n c1 : SUPPORT\nX2: Conditional\nG1: oppose\ninvalid\nC3: nope\n OPEN: None \n```")).toEqual({
      ideas: { C1: "support", X2: "conditional", G1: "oppose" },
      open: "none",
    });
    expect(parseStance("ブロックなし")).toBeUndefined();
    expect(parseStance("```stance\nopen: none\n```")).toBeUndefined();
    expect(parseStance("```stance\nC1: support\n```")).toBeUndefined();
  });
  it("全員既知・open なし・支持と反対の混在なしの場合だけ合意", () => {
    const stances = agentRecord(() => parseStance(stance()));
    expect(hasConsensus(stances)).toBe(true);
    expect(hasConsensus({ ...stances, codex: parseStance(stance("oppose")) })).toBe(false);
    expect(hasConsensus({ ...stances, codex: parseStance(stance("conditional")) })).toBe(true);
    expect(hasConsensus({ ...stances, codex: parseStance(stance("support", "費用")) })).toBe(false);
    expect(hasConsensus({ ...stances, codex: undefined })).toBe(false);
  });
  it("まとめに全発言・立場・終了理由と表の指示を含める", () => {
    const prompt = summaryPrompt(
      { topic: "テーマ", rounds: 3 },
      [{ round: 0, agent: "claude", text: "開幕案" }],
      [],
      agentRecord(() => parseStance(stance())),
      "limit",
    );
    for (const text of ["Claude", "Codex", "Gemini", "support", "limit", "both sides", "adopted / adopted with changes / on hold / rejected", "開幕案"])
      expect(prompt).toContain(text);
  });
});

const setup = (rounds = 3, joinHuman = false) => {
  const agents = agentRecord(id => new FakeAgentAdapter(id));
  const bus = new EventBus();
  const events: CoordinatorEvent[] = [];
  bus.subscribe(event => events.push(event));
  const artifactsDir = mkdtempSync(join(tmpdir(), "clodex-brainstorm-"));
  const coordinator = new Coordinator({
    projectRoot: "C:\\project",
    agents,
    bus,
    mcpUrlFor: id => `http://localhost/${id}`,
    brainstorm: { topic: "テーマ", rounds, ...(joinHuman ? { join: true } : {}) },
    brainstormPrimary: "claude",
    brainstormArtifactsDir: artifactsDir,
  });
  const complete = async (id: AgentId, text: string) => {
    const result = { status: "completed" as const, text };
    agents[id].emit({ type: "turn", result });
    agents[id].completeTurn(result);
    await flush();
  };
  const opening = async () => {
    for (const id of AGENT_IDS) await complete(id, `${id} の開幕`);
  };
  const round = async (n: number, text = stance()) => {
    for (const id of debateOrder(n)) await complete(id, text);
  };
  return { agents, coordinator, events, artifactsDir, complete, opening, round };
};

describe("ブレストの進行", () => {
  it("send_message と権限変更を拒否する", async () => {
    const { agents, coordinator } = setup();
    expect(coordinator.receiveMessage("claude", {})).toMatchObject({ ok: false, error: "brainstorm mode: do not use send_message" });
    await coordinator.setPermission("full");
    expect(agents.claude.permission).toBe("edit");
  });
  it("開幕の発言は完了順で次の発言者へ渡す", async () => {
    const { agents, coordinator, complete, round } = setup();
    const run = coordinator.startBrainstorm();
    await flush();
    await complete("gemini", "Gemini 先着");
    await complete("claude", "Claude 中間");
    await complete("codex", "Codex 最後");
    const prompt = agents.claude.sent[1]!;
    expect(prompt.indexOf("Gemini 先着")).toBeLessThan(prompt.indexOf("Codex 最後"));
    await round(1);
    await complete("claude", "まとめ");
    await run;
  });
  it("議論の途中の人の追記は次の1体に渡し、その後は流れとして伝わる", async () => {
    const { agents, coordinator, opening, complete } = setup();
    const run = coordinator.startBrainstorm();
    await flush();
    await opening();
    coordinator.addBrainstormInput("gemini", "途中の条件");
    await complete("claude", stance());
    expect(agents.codex.sent[1]).toContain("The human added:\n- 途中の条件");
    expect(agents.gemini.sent).toHaveLength(1);
    await complete("codex", stance());
    expect(agents.gemini.sent[1]).toContain("Human:\n途中の条件");
    expect(agents.gemini.sent[1]).not.toContain("The human added:");
    await complete("gemini", stance());
    await complete("claude", "まとめ");
    await run;
  });
  it("まとめに送る前の追記はまとめへ渡す", async () => {
    const { agents, coordinator, opening, complete } = setup();
    const run = coordinator.startBrainstorm();
    await flush();
    await opening();
    await complete("claude", stance());
    await complete("codex", stance());
    coordinator.addBrainstormInput("codex", "まとめの条件");
    await complete("gemini", stance());
    expect(agents.claude.sent[2]?.startsWith("The human added:\n- まとめの条件")).toBe(true);
    await complete("claude", "まとめ");
    await run;
  });
  it("開幕は同時、議論は順番、人の追記は次の発言者へ渡し、合意で早期にまとめる", async () => {
    const { agents, coordinator, events, artifactsDir, opening, complete, round } = setup();
    const run = coordinator.startBrainstorm();
    await flush();
    for (const id of AGENT_IDS) expect(agents[id].sent).toHaveLength(1);
    coordinator.addBrainstormInput("codex", "予算を考慮");
    await opening();
    expect(agents.claude.sent[1]).toContain("予算を考慮");
    expect(agents.codex.sent).toHaveLength(1);
    await round(1);
    expect(agents.claude.sent[2]).toContain("consensus");
    expect(coordinator.brainstormState?.phase).toBe("summary");
    expect(events.filter(e => e.kind === "agent" && e.event.type === "turn" && e.handoff)).toHaveLength(6);
    await complete("claude", "まとめ");
    await run;
    expect(coordinator.brainstormState?.phase).toBe("done");
    expect(readFileSync(join(artifactsDir, readdirSync(artifactsDir)[0]!), "utf8")).toBe("まとめ\n");
    expect(events.at(-2)).toMatchObject({ kind: "agent", event: { type: "turn" } });
    expect(events.at(-2)).not.toHaveProperty("handoff");
  });
  it("不明な立場は前の値で補わず、上限でまとめる", async () => {
    const { agents, coordinator, opening, round, complete } = setup(2);
    const run = coordinator.startBrainstorm();
    await flush();
    await opening();
    await round(1, stance("support", "質問"));
    expect(agents.codex.sent[2]).toContain("devil's advocate");
    await round(2, "ブロックなし");
    expect(agents.claude.sent.at(-1)).toContain("limit");
    expect(agents.claude.sent.at(-1)).toContain("unknown");
    await complete("claude", "まとめ");
    await run;
  });
  it("失敗では残りの発言とまとめを送らず通知の印を付けない", async () => {
    const { agents, coordinator, events, opening } = setup();
    const run = coordinator.startBrainstorm();
    await flush();
    await opening();
    const result = { status: "failed" as const, text: "失敗" };
    agents.claude.emit({ type: "turn", result });
    agents.claude.completeTurn(result);
    await run;
    expect(coordinator.brainstormState?.phase).toBe("stopped");
    expect(agents.codex.sent).toHaveLength(1);
    expect(events.find(e => e.kind === "agent" && e.event.type === "turn" && e.event.result.status === "failed")).not.toHaveProperty("handoff");
  });
  it("まとめの失敗は完了にせず、資料を保存しない", async () => {
    const { agents, coordinator, artifactsDir, opening, round } = setup();
    const run = coordinator.startBrainstorm();
    await flush();
    await opening();
    await round(1);
    expect(coordinator.brainstormState?.phase).toBe("summary");
    agents.claude.completeTurn({ status: "failed", text: "失敗" });
    await run;
    expect(coordinator.brainstormState?.phase).toBe("stopped");
    expect(readdirSync(artifactsDir)).toEqual([]);
  });
  it("/interrupt は議論の残りを送らず、受け取った人の入力を戻す", async () => {
    const { agents, coordinator, opening } = setup();
    const run = coordinator.startBrainstorm();
    await flush();
    coordinator.addBrainstormInput("codex", "追記");
    await opening();
    await coordinator.interrupt();
    agents.claude.completeTurn({ status: "interrupted", text: "" });
    await run;
    await flush();
    expect(agents.codex.sent).toHaveLength(2);
    expect(agents.codex.sent[1]).toContain("追記");
    agents.codex.completeTurn();
  });
  it("参加モードは人の番で待ち、発言を全員へ渡してから合意を判定する", async () => {
    const { agents, coordinator, events, opening, round, complete } = setup(3, true);
    const run = coordinator.startBrainstorm();
    await flush();
    await opening();
    expect(coordinator.brainstormState?.phase).toBe("human");
    expect(agents.claude.sent).toHaveLength(1);
    coordinator.addBrainstormInput("gemini", "人の案");
    await flush();
    expect(agents.claude.sent[1]).toContain("Human");
    expect(agents.claude.sent[1]).toContain("人の案");
    expect(events.find(e => e.kind === "human")).not.toHaveProperty("nextRound");
    await round(1);
    expect(coordinator.brainstormState?.phase).toBe("human");
    coordinator.advanceBrainstormHuman("pass");
    await flush();
    expect(coordinator.brainstormState?.phase).toBe("summary");
    await complete("claude", "まとめ");
    await run;
  });
  it("人が発言した周では合意せず、上限周の発言後は1周だけ追加してまとめる", async () => {
    const { coordinator, opening, round, complete, events } = setup(1, true);
    const run = coordinator.startBrainstorm();
    await flush();
    await opening();
    expect(coordinator.advanceBrainstormHuman("pass")).toBe(true);
    await flush();
    await round(1);
    coordinator.addBrainstormInput("claude", "追加案");
    await flush();
    await round(2);
    expect(coordinator.brainstormState?.phase).toBe("summary");
    expect(events.filter(e => e.kind === "brainstorm" && e.phase === "human")).toHaveLength(2);
    await complete("claude", "まとめ");
    await run;
  });
  it("/conclude は人の番からまとめへ進め、通常時の /pass は拒否する", async () => {
    const { coordinator, opening, agents, complete } = setup(3, true);
    expect(coordinator.advanceBrainstormHuman("pass")).toBe(false);
    const run = coordinator.startBrainstorm();
    await flush();
    await opening();
    expect(coordinator.advanceBrainstormHuman("conclude")).toBe(true);
    await flush();
    expect(agents.claude.sent[1]).toContain("human");
    await complete("claude", "まとめ");
    await run;
  });
  it("人の番での /interrupt と再起動は stopped にする", async () => {
    const { coordinator, opening } = setup(3, true);
    const run = coordinator.startBrainstorm();
    await flush();
    await opening();
    await coordinator.interrupt();
    await run;
    expect(coordinator.brainstormState?.phase).toBe("stopped");
    const other = setup(3, true);
    other.coordinator.restore({ brainstormPhase: "human", interrupted: [], queue: agentRecord(() => []) });
    expect(other.coordinator.brainstormState?.phase).toBe("stopped");
  });
  it("Hub の停止では人の番の待機を解放し、復旧用には停止前の状態を残す", async () => {
    const { coordinator, opening } = setup(3, true);
    let finished = false;
    const run = coordinator.startBrainstorm().then(() => {
      finished = true;
    });
    await flush();
    await opening();
    await coordinator.stop();
    await flush();
    expect(finished).toBe(true);
    expect(coordinator.recoveryState().brainstormPhase).toBe("human");
    await run;
  });
  it("復旧時はブレストを再開せず、追加入力を通常配送する", async () => {
    const {
      agents: { claude },
      coordinator,
    } = setup(2);
    coordinator.restore({
      brainstormPhase: "round",
      interrupted: ["claude"],
      queue: { claude: [{ kind: "input", id: "in3", text: "追記", brainstorm: true }], codex: [], gemini: [] },
    });
    await flush();
    expect(coordinator.brainstormState?.phase).toBe("stopped");
    expect(claude.sent).toHaveLength(1);
    expect(claude.sent[0]).toContain("追記");
    expect(claude.sent[0]).not.toContain("Clodex restarted");
    claude.completeTurn();
  });

  it("ブレスト中断後の普通のターンは復旧で続ける", async () => {
    const {
      agents: { claude },
      coordinator,
    } = setup(2);
    claude.sessionId = "saved-session";
    coordinator.restore({ brainstormPhase: "stopped", interrupted: ["claude"], queue: { claude: [], codex: [], gemini: [] } });
    await flush();
    expect(claude.sent[0]).toContain("Clodex restarted");
    claude.completeTurn();
  });

  it("完了後の復旧では通常の配送待ちを再送する", async () => {
    const claude = new FakeAgentAdapter("claude");
    const codex = new FakeAgentAdapter("codex");
    const coordinator = new Coordinator({
      projectRoot: "C:\\project",
      agents: { claude, codex, gemini: new FakeAgentAdapter("gemini") },
      bus: new EventBus(),
      mcpUrlFor: id => `http://localhost/${id}`,
      brainstorm: { topic: "新機能", rounds: 2 },
      brainstormComplete: true,
    });
    const question = { id: "q1", agent: "claude" as const, questions: [{ question: "方向", options: [{ label: "A" }, { label: "B" }] }] };
    coordinator.restore({
      interrupted: [],
      queue: { claude: [{ kind: "input", id: "in1", text: "完了後の依頼" }], codex: [], gemini: [] },
      questions: [question],
    });
    await flush();
    expect(coordinator.brainstormState?.phase).toBe("done");
    expect(coordinator.pendingQuestions()).toEqual([question]);
    expect(claude.sent[0]).toContain("完了後の依頼");
    claude.completeTurn();
  });

  it("起動待ち中の /interrupt はブレストの指示を送らない", async () => {
    const {
      agents: { claude, codex, gemini },
      coordinator,
    } = setup(2);
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const startClaude = claude.start.bind(claude);
    const startCodex = codex.start.bind(codex);
    const startGemini = gemini.start.bind(gemini);
    claude.start = async options => {
      await gate;
      await startClaude(options);
    };
    codex.start = async options => {
      await gate;
      await startCodex(options);
    };
    gemini.start = async options => {
      await gate;
      await startGemini(options);
    };
    const run = coordinator.startBrainstorm();
    await flush();
    await coordinator.interrupt();
    release();
    await run;
    expect(claude.sent).toHaveLength(0);
    expect(codex.sent).toHaveLength(0);
    expect(gemini.sent).toHaveLength(0);
  });
});
