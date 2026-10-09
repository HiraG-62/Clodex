import type { AgentId } from "../agents/agent-adapter.js";

const SOLO_RELEASED_NOTE = "[Clodex] Solo mode is off. Delegate to the other agent with send_message as your role says, and reply to requests with send_message.";
const HUMAN_CONTEXT_LIMIT = 5;
const HUMAN_CONTEXT_LENGTH = 300;
export const OTHER_AGENT: Record<AgentId, AgentId> = { claude: "codex", codex: "claude" };

export class DeliveryNotes {
  private readonly humanContext: Record<AgentId, { entries: Array<{ to: AgentId; text: string }>; extra: number }> = {
    claude: { entries: [], extra: 0 }, codex: { entries: [], extra: 0 },
  };
  private readonly pendingNotices: Record<AgentId, string[]> = { claude: [], codex: [] };
  private readonly holdContext: Partial<Record<AgentId, { peerFiles: Set<string> }>> = {};

  constructor(private readonly soloReleased?: (agent: AgentId) => boolean,
    private readonly consumeSoloReleased?: (agent: AgentId) => boolean) {}

  take(id: AgentId): string {
    const note = this.peek(id);
    this.consume(id);
    return note;
  }

  peek(id: AgentId): string {
    const human = this.humanContext[id];
    const humanNote = human.entries.length
      ? `\n\n[Clodex] Since your last turn, the human said to ${human.entries[0]!.to}:\n${human.entries.map((item) => `- ${this.previewHuman(item.text)}`).join("\n")}${human.extra ? `\n- (+${human.extra} more)` : ""}`
      : "";
    const notices = this.pendingNotices[id].map((notice) => `\n\n${notice}`).join("");
    const edited = [...(this.holdContext[id]?.peerFiles ?? [])];
    const holdNote = edited.length ? `\n\nWhile you were stopped, ${OTHER_AGENT[id]} edited: ${edited.join(", ")}. Check them before continuing.` : "";
    const soloNote = this.soloReleased?.(id) ? `\n\n${SOLO_RELEASED_NOTE}` : "";
    return `${soloNote}${humanNote}${notices}${holdNote}`;
  }

  consume(id: AgentId): void {
    if (this.soloReleased?.(id)) this.consumeSoloReleased?.(id);
    this.humanContext[id] = { entries: [], extra: 0 };
    this.pendingNotices[id] = [];
    this.clearHold(id);
  }

  previewHuman(text: string): string {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > HUMAN_CONTEXT_LENGTH ? `${line.slice(0, HUMAN_CONTEXT_LENGTH)}…` : line;
  }

  queueHumanContext(to: AgentId, text: string): void {
    const queue = this.humanContext[OTHER_AGENT[to]];
    if (queue.entries.length < HUMAN_CONTEXT_LIMIT) queue.entries.push({ to, text });
    else queue.extra++;
  }

  queueNotice(id: AgentId, notice: string): void { this.pendingNotices[id].push(notice); }
  beginHold(id: AgentId): void { this.holdContext[id] = { peerFiles: new Set() }; }
  clearHold(id: AgentId): void { delete this.holdContext[id]; }
  recordPeerFiles(id: AgentId, files: readonly string[]): void {
    for (const file of files) this.holdContext[id]?.peerFiles.add(file);
  }
}
