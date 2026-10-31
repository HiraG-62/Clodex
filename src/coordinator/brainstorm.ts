import { AGENT_IDS, type AgentId } from "../agents/agent-adapter.js";
import { AGENT_META } from "../agents/agent-meta.js";

export const BRAINSTORM_RESPONSE_LIMIT = 8000;
export const DEFAULT_BRAINSTORM_ROUNDS = 3;
export type BrainstormReason = "consensus" | "limit" | "human";
export type BrainstormPhase = "idle" | "opening" | "round" | "human" | "summary" | "done" | "stopped";
export type IdeaStance = "support" | "conditional" | "oppose";
export interface AgentStance {
  ideas: Record<string, IdeaStance>;
  open: string;
}
export type BrainstormStances = Record<AgentId, AgentStance | undefined>;

export interface BrainstormConfig {
  topic: string;
  rounds: number;
  join?: boolean;
}

export interface BrainstormResponse {
  round: number;
  agent: AgentId | "Human";
  text: string;
}

const clip = (text: string) => text.slice(0, BRAINSTORM_RESPONSE_LIMIT);
const additions = (texts: readonly string[]) => (texts.length ? `The human added:\n${texts.map(text => `- ${text}`).join("\n")}\n\n` : "");
const speaker = (agent: BrainstormResponse["agent"]) => (agent === "Human" ? agent : AGENT_META[agent].name);

export const debateOrder = (round: number): AgentId[] => {
  const start = (round - 1) % AGENT_IDS.length;
  return [...AGENT_IDS.slice(start), ...AGENT_IDS.slice(0, start)];
};

export const parseStance = (text: string): AgentStance | undefined => {
  const blocks = [...text.matchAll(/^[ \t]*```[ \t]*stance[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gim)];
  const block = blocks.at(-1)?.[1];
  if (!block) return undefined;
  const ideas: Record<string, IdeaStance> = {};
  let open: string | undefined;
  for (const line of block.split(/\r?\n/)) {
    const match = /^\s*([a-z]\d+)\s*:\s*(support|conditional|oppose)\s*$/i.exec(line);
    if (match?.[1] && match[2]) ideas[match[1].toUpperCase()] = match[2].toLowerCase() as IdeaStance;
    const question = /^\s*open\s*:\s*(.+?)\s*$/i.exec(line)?.[1];
    if (question) open = question.toLowerCase() === "none" ? "none" : question;
  }
  return Object.keys(ideas).length && open ? { ideas, open } : undefined;
};

export const hasConsensus = (stances: BrainstormStances): boolean => {
  if (AGENT_IDS.some(id => stances[id]?.open !== "none")) return false;
  const ideas = new Map<string, Set<IdeaStance>>();
  for (const id of AGENT_IDS) {
    for (const [idea, value] of Object.entries(stances[id]?.ideas ?? {})) {
      const values = ideas.get(idea) ?? new Set<IdeaStance>();
      values.add(value);
      ideas.set(idea, values);
    }
  }
  return [...ideas.values()].every(values => !values.has("support") || !values.has("oppose"));
};

export const roundPrompt = (
  config: BrainstormConfig,
  round: number,
  agent: AgentId,
  previous: readonly BrainstormResponse[],
  human: readonly string[],
): string => {
  const prefix = AGENT_META[agent].ideaPrefix;
  const start = `${additions(human)}Topic: ${config.topic}\nAssign IDs to your ideas: ${prefix}1, ${prefix}2, ... Continue numbering across rounds.\n`;
  if (round === 0) return `${start}Opening: Broaden the ideas independently, without seeing the other agents' ideas. Give concrete ideas in bullet points.`;
  const ownIndex = previous.findLastIndex(response => response.agent === agent);
  const own = previous[ownIndex];
  // 開幕の発言は同時なので、記録順によらず全員の案を議論に含める。
  const since = previous.slice(own?.round === 0 ? 0 : ownIndex + 1);
  const advocate =
    debateOrder(round)[0] === agent
      ? "You are this round's devil's advocate: challenge the most promising ideas with strong objections, overlooked risks, and conditions under which they fail. State your honest position in the stance block independently of this role.\n"
      : "";
  return (
    `${start}Discussion round ${round}: Answer questions addressed to you and critiques of your own ideas; explicitly rebut, revise, or withdraw. ` +
    "Refer to the other agents' ideas by ID when critiquing them. Combine ideas, add new ideas, and ask named participants questions when needed.\n" +
    advocate +
    (config.join ? "Respond to Human contributions too. The first agent to take up a human idea assigns H1, H2, ...; continue the shared H numbering.\n" : "") +
    "End every discussion response with a stance block listing your current honest position on all ideas. Use support | conditional | oppose. The final line must be open: none or one line describing the question to continue.\n" +
    "```stance\nC1: support\nX2: conditional\nG1: oppose\nopen: none\n```\n\n" +
    since
      .filter(response => response.agent !== agent)
      .map(response => `${speaker(response.agent)}:\n${clip(response.text)}`)
      .join("\n\n")
  );
};

export const summaryPrompt = (
  config: BrainstormConfig,
  responses: readonly BrainstormResponse[],
  human: readonly string[],
  stances: BrainstormStances,
  reason: BrainstormReason,
): string => {
  const ids = [...new Set(AGENT_IDS.flatMap(id => Object.keys(stances[id]?.ideas ?? {})))];
  const table = [
    `ID | ${AGENT_IDS.map(id => AGENT_META[id].name).join(" | ")}`,
    ...ids.map(idea => `${idea} | ${AGENT_IDS.map(id => stances[id]?.ideas[idea] ?? "unknown").join(" | ")}`),
    `open | ${AGENT_IDS.map(id => stances[id]?.open ?? "unknown").join(" | ")}`,
  ].join("\n");
  return (
    `${additions(human)}Topic: ${config.topic}\nEnded because: ${reason}\n` +
    "Summarize the brainstorm: conclusions and agreed ideas, key questions, all ideas in a table with columns ID | Proposer | " +
    AGENT_IDS.map(id => `${AGENT_META[id].name} final stance`).join(" | ") +
    " | Status | Basis, promising ideas with reasons, and unresolved questions. " +
    "Status must be adopted / adopted with changes / on hold / rejected. Basis should cite measurements, code, or the other agents' critique. " +
    "Describe the debate: main objections and responses, revisions, and withdrawals. " +
    (reason === "limit" ? "The limit was reached without agreement: explicitly list disputed ideas and the arguments on both sides. " : "") +
    "\nLatest stances:\n" +
    table +
    "\n\n" +
    responses.map(({ round, agent, text }) => `${round === 0 ? "Opening" : `Round ${round}`}, ${speaker(agent)}:\n${clip(text)}`).join("\n\n")
  );
};
