import { readFileSync } from "node:fs";
import { z } from "zod";
import { AGENT_IDS } from "../agents/agent-adapter.js";
import { sendMessageShape } from "../protocol/messages.js";
import { writeFileAtomic } from "./atomic-write.js";
import { conversationStatePath } from "./conversation-history.js";

const messageSchema = z.object(sendMessageShape).extend({
  id: z.string().min(1), from: z.enum(AGENT_IDS), repository: z.string().min(1), createdAt: z.string(),
});
const itemSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("input"), text: z.string(), images: z.array(z.string()).optional() }),
  z.strictObject({ kind: z.literal("message"), message: messageSchema }),
]);
const conversationSchema = z.strictObject({
  interrupted: z.array(z.enum(AGENT_IDS)),
  queue: z.strictObject({ claude: z.array(itemSchema), codex: z.array(itemSchema) }),
});
const recoverySchema = z.strictObject({
  current: z.string().min(1), conversations: z.record(z.string(), conversationSchema),
});

export type RecoveryItem = z.infer<typeof itemSchema>;
export type ConversationRecovery = z.infer<typeof conversationSchema>;
export type RecoveryState = z.infer<typeof recoverySchema>;

export const hasRecoveryWork = ({ interrupted, queue }: ConversationRecovery): boolean =>
  interrupted.length > 0 || AGENT_IDS.some((agent) => queue[agent].length > 0);

export const recoveryPath = (homeDir: string, projectRoot: string): string =>
  conversationStatePath(homeDir, projectRoot).replace(/\.json$/, ".recovery.json");

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
