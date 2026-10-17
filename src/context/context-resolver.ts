// formal message から宛先 Agent への Task envelope を組み立てる（DESIGN.md §13）

import { COORDINATOR_MCP_SERVER, SEND_MESSAGE_TOOL } from "../agents/agent-adapter.js";
import type { AgentMessage, Issue, MessageType } from "../protocol/messages.js";
import { type Language, languageDirective } from "./language.js";

// 返信を求める依頼系。RESULT / ISSUE には返信を求めず、返信の連鎖を作らない
const REQUEST_TYPES = new Set<MessageType>(["QUESTION", "REVIEW_REQUEST", "DELEGATE", "FIX", "ADD"]);

const SPEC_INSTRUCTION =
  "Read the spec before you start and follow it. If the spec conflicts with the code or is unclear, ask with a QUESTION instead of guessing.";
const UPDATED_SPEC_INSTRUCTION = "The spec was updated for this answer. Read it and follow it in your remaining work.";

// Agent ごとに body の書き方がばらつかないよう、返信の書式を揃える（DESIGN.md §13）
export const BODY_FORMAT = "Write body in Markdown: a one-line summary first, then bullet points. Do not write one long paragraph.";

const formatIssue = ({ file, line, severity, summary }: Issue): string => `- [${severity}] ${file}${line === undefined ? "" : `:${line}`} ${summary}`;

const specLines = (spec: string, changes: readonly string[] | undefined, hash: string | undefined): string[] => {
  const line = `Spec: ${spec}${hash ? ` (sha256:${hash})` : ""}`;
  if (!changes) return [line];
  if (changes.length === 0) return [`${line} (unchanged since you last received it)`];
  return [line, "Spec changes since you last received it:", ...changes.map(change => `- ${change}`)];
};

const specInstruction = (m: AgentMessage): string[] => {
  if (!m.spec) return [];
  return [m.type === "ANSWER" ? UPDATED_SPEC_INSTRUCTION : SPEC_INSTRUCTION];
};

const replyInstruction = (m: AgentMessage): string[] => {
  if (m.type === "NOTE") return ["No reply is required. Take this into account in the current work."];
  if (m.type === "CANCEL")
    return [`Stop working on this request now. Reply with RESULT, status="canceled", replyTo="${m.replyTo}", summarizing what was done and what was left.`];
  if (!REQUEST_TYPES.has(m.type)) return ["No reply is required."];
  const followup = m.type === "FIX" || m.type === "ADD";
  return [
    // 他の連携手段（skill や CLI）と取り違えないよう、MCP tool であることを明示する
    `Reply with the ${SEND_MESSAGE_TOOL} tool of the "${COORDINATOR_MCP_SERVER}" MCP server (not a shell command): to="${m.from}", type="${m.type === "QUESTION" ? "ANSWER" : "RESULT"}", taskId="${m.taskId}", replyTo="${followup ? m.replyTo : m.id}".`,
    ...(m.type === "QUESTION"
      ? []
      : [
          followup
            ? "Send RESULT once when the corrected work is complete. Put findings in issues (file, line, severity, summary). Do not paste large content; reference files and commits."
            : "Send RESULT when the requested work is complete. Put findings in issues (file, line, severity, summary). Do not paste large content; reference files and commits.",
        ]),
    BODY_FORMAT,
  ];
};

// language: 長い会話でも依頼のたびに言語を思い出させる（DESIGN.md §13 Language）
export const buildEnvelope = (m: AgentMessage, language?: Language): string => {
  const lines = [`[Clodex] Message ${m.id} from ${m.from}`, `Type: ${m.type}`, `Task: ${m.taskId}`];
  if (m.replyTo) lines.push(`Reply-To: ${m.replyTo}`);
  if (m.status) lines.push(`Status: ${m.status}`);
  if (m.effort) lines.push(`Effort: ${m.effort}`);
  if (m.rework) lines.push(`Rework: ${m.rework}`);
  if (m.relatesTo) lines.push(`Relates-To: ${m.relatesTo}`);
  if (m.auto) lines.push("Auto: the recipient ended its turn without send_message; this is its final reply.");
  if (m.parallel && m.thread) lines.push("Parallel: yes (a separate conversation; your other work continues elsewhere)");
  if (m.interrupt && !m.fresh) lines.push("Interrupt: yes");
  lines.push(`Repository: ${m.repository}`);
  if (m.commit) lines.push(`Commit: ${m.commit}`);
  if (m.spec) lines.push(...specLines(m.spec, m.specChanges, m.specHash));
  if (m.files?.length) lines.push("Files:", ...m.files.map(file => `- ${file}`));
  if (m.issues?.length) lines.push("Issues:", ...m.issues.map(formatIssue));
  lines.push("", m.body, "", ...specInstruction(m), ...replyInstruction(m));
  if (language) lines.push(languageDirective(language));
  return lines.join("\n");
};
