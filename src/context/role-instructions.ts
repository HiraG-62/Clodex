// Agent の起動時に system prompt へ追加する定型文と役割（DESIGN.md §13 Roles）
import { AGENT_IDS, COORDINATOR_MCP_SERVER, SEND_MESSAGE_TOOL, type AgentId } from "../agents/agent-adapter.js";
import type { RolesConfig } from "../config/config.js";
import { languageDirective, type Language } from "./language.js";

const NOT_SPECIFIED = "not specified";

const peerOf = (agent: AgentId): AgentId => AGENT_IDS.find((id) => id !== agent)!;

const header = (agent: AgentId, peer: AgentId) =>
  `[Clodex] You are the "${agent}" agent in Clodex, working with a peer agent "${peer}" on the same repository.`;

const SEND_TOOL = `the ${SEND_MESSAGE_TOOL} tool of the "${COORDINATOR_MCP_SERVER}" MCP server`;

// -p / app-server では人がその場で承認できないので、/permission を案内させる（DESIGN.md §9 Permission）
const PERMISSION_NOTE =
  "The human cannot approve tool permissions interactively. If an action is denied, say so and suggest the Clodex /permission command.";

// 指示してから完了するまで何も見えない状態を避ける（DESIGN.md §17 ログの「方針」）
const PLAN_NOTE = "When you receive a request, state in one or two sentences what you will do before you start working.";

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

// 証跡の画像は project の外に置かせ、Web UI の成果物に出す（DESIGN.md §28 v0.3 B）
const artifactsNote = (dir: string) =>
  `To show the human an image (for example a screenshot as evidence), save it under ${dir} and write its full path in your reply.`;

export interface RoleInstructionOptions {
  language?: Language;
  artifactsDir?: string;
}

export const buildRoleInstructions = (
  agent: AgentId, roles: RolesConfig | undefined, { language, artifactsDir }: RoleInstructionOptions = {},
): string => {
  const peer = peerOf(agent);
  return [
    header(agent, peer), ...roleLines(agent, peer, roles), PERMISSION_NOTE, PLAN_NOTE,
    ...(artifactsDir ? [artifactsNote(artifactsDir)] : []),
    ...(language ? [languageDirective(language)] : []),
  ].join("\n");
};
