import { AGENT_IDS, type AgentId, CLAUDE_EFFORT_LEVELS } from "./agent-adapter.js";

export const peersOf = (id: AgentId): AgentId[] => AGENT_IDS.filter(peer => peer !== id);
export const agentRecord = <T>(init: (id: AgentId) => T): Record<AgentId, T> => Object.fromEntries(AGENT_IDS.map(id => [id, init(id)])) as Record<AgentId, T>;

const CODEX_USAGE_NOTE = "Run long commands (tests, builds) with a long enough yield_time_ms to finish in one call. Do not poll with wait or write_stdin.";
const CLAUDE_USAGE_NOTE =
  "Run long commands with a long enough Bash timeout (up to 600000 ms) to finish in one call. " +
  "Do not check run_in_background commands again and again with sleep or by re-reading their output.";

interface AgentMeta {
  name: string;
  effortLevels: readonly string[];
  effortInMessage: boolean;
  usageHint: string;
  cumulativeInput: boolean;
  ideaPrefix: string;
  steer: boolean;
}
export const AGENT_META: Record<AgentId, AgentMeta> = {
  claude: {
    name: "Claude",
    effortLevels: CLAUDE_EFFORT_LEVELS,
    effortInMessage: false,
    usageHint: CLAUDE_USAGE_NOTE,
    cumulativeInput: true,
    ideaPrefix: "C",
    steer: true,
  },
  codex: {
    name: "Codex",
    effortLevels: ["minimal", "low", "medium", "high", "xhigh"],
    effortInMessage: true,
    usageHint: CODEX_USAGE_NOTE,
    cumulativeInput: false,
    ideaPrefix: "X",
    steer: true,
  },
  // agy の headless には実行中のターンへ入力を足す手段が無い（docs/spikes/antigravity.md）
  gemini: { name: "Gemini", effortLevels: [], effortInMessage: false, usageHint: CLAUDE_USAGE_NOTE, cumulativeInput: true, ideaPrefix: "G", steer: false },
};
