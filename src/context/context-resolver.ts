// formal message から宛先 Agent への Task envelope を組み立てる（DESIGN.md §13）
import type { AgentMessage, Issue, MessageType } from "../protocol/messages.js";

// 返信を求める依頼系。RESULT / ISSUE には返信を求めず、返信の連鎖を作らない
const REQUEST_TYPES = new Set<MessageType>(["QUESTION", "REVIEW_REQUEST", "DELEGATE"]);

const formatIssue = ({ file, line, severity, summary }: Issue): string =>
  `- [${severity}] ${file}${line === undefined ? "" : `:${line}`} ${summary}`;

const replyInstruction = (m: AgentMessage): string[] =>
  REQUEST_TYPES.has(m.type)
    ? [
      `Reply with the clodex send_message tool: to="${m.from}", type="RESULT", taskId="${m.taskId}", replyTo="${m.id}".`,
      "Put findings in issues (file, line, severity, summary). Do not paste large content; reference files and commits.",
    ]
    : ["No reply is required."];

export const buildEnvelope = (m: AgentMessage): string => {
  const lines = [`[Clodex] Message ${m.id} from ${m.from}`, `Type: ${m.type}`, `Task: ${m.taskId}`];
  if (m.replyTo) lines.push(`Reply-To: ${m.replyTo}`);
  if (m.status) lines.push(`Status: ${m.status}`);
  lines.push(`Repository: ${m.repository}`);
  if (m.commit) lines.push(`Commit: ${m.commit}`);
  if (m.files?.length) lines.push("Files:", ...m.files.map((file) => `- ${file}`));
  if (m.issues?.length) lines.push("Issues:", ...m.issues.map(formatIssue));
  lines.push("", m.body, "", ...replyInstruction(m));
  return lines.join("\n");
};
