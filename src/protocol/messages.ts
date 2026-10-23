// Agent 間の formal message（DESIGN.md §11）
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AGENT_IDS, type AgentId } from "../agents/agent-adapter.js";
import { AGENT_META } from "../agents/agent-meta.js";

export const MESSAGE_TYPES = ["QUESTION", "REVIEW_REQUEST", "DELEGATE", "FIX", "ADD", "NOTE", "CANCEL", "ANSWER", "RESULT", "ISSUE", "ACK"] as const;
export const RESULT_STATUSES = ["approved", "changes_requested", "done", "failed", "canceled"] as const;
export const ISSUE_SEVERITIES = ["low", "medium", "high", "critical"] as const;

// Minimal Context（DESIGN.md §3.3）: 本文は要約に留め、詳細は commit / files で参照させる
export const MAX_BODY_LENGTH = 4_000;
const MESSAGE_ID_PREFIX = "msg_";
const MESSAGE_ID_RANDOM_LENGTH = 8;

export const FOLLOWUP_TYPES: ReadonlySet<MessageType> = new Set(["FIX", "ADD", "NOTE", "CANCEL"]);
const TYPES_REQUIRING_REPLY_TO = new Set<MessageType>([...FOLLOWUP_TYPES, "ANSWER", "RESULT", "ACK"]);
const TYPES_ALLOWING_ISSUES = new Set<MessageType>(["RESULT", "ISSUE"]);
const TYPES_ALLOWING_FRESH = new Set<MessageType>(["DELEGATE", "REVIEW_REQUEST"]);
const TYPES_ALLOWING_REWORK = new Set<MessageType>(["DELEGATE", "FIX", "ADD"]);

const issueSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  severity: z.enum(ISSUE_SEVERITIES),
  summary: z.string().min(1),
});

// MCP tool send_message の入力 schema としても使う（refinement を含まない素の shape）
export const sendMessageShape = {
  to: z.enum(AGENT_IDS).describe("Recipient agent"),
  type: z
    .enum(MESSAGE_TYPES)
    .describe(
      "FIX corrects, ADD adds requirements to, NOTE informs about, CANCEL withdraws a DELEGATE / REVIEW_REQUEST you sent (replyTo = that request). Delivered into the recipient's running turn when it is working on it. ANSWER replies to a QUESTION; RESULT reports completed delegated work. Follow-ups, ANSWER, RESULT and ACK require replyTo",
    ),
  taskId: z.string().min(1).describe("Task ID"),
  effort: z
    .string()
    .min(1)
    .optional()
    .describe(`Reasoning effort for the turn that handles this request (${AGENT_IDS.filter(id => AGENT_META[id].effortInMessage).join(", ")} only)`),
  rework: z.enum(["spec", "impl", "check"]).optional().describe("Why this task is requested again with the same taskId: spec, impl or check"),
  relatesTo: z.string().min(1).optional().describe("Related previous task ID (DELEGATE or REVIEW_REQUEST only)"),
  body: z.string().min(1).max(MAX_BODY_LENGTH).describe("Request, question, or result summary. Reference commit/files instead of pasting large content"),
  replyTo: z.string().min(1).optional().describe("ID of the message this replies to"),
  commit: z.string().min(1).optional().describe("Commit hash to look at"),
  spec: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Path (relative to the project root) of the design document for this request. Write the design there first; keep body short. " +
        "On an ANSWER, the design document you updated to answer a QUESTION",
    ),
  files: z.array(z.string().min(1)).optional().describe("File paths relative to the project root"),
  status: z.enum(RESULT_STATUSES).optional().describe("RESULT only"),
  issues: z.array(issueSchema).optional().describe("RESULT or ISSUE only"),
  interrupt: z
    .boolean()
    .optional()
    .describe(
      "Deliver into the recipient's running turn when it is working on your request. " +
        "Use only for corrections that would otherwise waste the recipient's work",
    ),
  fresh: z
    .boolean()
    .optional()
    .describe(
      "Start the recipient in a new session before delivering (DELEGATE / REVIEW_REQUEST only). Use for a new task that does not need the recipient's earlier context.",
    ),
  parallel: z
    .boolean()
    .optional()
    .describe(
      "When the recipient is busy, run this request in a separate conversation of the same agent so it works in parallel. The recipient starts without its earlier context.",
    ),
  worktree: z.boolean().optional().describe("Create the parallel conversation in a new git worktree"),
};

