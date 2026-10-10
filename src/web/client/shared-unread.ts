import type { Artifact } from "./artifacts.js";

export function hasNewShared(artifacts: readonly Artifact[], lastOpened: string | null): boolean {
  return artifacts.some(artifact => artifact.group === "presented" && (!lastOpened || artifact.at > lastOpened));
}

export function sharedOpenedKey(projectRoot: string, conversationId: string): string {
  return `clodex-shared-opened:${encodeURIComponent(projectRoot)}:${conversationId}`;
}
