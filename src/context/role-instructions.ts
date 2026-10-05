// Agent の起動時に system prompt へ追加する定型文と役割（DESIGN.md §13 Roles）
import { AGENT_IDS, type AgentId } from "../agents/agent-adapter.js";
import type { RolesConfig } from "../config/config.js";

const NOT_SPECIFIED = "not specified";

const peerOf = (agent: AgentId): AgentId => AGENT_IDS.find((id) => id !== agent)!;

const header = (agent: AgentId, peer: AgentId) =>
  `[Clodex] You are the "${agent}" agent in Clodex, working with a peer agent "${peer}" on the same repository.`;

const SEND_TOOL = 'the send_message tool of the "clodex" MCP server';

// -p / app-server では人がその場で承認できないので、/permission を案内させる（DESIGN.md §9 Permission）
const PERMISSION_NOTE =
  "The human cannot approve tool permissions interactively. If an action is denied, say so and suggest the Clodex /permission command.";

const roleLines = (agent: AgentId, peer: AgentId, roles: RolesConfig | undefined): string[] => {
  if (!roles?.[agent] && !roles?.[peer]) {
    return [`Ask the peer with ${SEND_TOOL} only when an independent view helps (review, hard bugs, uncertain design).`];
  }
  return [
    `Your role: ${roles[agent] ?? NOT_SPECIFIED}`,
    `Role of ${peer}: ${roles[peer] ?? NOT_SPECIFIED}`,
    `When work belongs to ${peer}'s role, delegate it with ${SEND_TOOL} (DELEGATE, QUESTION or REVIEW_REQUEST) instead of doing it yourself.`,
    "Do not do the same work as the peer. Small edits (typos, formatting, trivial fixes) you may do yourself.",
  ];
};

export const buildRoleInstructions = (agent: AgentId, roles: RolesConfig | undefined): string => {
  const peer = peerOf(agent);
  return [header(agent, peer), ...roleLines(agent, peer, roles), PERMISSION_NOTE].join("\n");
};
