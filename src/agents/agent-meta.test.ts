import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "./agent-adapter.js";
import { agentRecord, peersOf } from "./agent-meta.js";

describe("Agent 一覧のヘルパー", () => {
  it("本人以外の全員を返す", () => {
    for (const id of AGENT_IDS) expect(peersOf(id)).toEqual(AGENT_IDS.filter(peer => peer !== id));
  });

  it("各 Agent の値を独立して生成する", () => {
    const record = agentRecord(id => ({ id, entries: [] as string[] }));
    expect(Object.keys(record)).toEqual([...AGENT_IDS]);
    record.claude.entries.push("変更");
    expect(record.codex.entries).toEqual([]);
    for (const id of AGENT_IDS) expect(record[id].id).toBe(id);
  });
});
