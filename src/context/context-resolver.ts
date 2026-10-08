// formal message から宛先 Agent への Task envelope を組み立てる（DESIGN.md §13）
import type { AgentMessage, Issue, MessageType } from "../protocol/messages.js";
import { COORDINATOR_MCP_SERVER, SEND_MESSAGE_TOOL } from "../agents/agent-adapter.js";
import { languageDirective, type Language } from "./language.js";

// 返信を求める依頼系。RESULT / ISSUE には返信を求めず、返信の連鎖を作らない
const REQUEST_TYPES = new Set<MessageType>(["QUESTION", "REVIEW_REQUEST", "DELEGATE"]);

const SPEC_INSTRUCTION =
  "Read the spec before you start and follow it. If the spec conflicts with the code or is unclear, ask with a QUESTION instead of guessing.";
const UPDATED_SPEC_INSTRUCTION = "The spec was updated for this answer. Read it and follow it in your remaining work.";

// Agent ごとに body の書き方がばらつかないよう、返信の書式を揃える（DESIGN.md §13）
export const BODY_FORMAT = "Write body in Markdown: a one-line summary first, then bullet points. Do not write one long paragraph.";

const formatIssue = ({ file, line, severity, summary }: Issue): string =>
  `- [${severity}] ${file}${line === undefined ? "" : `:${line}`} ${summary}`;

const specLines = (spec: string, changes: readonly string[] | undefined): string[] => {
  if (!changes) return [`Spec: ${spec}`];
  if (changes.length === 0) return [`Spec: ${spec} (unchanged since you last received it)`];
  return [`Spec: ${spec}`, "Spec changes since you last received it:", ...changes.map((change) => `- ${change}`)];
};

const specInstruction = (m: AgentMessage): string[] => {
  if (!m.spec) return [];
  return [m.type === "RESULT" ? UPDATED_SPEC_INSTRUCTION : SPEC_INSTRUCTION];
};

const replyInstruction = (m: AgentMessage): string[] =>
  REQUEST_TYPES.has(m.type)
    ? [
      // 他の連携手段（skill や CLI）と取り違えないよう、MCP tool であることを明示する
      `Reply with the ${SEND_MESSAGE_TOOL} tool of the "${COORDINATOR_MCP_SERVER}" MCP server (not a shell command): to="${m.from}", type="RESULT", taskId="${m.taskId}", replyTo="${m.id}".`,
      "Put findings in issues (file, line, severity, summary). Do not paste large content; reference files and commits.",
      BODY_FORMAT,
    ]
    : ["No reply is required."];

// language: 長い会話でも依頼のたびに言語を思い出させる（DESIGN.md §13 Language）
export const buildEnvelope = (m: AgentMessage, language?: Language): string => {
  const lines = [`[Clodex] Message ${m.id} from ${m.from}`, `Type: ${m.type}`, `Task: ${m.taskId}`];
  if (m.replyTo) lines.push(`Reply-To: ${m.replyTo}`);
  if (m.status) lines.push(`Status: ${m.status}`);
  if (m.auto) lines.push("Auto: the recipient ended its turn without send_message; this is its final reply.");
  if (m.interrupt) lines.push("Interrupt: yes");
  lines.push(`Repository: ${m.repository}`);
  if (m.commit) lines.push(`Commit: ${m.commit}`);
  if (m.spec) lines.push(...specLines(m.spec, m.specChanges));
  if (m.files?.length) lines.push("Files:", ...m.files.map((file) => `- ${file}`));
  if (m.issues?.length) lines.push("Issues:", ...m.issues.map(formatIssue));
  lines.push("", m.body, "", ...specInstruction(m), ...replyInstruction(m));
  if (language) lines.push(languageDirective(language));
  return lines.join("\n");
};
