import type { AgentId } from "../agents/agent-adapter.js";
import type { Messages } from "../i18n/messages.js";

export type NotificationKind = "work" | "reply" | "failed" | "interrupted" | "question" | "limitHold" | "error" | "notice";

export interface NotificationInput {
  kind: NotificationKind;
  projectRoot: string;
  conversationTitle?: string;
  agent?: AgentId;
  line?: string;
  time?: string;
}

export interface HubNotification {
  kind: NotificationKind;
  project: string;
  conversation: string;
  agent?: AgentId;
  title: string;
  body: string;
}

const AGENT_NAME: Record<AgentId, string> = { claude: "Claude", codex: "Codex" };
const MESSAGE_KEY = {
  work: "notify.work",
  reply: "notify.reply",
  failed: "notify.failed",
  interrupted: "notify.interrupted",
  question: "notify.question",
  limitHold: "notify.limitHold",
  error: "notify.error",
} as const;

export function formatNotification(input: NotificationInput, messages: Messages): HubNotification {
  const project =
    input.projectRoot
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) ?? input.projectRoot;
  const conversation = input.conversationTitle || messages["web.conv.untitled"];
  const line = input.line?.split(/\r?\n/, 1)[0] ?? "";
  const template = input.kind === "notice" ? line : messages[MESSAGE_KEY[input.kind]];
  const content = template.replace("{time}", input.time ?? "").replace("{line}", line);
  const suffix = input.agent ? messages["notify.agent"].replace("{agent}", AGENT_NAME[input.agent]) : "";
  return {
    kind: input.kind,
    project,
    conversation,
    ...(input.agent ? { agent: input.agent } : {}),
    title: `Clodex【${project}】「${conversation}」`,
    body: `${content}${suffix}`,
  };
}

export const shouldPushNotification = (kind: NotificationKind): boolean =>
  kind === "work" || kind === "reply" || kind === "failed" || kind === "interrupted" || kind === "question";
