const DRAFT_PREFIX = "clodex.draft:";
const ATTACHMENT_SUFFIX = ":attachments";

export function draftKey(projectRoot: string, conversationId: string): string {
  return `${DRAFT_PREFIX}${encodeURIComponent(projectRoot)}:${encodeURIComponent(conversationId)}`;
}

export function staleDraftKeys(keys: readonly string[], projectRoot: string, conversationIds: readonly string[]): string[] {
  const prefix = `${DRAFT_PREFIX}${encodeURIComponent(projectRoot)}:`;
  const current = new Set(
    conversationIds.flatMap(id => {
      const key = draftKey(projectRoot, id);
      return [key, attachmentDraftKey(key)];
    }),
  );
  return keys.filter(key => key.startsWith(prefix) && !current.has(key));
}

export function attachmentDraftKey(key: string): string {
  return `${key}${ATTACHMENT_SUFFIX}`;
}

export function readAttachmentDraft(storage: { get: (key: string) => string | null }, key: string): string[] {
  try {
    const value: unknown = JSON.parse(storage.get(attachmentDraftKey(key)) ?? "[]");
    return Array.isArray(value) && value.every((path): path is string => typeof path === "string") ? value : [];
  } catch {
    return [];
  }
}

export function saveAttachmentDraft(
  storage: { set: (key: string, value: string) => void; remove: (key: string) => void },
  key: string,
  paths: readonly string[],
): void {
  if (paths.length) storage.set(attachmentDraftKey(key), JSON.stringify(paths));
  else storage.remove(attachmentDraftKey(key));
}
