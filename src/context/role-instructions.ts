// Agent の起動時に system prompt へ追加する定型文と役割（DESIGN.md §13 Roles）
import { AGENT_IDS, type AgentId } from "../agents/agent-adapter.js";
import type { RolesConfig } from "../config/config.js";

const NOT_SPECIFIED = "not specified";

const peerOf = (agent: AgentId): AgentId => AGENT_IDS.find((id) => id !== agent)!;

const header = (agent: AgentId, peer: AgentId) =>
  `[Clodex] You are the "${agent}" agent in Clodex, working with a peer agent "${peer}" on the same repository.`;

const SEND_TOOL = 'the send_message tool of the "clodex" MCP server';

export const buildRoleInstructions = (agent: AgentId, roles: RolesConfig | undefined): string => {
  const peer = peerOf(agent);
  if (!roles?.[agent] && !roles?.[peer]) {
    return [
      header(agent, peer),
      `Ask the peer with ${SEND_TOOL} only when an independent view helps (review, hard bugs, uncertain design).`,
    ].join("\n");
  }
  return [
    header(agent, peer),
    `Your role: ${roles[agent] ?? NOT_SPECIFIED}`,
    `Role of ${peer}: ${roles[peer] ?? NOT_SPECIFIED}`,
    `When work belongs to ${peer}'s role, delegate it with ${SEND_TOOL} (DELEGATE, QUESTION or REVIEW_REQUEST) instead of doing it yourself.`,
    "Do not do the same work as the peer. Small edits (typos, formatting, trivial fixes) you may do yourself.",
  ].join("\n");
};