const TYPES_ALLOWING_SPEC = new Set<MessageType>(["DELEGATE", "REVIEW_REQUEST", "FIX", "ADD", "NOTE", "RESULT", "ANSWER"]);
const sendMessageSchema = z.object(sendMessageShape).superRefine((input, ctx) => {
  if (input.effort !== undefined && (!AGENT_META[input.to].effortInMessage || !TYPES_ALLOWING_FRESH.has(input.type))) {
    ctx.addIssue({
      code: "custom",
      path: ["effort"],
      message: `allowed only for DELEGATE or REVIEW_REQUEST to ${AGENT_IDS.filter(id => AGENT_META[id].effortInMessage).join(", ")}`,
    });
  }
  if (input.rework !== undefined && !TYPES_ALLOWING_REWORK.has(input.type)) {
    ctx.addIssue({ code: "custom", path: ["rework"], message: "allowed only for DELEGATE, FIX or ADD" });
  }
  if (input.relatesTo !== undefined && !TYPES_ALLOWING_FRESH.has(input.type)) {
    ctx.addIssue({ code: "custom", path: ["relatesTo"], message: "allowed only for DELEGATE or REVIEW_REQUEST" });
  }
  if (FOLLOWUP_TYPES.has(input.type)) {
    for (const field of ["fresh", "parallel", "worktree"] as const) {
      if (input[field] !== undefined) ctx.addIssue({ code: "custom", path: [field], message: `not allowed for ${input.type}` });
    }
  }
  if (input.spec !== undefined && !TYPES_ALLOWING_SPEC.has(input.type)) {
    ctx.addIssue({ code: "custom", path: ["spec"], message: "allowed only for DELEGATE, REVIEW_REQUEST, FIX, ADD, NOTE, RESULT or ANSWER" });
  }
  if (input.fresh === true && !TYPES_ALLOWING_FRESH.has(input.type)) {
    ctx.addIssue({ code: "custom", path: ["fresh"], message: "allowed only for DELEGATE or REVIEW_REQUEST" });
  }
  if (input.fresh === true && input.interrupt === true) {
    ctx.addIssue({ code: "custom", path: ["fresh"], message: "cannot be combined with interrupt" });
  }
  if (input.parallel === true && !TYPES_ALLOWING_FRESH.has(input.type)) {
    ctx.addIssue({ code: "custom", path: ["parallel"], message: "allowed only for DELEGATE or REVIEW_REQUEST" });
  }
  if (input.parallel === true && input.fresh === true) {
    ctx.addIssue({ code: "custom", path: ["parallel"], message: "already starts in a new session; omit fresh" });
  }
  if (input.parallel === true && input.interrupt === true) {
    ctx.addIssue({ code: "custom", path: ["parallel"], message: "cannot be combined with interrupt" });
  }
  if (input.worktree === true && input.parallel !== true) {
    ctx.addIssue({ code: "custom", path: ["worktree"], message: "requires parallel: true" });
  }
});

export type MessageType = (typeof MESSAGE_TYPES)[number];
export type Issue = z.infer<typeof issueSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export interface VerificationCheck {
  command: string;
  ran: boolean;
  exitCode?: number;
  failed?: boolean;
}

export interface ChangedFile {
  path: string;
  scope?: "owned" | "forbidden" | "outside";
  peer?: true;
}

export interface VerificationEvidence {
  root?: string;
  checks: VerificationCheck[];
  changed: ChangedFile[] | { count: number };
}

export interface SpecCheckResult {
  command: string;
  exitCode?: number;
  timedOut?: boolean;
  output: string;
}

export interface AgentMessage extends SendMessageInput {
  id: string;
  from: AgentId;
  repository: string;
  createdAt: string;
  specChanges?: string[];
  specHash?: string;
  evidence?: VerificationEvidence;
  specCheck?: SpecCheckResult;
  auto?: true;
  thread?: string;
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

const formatZodError = (error: z.ZodError): string => error.issues.map(issue => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");

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
