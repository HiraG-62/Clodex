import { describe, expect, it } from "vitest";
import { AGENT_IDS, type AgentId } from "../../agents/agent-adapter.js";
import { nextTarget } from "./viewport.js";

describe("nextTarget", () => {
  it("一覧を順に巡回して先頭へ戻る", () => {
    let target: AgentId = AGENT_IDS[0];
    for (const expected of [...AGENT_IDS.slice(1), AGENT_IDS[0]]) {
      target = nextTarget(target);
      expect(target).toBe(expected);
    }
  });
});
