export function draftKey(projectRoot: string, conversationId: string): string {
  const DRAFT_PREFIX = "clodex.draft:";
  return `${DRAFT_PREFIX}${encodeURIComponent(projectRoot)}:${encodeURIComponent(conversationId)}`;
}

export function staleDraftKeys(keys: readonly string[], projectRoot: string, conversationIds: readonly string[]): string[] {
  const DRAFT_PREFIX = "clodex.draft:";
  const prefix = `${DRAFT_PREFIX}${encodeURIComponent(projectRoot)}:`;
  const current = new Set(conversationIds.map(id => `${prefix}${encodeURIComponent(id)}`));
  return keys.filter(key => key.startsWith(prefix) && !current.has(key));
}
