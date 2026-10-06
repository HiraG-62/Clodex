// formal message から宛先 Agent への Task envelope を組み立てる（DESIGN.md §13）
import type { AgentMessage, Issue, MessageType } from "../protocol/messages.js";
import { COORDINATOR_MCP_SERVER, SEND_MESSAGE_TOOL } from "../agents/agent-adapter.js";
import { languageDirective, type Language } from "./language.js";

// 返信を求める依頼系。RESULT / ISSUE には返信を求めず、返信の連鎖を作らない
const REQUEST_TYPES = new Set<MessageType>(["QUESTION", "REVIEW_REQUEST", "DELEGATE"]);

const SPEC_INSTRUCTION =
  "Read the spec before you start and follow it. If the spec conflicts with the code or is unclear, ask with a QUESTION instead of guessing.";

const formatIssue = ({ file, line, severity, summary }: Issue): string =>
  `- [${severity}] ${file}${line === undefined ? "" : `:${line}`} ${summary}`;

const replyInstruction = (m: AgentMessage): string[] =>
  REQUEST_TYPES.has(m.type)
    ? [
      // 他の連携手段（skill や CLI）と取り違えないよう、MCP tool であることを明示する
      `Reply with the ${SEND_MESSAGE_TOOL} tool of the "${COORDINATOR_MCP_SERVER}" MCP server (not a shell command): to="${m.from}", type="RESULT", taskId="${m.taskId}", replyTo="${m.id}".`,
      "Put findings in issues (file, line, severity, summary). Do not paste large content; reference files and commits.",
    ]
    : ["No reply is required."];

// language: 長い会話でも依頼のたびに言語を思い出させる（DESIGN.md §13 Language）
export const buildEnvelope = (m: AgentMessage, language?: Language): string => {
  const lines = [`[Clodex] Message ${m.id} from ${m.from}`, `Type: ${m.type}`, `Task: ${m.taskId}`];
  if (m.replyTo) lines.push(`Reply-To: ${m.replyTo}`);
  if (m.status) lines.push(`Status: ${m.status}`);
  if (m.interrupt) lines.push("Interrupt: yes");
  lines.push(`Repository: ${m.repository}`);
  if (m.commit) lines.push(`Commit: ${m.commit}`);
  if (m.spec) lines.push(`Spec: ${m.spec}`);
  if (m.files?.length) lines.push("Files:", ...m.files.map((file) => `- ${file}`));
  if (m.issues?.length) lines.push("Issues:", ...m.issues.map(formatIssue));
  lines.push("", m.body, "", ...(m.spec ? [SPEC_INSTRUCTION] : []), ...replyInstruction(m));
  if (language) lines.push(languageDirective(language));
  return lines.join("\n");
};
