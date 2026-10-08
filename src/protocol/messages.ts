// Agent 間の formal message（DESIGN.md §11）
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AGENT_IDS, type AgentId } from "../agents/agent-adapter.js";

export const MESSAGE_TYPES = ["QUESTION", "REVIEW_REQUEST", "DELEGATE", "RESULT", "ISSUE", "ACK"] as const;
export const RESULT_STATUSES = ["approved", "changes_requested", "done", "failed"] as const;
export const ISSUE_SEVERITIES = ["low", "medium", "high", "critical"] as const;

// Minimal Context（DESIGN.md §3.3）: 本文は要約に留め、詳細は commit / files で参照させる
export const MAX_BODY_LENGTH = 4_000;
const MESSAGE_ID_PREFIX = "msg_";
const MESSAGE_ID_RANDOM_LENGTH = 8;

const TYPES_REQUIRING_REPLY_TO = new Set<MessageType>(["RESULT", "ACK"]);
const TYPES_ALLOWING_ISSUES = new Set<MessageType>(["RESULT", "ISSUE"]);

const issueSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  severity: z.enum(ISSUE_SEVERITIES),
  summary: z.string().min(1),
});

// MCP tool send_message の入力 schema としても使う（refinement を含まない素の shape）
export const sendMessageShape = {
  to: z.enum(AGENT_IDS).describe("Recipient agent"),
  type: z.enum(MESSAGE_TYPES).describe("Message type. RESULT and ACK require replyTo"),
  taskId: z.string().min(1).describe("Task ID"),
  body: z.string().min(1).max(MAX_BODY_LENGTH)
    .describe("Request, question, or result summary. Reference commit/files instead of pasting large content"),
  replyTo: z.string().min(1).optional().describe("ID of the message this replies to"),
  commit: z.string().min(1).optional().describe("Commit hash to look at"),
  spec: z.string().min(1).optional().describe(
    "Path (relative to the project root) of the design document for this request. Write the design there first; keep body short. " +
    "On a RESULT, the design document you updated to answer a QUESTION",
  ),
  files: z.array(z.string().min(1)).optional().describe("File paths relative to the project root"),
  status: z.enum(RESULT_STATUSES).optional().describe("RESULT only"),
  issues: z.array(issueSchema).optional().describe("RESULT or ISSUE only"),
  interrupt: z.boolean().optional().describe(
    "Deliver into the recipient's running turn when it is working on your request. " +
    "Use only for corrections that would otherwise waste the recipient's work",
  ),
};

const TYPES_ALLOWING_SPEC = new Set<MessageType>(["DELEGATE", "REVIEW_REQUEST", "RESULT"]);
const sendMessageSchema = z.object(sendMessageShape).superRefine((input, ctx) => {
  if (input.spec !== undefined && !TYPES_ALLOWING_SPEC.has(input.type)) {
    ctx.addIssue({ code: "custom", path: ["spec"], message: "allowed only for DELEGATE, REVIEW_REQUEST or RESULT" });
  }
});

export type MessageType = (typeof MESSAGE_TYPES)[number];
export type Issue = z.infer<typeof issueSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export interface AgentMessage extends SendMessageInput {
  id: string;
  from: AgentId;
  repository: string;
  createdAt: string;
}

export interface MessageContext {
  from: AgentId;
  repository: string;
  now?: () => Date;
  createId?: () => string;
}

export type CreateMessageResult = { ok: true; message: AgentMessage } | { ok: false; error: string };

const defaultMessageId = () => `${MESSAGE_ID_PREFIX}${randomUUID().replace(/-/g, "").slice(0, MESSAGE_ID_RANDOM_LENGTH)}`;

// Schema では表せない、type や送信元に依存する規則。エラー文は Agent が読んで直せる英語にする
const ruleViolation = (input: SendMessageInput, from: AgentId): string | undefined => {
  if (input.to === from) return "to: you cannot send a message to yourself";
  if (TYPES_REQUIRING_REPLY_TO.has(input.type) && !input.replyTo) return `replyTo: required for ${input.type}`;
  if (input.status && input.type !== "RESULT") return "status: allowed only for RESULT";
  if (input.issues && !TYPES_ALLOWING_ISSUES.has(input.type)) return "issues: allowed only for RESULT or ISSUE";
  return undefined;
};

const formatZodError = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");

// Agent の入力を検証し、Coordinator が決めるフィールドを付けて message にする
export const createMessage = (
  input: unknown,
  { from, repository, now = () => new Date(), createId = defaultMessageId }: MessageContext,
): CreateMessageResult => {
  const parsed = sendMessageSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };

  const violation = ruleViolation(parsed.data, from);
  if (violation) return { ok: false, error: violation };

  return {
    ok: true,
    message: { ...parsed.data, id: createId(), from, repository, createdAt: now().toISOString() },
  };
};
