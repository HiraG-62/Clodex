import { AGENT_IDS, type AgentId } from "../agents/agent-adapter.js";
import { AGENT_META, peersOf } from "../agents/agent-meta.js";

export const BRAINSTORM_RESPONSE_LIMIT = 8000;

const SUMMARY_INSTRUCTION =
  "Summarize the brainstorm: key questions, all ideas in a table with columns ID | Proposer | Status | Basis, promising ideas with reasons, and unresolved questions. " +
  `Proposer is ${AGENT_IDS.map(id => AGENT_META[id].name).join(" or ")}. Status must be adopted / adopted with changes / on hold / rejected. ` +
  "Basis should cite measurements, code, or the other agents' critique.";

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

const ideaIdInstruction = (agent: AgentId): string => {
  const prefix = AGENT_META[agent].ideaPrefix;
  return `Assign IDs to your ideas: ${prefix}1, ${prefix}2, ... Continue numbering across rounds.\n`;
};

export const roundPrompt = (
  config: BrainstormConfig,
  round: number,
  agent: AgentId,
  previous: readonly BrainstormResponse[],
  human: readonly string[],
): string =>
  `${additions(human)}Topic: ${config.topic}\n` +
  ideaIdInstruction(agent) +
  (round === 1
    ? "Round 1: Broaden the ideas independently, without seeing the other agents' ideas. Give concrete ideas in bullet points."
    : `Round ${round}: Develop, combine, and critique the other agents' ideas. Refer to the other agents' ideas by ID when critiquing them. Add new ideas.\n${previous
        .filter(response => peersOf(agent).includes(response.agent))
        .map(response => `${response.agent}'s previous response:\n${clip(response.text)}`)
        .join("\n\n")}`);

export const summaryPrompt = (config: BrainstormConfig, responses: readonly BrainstormResponse[], human: readonly string[]): string =>
  `${additions(human)}Topic: ${config.topic}\n${SUMMARY_INSTRUCTION}\n\n` +
  responses.map(({ round, agent, text }) => `Round ${round}, ${agent}:\n${clip(text)}`).join("\n\n");
