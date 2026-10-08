import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { AgentId } from "../agents/agent-adapter.js";
import type { CoordinatorEvent } from "../coordinator/event-bus.js";
import type { HistoryItem } from "../web/web-feed.js";

const TRANSCRIPT_EXT = ".jsonl";
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export type ConversationParticipant = AgentId | "human";
export interface ConversationEntry {
  at: string;
  kind: "input" | "reply" | "message" | "question" | "answer";
  from: ConversationParticipant;
  to?: ConversationParticipant;
  body: string;
}
export interface ConversationPage {
  entries: ConversationEntry[];
  nextBefore?: number;
}
export interface ReadConversationOptions {
  before?: number;
  limit?: number;
}

export const transcriptPath = (statePath: string, conversationId: string): string =>
  join(dirname(statePath), `${basename(statePath, extname(statePath))}.transcript`, `${conversationId}${TRANSCRIPT_EXT}`);

const entryOf = (event: CoordinatorEvent): ConversationEntry | undefined => {
  const { at } = event;
  switch (event.kind) {
    case "human":
      return event.text.trim() ? { at, kind: "input", from: "human", to: event.agent, body: event.text } : undefined;
    case "agent":
      return event.event.type === "turn" && event.event.result.status === "completed" && event.event.result.text.trim()
        ? { at, kind: "reply", from: event.agent, body: event.event.result.text }
        : undefined;
    case "message":
      return event.message.body.trim()
        ? { at, kind: "message", from: event.message.from, to: event.message.to, body: event.message.body }
        : undefined;
    case "question": {
      const body = event.questions.map(({ question }) => question).join("\n");
      return body.trim() ? { at, kind: "question", from: event.agent, to: "human", body } : undefined;
    }
    case "answer": {
      const body = event.answers.map((answers) => answers.join(", ")).join("\n");
      return body.trim() ? { at, kind: "answer", from: "human", to: event.agent, body } : undefined;
    }
    case "notice":
      return undefined;
  }
};

const linesOf = (entries: readonly ConversationEntry[]): string => entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");

export class ConversationTranscript {
  constructor(readonly filePath: string) {}

  seed(history: readonly HistoryItem[]): void {
    if (existsSync(this.filePath)) return;
    const entries = history.flatMap((item) => {
      if (item.type !== "event") return [];
      const entry = entryOf(item.event);
      return entry ? [entry] : [];
    });
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, linesOf(entries));
  }

  append(event: CoordinatorEvent): void {
    const entry = entryOf(event);
    if (!entry) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, linesOf([entry]));
  }

  page({ before, limit = DEFAULT_PAGE_SIZE }: ReadConversationOptions = {}): ConversationPage {
    if (!existsSync(this.filePath)) return { entries: [] };
    const entries = readFileSync(this.filePath, "utf8").split("\n").flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line) as ConversationEntry];
      } catch {
        return [];
      }
    });
    const end = before === undefined ? entries.length : Math.max(0, Math.min(entries.length, Math.floor(before)));
    const size = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(limit))) : DEFAULT_PAGE_SIZE;
    const start = Math.max(0, end - size);
    return { entries: entries.slice(start, end), ...(start > 0 ? { nextBefore: start } : {}) };
  }
}
