import { AGENT_IDS, type AgentId } from "../agents/agent-adapter.js";

export const BRAINSTORM_RESPONSE_LIMIT = 8000;

const IDEA_ID_PREFIX: Record<AgentId, string> = { claude: "C", codex: "X" };
const SUMMARY_INSTRUCTION =
  "Summarize the brainstorm: key questions, all ideas in a table with columns ID | Proposer | Status | Basis, promising ideas with reasons, and unresolved questions. " +
  "Proposer is Claude or Codex. Status must be adopted / adopted with changes / on hold / rejected. " +
  "Basis should cite measurements, code, or the other agent's critique.";

export interface BrainstormConfig {
  topic: string;
  rounds: number;
}

export interface BrainstormResponse {
  round: number;
  agent: AgentId;
  text: string;
}

const clip = (text: string) => text.slice(0, BRAINSTORM_RESPONSE_LIMIT);
const additions = (texts: readonly string[]) => (texts.length ? `The human added:\n${texts.map(text => `- ${text}`).join("\n")}\n\n` : "");

const ideaIdInstruction = (peer: AgentId): string => {
  const agent = AGENT_IDS.find(id => id !== peer)!;
  const prefix = IDEA_ID_PREFIX[agent];
  return `Assign IDs to your ideas: ${prefix}1, ${prefix}2, ... Continue numbering across rounds.\n`;
};

export const roundPrompt = (config: BrainstormConfig, round: number, peer: AgentId, previous: string, human: readonly string[]): string =>
  `${additions(human)}Topic: ${config.topic}\n` +
  ideaIdInstruction(peer) +
  (round === 1
    ? "Round 1: Broaden the ideas independently, without seeing the other agent's ideas. Give concrete ideas in bullet points."
    : `Round ${round}: Develop, combine, and critique the other agent's ideas. Refer to the other agent's ideas by ID when critiquing them. Add new ideas.\n${peer}'s previous response:\n${clip(previous)}`);

export const summaryPrompt = (config: BrainstormConfig, responses: readonly BrainstormResponse[], human: readonly string[]): string =>
  `${additions(human)}Topic: ${config.topic}\n${SUMMARY_INSTRUCTION}\n\n` +
  responses.map(({ round, agent, text }) => `Round ${round}, ${agent}:\n${clip(text)}`).join("\n\n");
