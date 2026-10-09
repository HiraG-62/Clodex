import type { ConversationActivity } from "./workspace.js";

export interface TabConversation {
  id: string;
  title?: string;
  pinned?: boolean;
  activity?: ConversationActivity;
}

export interface ConversationTab {
  projectRoot: string;
  conversationId: string;
  title: string;
  pinned: boolean;
  current: boolean;
  activity?: ConversationActivity;
}

export interface TabProject {
  projectRoot: string;
  conversations: readonly TabConversation[];
}

export function buildTabs(projects: readonly TabProject[], current?: { projectRoot: string; conversation: TabConversation }): ConversationTab[] {
  const tab = (projectRoot: string, conversation: TabConversation): ConversationTab => ({
    projectRoot,
    conversationId: conversation.id,
    title: conversation.title ?? "",
    pinned: Boolean(conversation.pinned),
    current: current?.projectRoot === projectRoot && current.conversation.id === conversation.id,
    ...(conversation.activity ? { activity: conversation.activity } : {}),
  });
  const pinned = projects.flatMap(({ projectRoot, conversations }) =>
    conversations.filter(conversation => conversation.pinned).map(conversation => tab(projectRoot, conversation)),
  );
  if (!current || pinned.some(entry => entry.current)) return pinned;
  return [...pinned, tab(current.projectRoot, current.conversation)];
}
