import { readFileSync } from "node:fs";
import { z } from "zod";
import { AGENT_IDS } from "../agents/agent-adapter.js";
import { sendMessageShape } from "../protocol/messages.js";
import { pendingQuestionSchema } from "../protocol/questions.js";
import { writeFileAtomic } from "./atomic-write.js";
import { conversationStatePath } from "./conversation-history.js";

const messageSchema = z.object(sendMessageShape).extend({
  id: z.string().min(1),
  from: z.enum(AGENT_IDS),
  repository: z.string().min(1),
  createdAt: z.string(),
  evidence: z
    .object({
      root: z.string().optional(),
      checks: z.array(z.object({ command: z.string(), ran: z.boolean(), exitCode: z.number().optional(), failed: z.boolean().optional() })),
      changed: z.union([
        z.array(z.object({ path: z.string(), scope: z.enum(["owned", "forbidden", "outside"]).optional(), peer: z.literal(true).optional() })),
        z.object({ count: z.number() }),
      ]),
    })
    .optional(),
  specCheck: z.object({ command: z.string(), exitCode: z.number().optional(), timedOut: z.boolean().optional(), output: z.string() }).optional(),
});
const itemSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("input"),
    id: z.string().optional(),
    text: z.string(),
    images: z.array(z.string()).optional(),
    context: z.literal(true).optional(),
    brainstorm: z.literal(true).optional(),
  }),
  z.strictObject({ kind: z.literal("message"), message: messageSchema }),
]);
const workSchema = z.strictObject({ plan: z.string().optional(), actions: z.array(z.string()).max(5) });
const lastWorkSchema = z.strictObject({
  claude: workSchema.optional().catch(undefined),
  codex: workSchema.optional().catch(undefined),
});
const conversationSchema = z.strictObject({
  brainstormPhase: z.enum(["idle", "round", "summary", "done", "stopped"]).optional(),
  questions: z.array(pendingQuestionSchema).optional(),
  interrupted: z.array(z.enum(AGENT_IDS)),
  queue: z.strictObject({ claude: z.array(itemSchema), codex: z.array(itemSchema) }),
  lastWork: lastWorkSchema.optional().catch(undefined),
});
const recoverySchema = z.strictObject({
  current: z.string().min(1),
  conversations: z.record(z.string(), conversationSchema),
});

export type RecoveryItem = z.infer<typeof itemSchema>;
export type ConversationRecovery = z.infer<typeof conversationSchema>;
export type RecoveryState = z.infer<typeof recoverySchema>;

export const hasRecoveryWork = ({ interrupted, queue, questions }: ConversationRecovery): boolean =>
  (questions?.length ?? 0) > 0 || interrupted.length > 0 || AGENT_IDS.some(agent => queue[agent].length > 0);

export const recoveryPath = (homeDir: string, projectRoot: string): string => conversationStatePath(homeDir, projectRoot).replace(/\.json$/, ".recovery.json");

export const loadRecovery = (homeDir: string, projectRoot: string): RecoveryState | undefined => {
  try {
    const parsed = recoverySchema.safeParse(JSON.parse(readFileSync(recoveryPath(homeDir, projectRoot), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

export const saveRecovery = (homeDir: string, projectRoot: string, state: RecoveryState): void => {
  const conversations = Object.fromEntries(Object.entries(state.conversations).filter(([, item]) => hasRecoveryWork(item)));
  writeFileAtomic(recoveryPath(homeDir, projectRoot), `${JSON.stringify({ current: state.current, conversations }, null, 2)}\n`);
};
