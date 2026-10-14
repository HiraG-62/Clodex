import type { AgentId } from "../agents/agent-adapter.js";

export const BRAINSTORM_RESPONSE_LIMIT = 8000;

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

export const roundPrompt = (config: BrainstormConfig, round: number, peer: AgentId, previous: string, human: readonly string[]): string =>
  `${additions(human)}Topic: ${config.topic}\n` +
  (round === 1
    ? "Round 1: Broaden the ideas independently, without seeing the other agent's ideas. Give concrete ideas in bullet points."
    : `Round ${round}: Develop, combine, and critique the other agent's ideas. Add new ideas.\n${peer}'s previous response:\n${clip(previous)}`);

export const summaryPrompt = (config: BrainstormConfig, responses: readonly BrainstormResponse[], human: readonly string[]): string =>
  `${additions(human)}Topic: ${config.topic}\nSummarize the brainstorm: key questions, all ideas with attribution to Claude or Codex, promising ideas with reasons, and unresolved questions.\n\n` +
  responses.map(({ round, agent, text }) => `Round ${round}, ${agent}:\n${clip(text)}`).join("\n\n");
