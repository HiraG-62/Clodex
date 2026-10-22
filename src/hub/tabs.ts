import type { ConversationActivity } from "./workspace.js";

export interface TabConversation {
  id: string;
  title?: string;
  mode?: "brainstorm";
  tabbed?: boolean;
  activity?: ConversationActivity;
  parent?: { conversationId: string };
}

export interface ConversationTab {
  projectRoot: string;
  conversationId: string;
  title: string;
  mode?: "brainstorm";
  tabbed: boolean;
  current: boolean;
  activity?: ConversationActivity;
  parentTitle?: string;
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
    ...(conversation.mode ? { mode: conversation.mode } : {}),
    tabbed: Boolean(conversation.tabbed),
    current: current?.projectRoot === projectRoot && current.conversation.id === conversation.id,
    ...(conversation.activity ? { activity: conversation.activity } : {}),
    ...(conversation.parent
      ? {
          parentTitle:
            projects.find(project => project.projectRoot === projectRoot)?.conversations.find(entry => entry.id === conversation.parent?.conversationId)
              ?.title ?? "",
        }
      : {}),
  });
  const tabbed = projects.flatMap(({ projectRoot, conversations }) =>
    conversations.filter(conversation => conversation.tabbed && !conversation.parent).map(conversation => tab(projectRoot, conversation)),
  );
  if (!current || tabbed.some(entry => entry.current)) return tabbed;
  return [...tabbed, tab(current.projectRoot, current.conversation)];
}
